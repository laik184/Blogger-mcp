import express from 'express';
import { createHash } from 'node:crypto';
import { OAuthError, OAuthErrorCode } from '@modelcontextprotocol/server';
import { mcpAuthMetadataRouter } from '@modelcontextprotocol/express';
import { createGoogleOAuth, listBlogsWithAccessToken, refreshGoogleCredentials, upsertGoogleConnection, verifyGoogleIdentity } from './google.js';
import { getGoogleConnection, setSetting, getSetting, writeAudit } from './db.js';
import { decryptText, randomToken, safeEqual, sha256 } from './crypto.js';

const SCOPES = ['blogger.read', 'blogger.write', 'offline_access'];
const GOOGLE_IDENTITY_SCOPES = ['openid', 'email', 'profile'];
const GOOGLE_SETUP_SCOPES = [...GOOGLE_IDENTITY_SCOPES, 'https://www.googleapis.com/auth/blogger'];
const AUTH_CODE_TTL_SECONDS = 300;
const ACCESS_TOKEN_TTL_SECONDS = 3600;
const REFRESH_TOKEN_TTL_SECONDS = 90 * 24 * 60 * 60;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

function htmlPage(title, body, status = 200) {
  return { status, html: `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><body><main><h1>${escapeHtml(title)}</h1>${body}</main></body></html>` };
}

function sendPage(res, page) {
  res.status(page.status).type('html').send(page.html);
}

function setBrowserCookie(res, name, value, config) {
  res.cookie(name, value, { httpOnly: true, secure: config.production, sameSite: 'lax', maxAge: 10 * 60 * 1000, path: '/' });
}

function clearBrowserCookie(res, name, config) {
  res.clearCookie(name, { httpOnly: true, secure: config.production, sameSite: 'lax', path: '/' });
}

function readOne(value) {
  return Array.isArray(value) ? value[0] : value;
}

function safeRedirect(target) {
  return new URL(target);
}

function cleanupExpired(db) {
  const now = Math.floor(Date.now() / 1000);
  db.prepare('DELETE FROM auth_flows WHERE expires_at < ?').run(now);
  db.prepare('DELETE FROM oauth_codes WHERE expires_at < ?').run(now);
  db.prepare('DELETE FROM oauth_access_tokens WHERE expires_at < ?').run(now);
  db.prepare('DELETE FROM oauth_refresh_tokens WHERE expires_at < ?').run(now);
}

function allowedScopes(scopeText) {
  const scopes = [...new Set((scopeText || '').split(/\s+/).filter(Boolean))];
  if (!scopes.length) return SCOPES;
  if (scopes.some(scope => !SCOPES.includes(scope))) return null;
  return scopes;
}

function authRequestFromQuery(query, client, config) {
  const clientId = readOne(query.client_id);
  const redirectUri = readOne(query.redirect_uri);
  const responseType = readOne(query.response_type);
  const state = readOne(query.state);
  const challenge = readOne(query.code_challenge);
  const challengeMethod = readOne(query.code_challenge_method);
  const resource = readOne(query.resource) || config.resource;
  const scopes = allowedScopes(readOne(query.scope));
  if (!client || client.client_id !== clientId) throw new Error('Unknown OAuth client.');
  if (responseType !== 'code' || !state || state.length > 1024) throw new Error('Invalid authorization request.');
  const registeredRedirects = JSON.parse(client.redirect_uris_json);
  if (!registeredRedirects.includes(redirectUri) || !config.allowedChatGptRedirectUris.has(redirectUri)) {
    throw new Error('The OAuth redirect URL is not allowed.');
  }
  if (!challenge || challengeMethod !== 'S256' || !/^[A-Za-z0-9_-]{43,128}$/.test(challenge)) {
    throw new Error('OAuth authorization requires PKCE with S256.');
  }
  if (resource !== config.resource) throw new Error('Invalid resource parameter.');
  if (!scopes) throw new Error('One or more requested scopes are not supported.');
  return { clientId, redirectUri, state, challenge, scope: scopes.join(' '), resource };
}

function createGoogleFlow(db, config, res, purpose, request) {
  const oauth = createGoogleOAuth(config);
  const state = randomToken(32);
  const browser = randomToken(32);
  const isSetupFlow = purpose !== 'login';
  const cookie = isSetupFlow ? 'bap_setup_browser' : 'bap_login_browser';
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`INSERT INTO auth_flows(state_hash,browser_hash,purpose,request_json,expires_at)
    VALUES(?,?,?,?,?)`).run(sha256(state), sha256(browser), purpose, request ? JSON.stringify(request) : null, now + 600);
  setBrowserCookie(res, cookie, browser, config);
  const scope = isSetupFlow ? GOOGLE_SETUP_SCOPES : GOOGLE_IDENTITY_SCOPES;
  const url = oauth.generateAuthUrl({
    access_type: isSetupFlow ? 'offline' : 'online',
    include_granted_scopes: true,
    prompt: isSetupFlow ? 'consent' : 'select_account',
    response_type: 'code',
    scope,
    state,
  });
  return url;
}

function appendAuthorizationCode(db, config, request, googleSub, res) {
  const code = randomToken(32);
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`INSERT INTO oauth_codes(code_hash,client_id,redirect_uri,google_sub,scope,code_challenge,resource,expires_at)
    VALUES(?,?,?,?,?,?,?,?)`).run(sha256(code), request.clientId, request.redirectUri, googleSub,
    request.scope, request.challenge, request.resource, now + AUTH_CODE_TTL_SECONDS);
  const redirect = safeRedirect(request.redirectUri);
  redirect.searchParams.set('code', code);
  redirect.searchParams.set('state', request.state);
  redirect.searchParams.set('iss', config.issuer);
  res.redirect(302, redirect.toString());
}

function createClientRegistration(req, res, db, config) {
  const payload = req.body || {};
  const redirectUris = payload.redirect_uris;
  const grantTypes = payload.grant_types || ['authorization_code'];
  const responseTypes = payload.response_types || ['code'];
  const authMethod = payload.token_endpoint_auth_method || 'none';
  if (!Array.isArray(redirectUris) || redirectUris.length < 1 || redirectUris.length > 5 ||
      redirectUris.some(uri => typeof uri !== 'string' || !config.allowedChatGptRedirectUris.has(uri))) {
    return res.status(400).json({ error: 'invalid_redirect_uri', error_description: 'Only the exact ChatGPT redirect URL configured on this server is accepted.' });
  }
  if (authMethod !== 'none' || !Array.isArray(responseTypes) || !responseTypes.includes('code') ||
      !Array.isArray(grantTypes) || grantTypes.some(type => !['authorization_code', 'refresh_token'].includes(type))) {
    return res.status(400).json({ error: 'invalid_client_metadata', error_description: 'This server supports public authorization-code clients using PKCE and refresh tokens only.' });
  }
  const clientId = `bap_${randomToken(24)}`;
  const clientName = String(payload.client_name || 'ChatGPT custom connector').slice(0, 120);
  db.prepare('INSERT INTO oauth_clients(client_id,client_name,redirect_uris_json,created_at) VALUES(?,?,?,?)')
    .run(clientId, clientName, JSON.stringify(redirectUris), new Date().toISOString());
  writeAudit(db, { event: 'oauth_client_registered', status: 'ok' });
  return res.status(201).json({
    client_id: clientId,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_name: clientName,
    redirect_uris: redirectUris,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  });
}

function issueTokens(db, grant) {
  const clientId = grant.clientId ?? grant.client_id;
  const googleSub = grant.googleSub ?? grant.google_sub;
  const scope = grant.scope;
  const resource = grant.resource;
  const accessToken = randomToken(32);
  const refreshToken = randomToken(48);
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + ACCESS_TOKEN_TTL_SECONDS;
  const refreshExpiresAt = now + REFRESH_TOKEN_TTL_SECONDS;
  const insert = db.transaction(() => {
    db.prepare(`INSERT INTO oauth_access_tokens(token_hash,client_id,google_sub,scope,resource,expires_at,created_at)
      VALUES(?,?,?,?,?,?,?)`).run(sha256(accessToken), clientId, googleSub, scope, resource, expiresAt, new Date().toISOString());
    db.prepare(`INSERT INTO oauth_refresh_tokens(token_hash,client_id,google_sub,scope,resource,expires_at,created_at)
      VALUES(?,?,?,?,?,?,?)`).run(sha256(refreshToken), clientId, googleSub, scope, resource, refreshExpiresAt, new Date().toISOString());
  });
  insert();
  return { accessToken, refreshToken, expiresIn: ACCESS_TOKEN_TTL_SECONDS, scope };
}

function tokenResponse(res, tokens) {
  res.set('Cache-Control', 'no-store').set('Pragma', 'no-cache');
  return res.json({
    access_token: tokens.accessToken,
    token_type: 'Bearer',
    expires_in: tokens.expiresIn,
    refresh_token: tokens.refreshToken,
    scope: tokens.scope,
  });
}

function tokenError(res, code = 'invalid_grant', description = 'The OAuth grant is invalid or expired.') {
  res.set('Cache-Control', 'no-store').set('Pragma', 'no-cache');
  return res.status(400).json({ error: code, error_description: description });
}

export function createOAuthMetadata(config) {
  return {
    issuer: config.issuer,
    authorization_endpoint: `${config.issuer}/oauth/authorize`,
    token_endpoint: `${config.issuer}/oauth/token`,
    registration_endpoint: `${config.issuer}/oauth/register`,
    revocation_endpoint: `${config.issuer}/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none'],
    code_challenge_methods_supported: ['S256'],
    scopes_supported: SCOPES,
    authorization_response_iss_parameter_supported: true,
    client_id_metadata_document_supported: false,
  };
}

export function createTokenVerifier(db, config) {
  return {
    async verifyAccessToken(token) {
      const row = db.prepare('SELECT * FROM oauth_access_tokens WHERE token_hash=?').get(sha256(token));
      const now = Math.floor(Date.now() / 1000);
      if (!row || row.expires_at <= now || row.resource !== config.resource) {
        throw new OAuthError(OAuthErrorCode.InvalidToken, 'Access token is invalid or expired.');
      }
      const connection = getGoogleConnection(db);
      if (!connection?.setup_complete || connection.google_sub !== row.google_sub || !connection.blog_id) {
        throw new OAuthError(OAuthErrorCode.InvalidToken, 'The Blogger account binding is no longer valid.');
      }
      return {
        token,
        clientId: row.client_id,
        scopes: row.scope.split(' ').filter(Boolean),
        expiresAt: row.expires_at,
        resource: new URL(row.resource),
        extra: { googleSub: row.google_sub, blogId: connection.blog_id },
      };
    },
  };
}

export function createOAuthRouter(db, config) {
  const router = express.Router();
  const oauth = createGoogleOAuth(config);
  const metadata = createOAuthMetadata(config);
  router.use(mcpAuthMetadataRouter({
    oauthMetadata: metadata,
    resourceServerUrl: new URL(config.resource),
    scopesSupported: SCOPES,
    resourceName: 'Blogger AI Publisher',
  }));

  router.get('/setup', (_req, res) => {
    const connection = getGoogleConnection(db);
    if (connection?.setup_complete) {
      return sendPage(res, htmlPage('Blogger AI Publisher setup is complete',
        `<p>Connected Google account: <strong>${escapeHtml(connection.email)}</strong></p><p>Authorized blog: <strong>${escapeHtml(connection.blog_name)}</strong></p><p>Blog ID: <code>${escapeHtml(connection.blog_id)}</code></p><p>The account and blog are fixed for this private installation.</p><form method="post" action="/setup/reconnect"><label>Setup code <input name="setup_code" type="password" required autocomplete="current-password"></label><button type="submit">Reconnect this Google account</button></form>`));
    }
    const body = `<p>Connect one Google account and choose one Blogger blog. The refresh token stays encrypted on this server.</p><form method="post" action="/setup/start"><label>Setup code <input name="setup_code" type="password" required autocomplete="current-password"></label><button type="submit">Continue to Google</button></form>`;
    return sendPage(res, htmlPage('Connect Blogger', body));
  });

  router.post('/setup/start', (req, res) => {
    cleanupExpired(db);
    if (getGoogleConnection(db)?.setup_complete) return sendPage(res, htmlPage('Setup already completed', '<p>This server is already bound to one Google account and one blog.</p>', 409));
    const supplied = sha256(String(req.body?.setup_code || ''));
    if (!safeEqual(supplied, sha256(config.setupAdminSecret))) return sendPage(res, htmlPage('Invalid setup code', '<p>The setup code was not accepted.</p>', 401));
    const url = createGoogleFlow(db, config, res, 'setup', null);
    return res.redirect(302, url);
  });

  router.post('/setup/reconnect', (req, res) => {
    cleanupExpired(db);
    if (!getGoogleConnection(db)?.setup_complete) {
      return sendPage(res, htmlPage('Complete initial setup first', '<p>Use the setup form to connect a Google account and select one blog.</p>', 409));
    }
    const supplied = sha256(String(req.body?.setup_code || ''));
    if (!safeEqual(supplied, sha256(config.setupAdminSecret))) return sendPage(res, htmlPage('Invalid setup code', '<p>The setup code was not accepted.</p>', 401));
    const url = createGoogleFlow(db, config, res, 'reconnect', null);
    return res.redirect(302, url);
  });

  router.post('/setup/select-blog', async (req, res) => {
    try {
      const connection = getGoogleConnection(db);
      const browser = req.cookies?.bap_setup_browser;
      const savedCsrfHash = getSetting(db, 'setup_csrf_hash');
      if (!connection || connection.setup_complete || !browser || !savedCsrfHash ||
          !safeEqual(sha256(String(req.body?.csrf || '')), savedCsrfHash) ||
          !safeEqual(sha256(browser), getSetting(db, 'setup_browser_hash') || '')) {
        return sendPage(res, htmlPage('Setup session expired', '<p>Restart Blogger setup and try again.</p>', 400));
      }
      const accessToken = connection.access_token_enc ? decryptText(connection.access_token_enc, config.encryptionKey) : null;
      if (!accessToken) return sendPage(res, htmlPage('Google session unavailable', '<p>Reconnect Google and try again.</p>', 400));
      const blogs = await listBlogsWithAccessToken(accessToken);
      const selected = blogs.find(blog => blog.id === String(req.body?.blog_id || ''));
      if (!selected) return sendPage(res, htmlPage('Blog not found', '<p>Choose a blog returned by Blogger.</p>', 400));
      db.prepare(`UPDATE google_connection SET blog_id=?,blog_name=?,blog_url=?,setup_complete=1 WHERE singleton=1`)
        .run(selected.id, selected.name, selected.url);
      db.prepare('DELETE FROM settings WHERE key IN (?,?)').run('setup_csrf_hash', 'setup_browser_hash');
      clearBrowserCookie(res, 'bap_setup_browser', config);
      writeAudit(db, { event: 'google_account_bound', status: 'ok', blogId: selected.id });
      return sendPage(res, htmlPage('Blogger connected',
        `<p>Google account <strong>${escapeHtml(connection.email)}</strong> is now bound to <strong>${escapeHtml(selected.name)}</strong>.</p><p>Blog ID: <code>${escapeHtml(selected.id)}</code></p><p>Draft creation is available after the server is connected to ChatGPT. Public publishing is disabled by default.</p>`));
    } catch (error) {
      writeAudit(db, { event: 'google_blog_selection', status: 'error', detail: error.message });
      return sendPage(res, htmlPage('Could not connect Blogger', '<p>Check server logs for the safe error reference, then retry setup.</p>', 500));
    }
  });

  router.get('/oauth/authorize', (req, res) => {
    cleanupExpired(db);
    try {
      const client = db.prepare('SELECT * FROM oauth_clients WHERE client_id=?').get(readOne(req.query.client_id));
      const request = authRequestFromQuery(req.query, client, config);
      const connection = getGoogleConnection(db);
      if (!connection?.setup_complete || !connection.blog_id) {
        return sendPage(res, htmlPage('Complete Blogger setup first', '<p>Open the server’s /setup page, connect Google, and select the allowed blog before connecting this MCP server in ChatGPT.</p>', 409));
      }
      return res.redirect(302, createGoogleFlow(db, config, res, 'login', request));
    } catch (error) {
      writeAudit(db, { event: 'oauth_authorize', status: 'error', detail: error.message });
      return sendPage(res, htmlPage('Could not authorize this connection', `<p>${escapeHtml(error.message)}</p>`, 400));
    }
  });

  router.get('/oauth/google/callback', async (req, res) => {
    cleanupExpired(db);
    const state = readOne(req.query.state);
    const code = readOne(req.query.code);
    if (req.query.error) return sendPage(res, htmlPage('Google authorization cancelled', '<p>Return to ChatGPT or the setup page and try again.</p>', 400));
    const flow = state ? db.prepare('SELECT * FROM auth_flows WHERE state_hash=?').get(sha256(state)) : null;
    if (!flow) return sendPage(res, htmlPage('Authorization request expired', '<p>Restart the connection flow.</p>', 400));
    const cookieName = flow.purpose === 'setup' ? 'bap_setup_browser' : 'bap_login_browser';
    const browser = req.cookies?.[cookieName];
    if (!browser || !safeEqual(sha256(browser), flow.browser_hash) || flow.expires_at < Math.floor(Date.now() / 1000)) {
      db.prepare('DELETE FROM auth_flows WHERE state_hash=?').run(sha256(state));
      return sendPage(res, htmlPage('Authorization session expired', '<p>Restart the connection flow in the same browser.</p>', 400));
    }
    db.prepare('DELETE FROM auth_flows WHERE state_hash=?').run(sha256(state));
    try {
      if (!code) throw new Error('Google did not return an authorization code.');
      const { tokens } = await oauth.getToken(code);
      if (!tokens.id_token) throw new Error('Google did not return an identity token. Check the configured OAuth scopes.');
      const identity = await verifyGoogleIdentity(config, tokens.id_token);
      if (flow.purpose === 'setup') {
        if (getGoogleConnection(db)?.setup_complete) throw new Error('This server has already been configured.');
        const blogs = await listBlogsWithAccessToken(tokens.access_token);
        if (!blogs.length) throw new Error('This Google account has no Blogger blogs available through the Blogger API.');
        upsertGoogleConnection(db, config, identity, tokens);
        const csrf = randomToken(32);
        setSetting(db, 'setup_csrf_hash', sha256(csrf));
        setSetting(db, 'setup_browser_hash', flow.browser_hash);
        const options = blogs.map(blog => `<option value="${escapeHtml(blog.id)}">${escapeHtml(blog.name)} — ${escapeHtml(blog.url)}</option>`).join('');
        const body = `<p>Google account: <strong>${escapeHtml(identity.email)}</strong></p><p>Select the single blog this MCP server may access. This choice is enforced on every tool call.</p><form method="post" action="/setup/select-blog"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><label>Blogger blog <select name="blog_id" required>${options}</select></label><button type="submit">Bind this blog</button></form>`;
        return sendPage(res, htmlPage('Select the authorized Blogger blog', body));
      }

      if (flow.purpose === 'reconnect') {
        const connection = getGoogleConnection(db);
        if (!connection?.setup_complete || identity.googleSub !== connection.google_sub) {
          throw new Error('Reconnect using the same Google account already bound to this Blogger server.');
        }
        const blogs = await listBlogsWithAccessToken(tokens.access_token);
        const boundBlog = blogs.find(blog => blog.id === String(connection.blog_id));
        if (!boundBlog) throw new Error('The bound blog is not available to this Google account. The account and Blog ID were left unchanged.');
        refreshGoogleCredentials(db, config, tokens);
        clearBrowserCookie(res, cookieName, config);
        writeAudit(db, { event: 'google_account_reconnected', status: 'ok', blogId: connection.blog_id });
        return sendPage(res, htmlPage('Blogger reconnected', `<p>Google access was refreshed for <strong>${escapeHtml(connection.email)}</strong> and the existing Blog ID <code>${escapeHtml(connection.blog_id)}</code>.</p>`));
      }

      const connection = getGoogleConnection(db);
      if (!connection?.setup_complete || identity.googleSub !== connection.google_sub) {
        throw new Error('This Google account is not the one authorized for this private Blogger server.');
      }
      const request = JSON.parse(flow.request_json || '{}');
      if (!request.clientId || !request.redirectUri || !request.challenge) throw new Error('Stored OAuth request is invalid.');
      clearBrowserCookie(res, cookieName, config);
      writeAudit(db, { event: 'oauth_user_authorized', status: 'ok', blogId: connection.blog_id });
      return appendAuthorizationCode(db, config, request, identity.googleSub, res);
    } catch (error) {
      writeAudit(db, { event: 'google_oauth_callback', status: 'error', detail: error.message });
      return sendPage(res, htmlPage('Google authorization failed', `<p>${escapeHtml(error.message)}</p>`, 400));
    }
  });

  router.post('/oauth/register', (req, res) => createClientRegistration(req, res, db, config));

  router.post('/oauth/token', (req, res) => {
    cleanupExpired(db);
    const { grant_type: grantType, client_id: clientId, resource } = req.body || {};
    const client = db.prepare('SELECT * FROM oauth_clients WHERE client_id=?').get(clientId);
    if (!client || resource !== config.resource) return tokenError(res, 'invalid_client', 'The client or resource is invalid.');
    const now = Math.floor(Date.now() / 1000);
    if (grantType === 'authorization_code') {
      const code = String(req.body.code || '');
      const redirectUri = String(req.body.redirect_uri || '');
      const verifier = String(req.body.code_verifier || '');
      if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return tokenError(res);
      const row = db.prepare('SELECT * FROM oauth_codes WHERE code_hash=?').get(sha256(code));
      if (!row || row.expires_at <= now || row.client_id !== clientId || row.redirect_uri !== redirectUri || row.resource !== resource) return tokenError(res);
      const expectedChallenge = createHash('sha256').update(verifier).digest('base64url');
      if (!safeEqual(expectedChallenge, row.code_challenge)) return tokenError(res);
      db.prepare('DELETE FROM oauth_codes WHERE code_hash=?').run(sha256(code));
      const tokens = issueTokens(db, row);
      writeAudit(db, { event: 'oauth_code_exchanged', status: 'ok' });
      return tokenResponse(res, tokens);
    }

    if (grantType === 'refresh_token') {
      const refresh = String(req.body.refresh_token || '');
      const hash = sha256(refresh);
      const row = db.prepare('SELECT * FROM oauth_refresh_tokens WHERE token_hash=?').get(hash);
      if (!row || row.expires_at <= now || row.client_id !== clientId || row.resource !== resource) return tokenError(res);
      const rotate = db.transaction(() => {
        db.prepare('DELETE FROM oauth_refresh_tokens WHERE token_hash=?').run(hash);
        return issueTokens(db, row);
      });
      try {
        const tokens = rotate();
        writeAudit(db, { event: 'oauth_refresh', status: 'ok' });
        return tokenResponse(res, tokens);
      } catch {
        return tokenError(res);
      }
    }
    return tokenError(res, 'unsupported_grant_type', 'Only authorization_code and refresh_token are supported.');
  });

  router.post('/oauth/revoke', (req, res) => {
    const clientId = String(req.body.client_id || '');
    const tokenHash = sha256(String(req.body.token || ''));
    db.prepare('DELETE FROM oauth_access_tokens WHERE token_hash=? AND client_id=?').run(tokenHash, clientId);
    db.prepare('DELETE FROM oauth_refresh_tokens WHERE token_hash=? AND client_id=?').run(tokenHash, clientId);
    return res.status(200).end();
  });

  return router;
}

export function requireGoogleSub(context) {
  return context?.http?.authInfo?.extra?.googleSub || null;
}

export function requireScope(context, scope, config) {
  const auth = context?.http?.authInfo;
  if (!auth || !auth.scopes.includes(scope)) {
    const challenge = `Bearer resource_metadata="${config.protectedResourceMetadataUrl}", error="insufficient_scope", error_description="Missing required scope: ${scope}"`;
    return {
      content: [{ type: 'text', text: `Authorization required for ${scope}.` }],
      _meta: { 'mcp/www_authenticate': [challenge] },
      isError: true,
    };
  }
  return null;
}
