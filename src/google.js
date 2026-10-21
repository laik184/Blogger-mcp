import { OAuth2Client } from 'google-auth-library';
import { decryptText, encryptText } from './crypto.js';
import { getGoogleConnection, writeAudit } from './db.js';

const BLOGGER_API = 'https://www.googleapis.com/blogger/v3';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

export function createGoogleOAuth(config) {
  return new OAuth2Client(config.googleClientId, config.googleClientSecret, config.googleRedirectUri);
}

export async function verifyGoogleIdentity(config, idToken) {
  const client = createGoogleOAuth(config);
  const ticket = await client.verifyIdToken({ idToken, audience: config.googleClientId });
  const claims = ticket.getPayload();
  if (!claims?.sub || !claims.email || claims.email_verified !== true) {
    throw new Error('Google returned an incomplete or unverified account identity.');
  }
  return {
    googleSub: claims.sub,
    email: claims.email.toLowerCase(),
    displayName: claims.name || claims.email,
  };
}

export async function listBlogsWithAccessToken(accessToken) {
  const response = await fetch(`${BLOGGER_API}/users/self/blogs`, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(15000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new GoogleApiError(response.status, data?.error?.message || 'Blogger API request failed.');
  return (data.items || []).map(blog => ({ id: String(blog.id), name: blog.name || blog.title || 'Untitled blog', url: blog.url || '' }));
}

export function upsertGoogleConnection(db, config, identity, credentials) {
  if (!credentials.refresh_token) {
    throw new Error('Google did not issue a refresh token. Revoke this app in Google Account security, then repeat setup and approve offline access.');
  }
  const statement = db.prepare(`INSERT INTO google_connection
    (singleton,google_sub,email,display_name,refresh_token_enc,access_token_enc,token_expiry,connected_at,setup_complete)
    VALUES(1,@googleSub,@email,@displayName,@refreshTokenEnc,@accessTokenEnc,@tokenExpiry,@connectedAt,0)
    ON CONFLICT(singleton) DO UPDATE SET
      google_sub=excluded.google_sub,email=excluded.email,display_name=excluded.display_name,
      refresh_token_enc=excluded.refresh_token_enc,access_token_enc=excluded.access_token_enc,
      token_expiry=excluded.token_expiry,connected_at=excluded.connected_at,setup_complete=0,
      blog_id=NULL,blog_name=NULL,blog_url=NULL`);
  statement.run({
    ...identity,
    refreshTokenEnc: encryptText(credentials.refresh_token, config.encryptionKey),
    accessTokenEnc: credentials.access_token ? encryptText(credentials.access_token, config.encryptionKey) : null,
    tokenExpiry: credentials.expiry_date || null,
    connectedAt: new Date().toISOString(),
  });
}

export function refreshGoogleCredentials(db, config, credentials) {
  const connection = getGoogleConnection(db);
  if (!connection?.setup_complete || !connection.blog_id) {
    throw new Error('The Blogger connection is not set up yet.');
  }
  if (!credentials.access_token) throw new Error('Google did not return an access token.');
  db.prepare(`UPDATE google_connection SET access_token_enc=?, token_expiry=?, refresh_token_enc=? WHERE singleton=1`)
    .run(encryptText(credentials.access_token, config.encryptionKey), credentials.expiry_date || null,
      credentials.refresh_token ? encryptText(credentials.refresh_token, config.encryptionKey) : connection.refresh_token_enc);
}

export async function getFreshAccessToken(db, config) {
  const connection = getGoogleConnection(db);
  if (!connection?.setup_complete || !connection.blog_id) throw new Error('Blogger is not connected. Complete the one-time setup first.');
  if (connection.access_token_enc && connection.token_expiry && connection.token_expiry > Date.now() + 60_000) {
    return decryptText(connection.access_token_enc, config.encryptionKey);
  }

  const refreshToken = decryptText(connection.refresh_token_enc, config.encryptionKey);
  const form = new URLSearchParams({
    client_id: config.googleClientId,
    client_secret: config.googleClientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
  const response = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form,
    signal: AbortSignal.timeout(15000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) {
    writeAudit(db, { event: 'google_refresh', status: 'error', blogId: connection.blog_id, detail: data.error || `HTTP ${response.status}` });
    throw new Error('Google authorization expired or was revoked. Reconnect Blogger from the setup page.');
  }
  db.prepare(`UPDATE google_connection SET access_token_enc=?, token_expiry=?, refresh_token_enc=? WHERE singleton=1`)
    .run(encryptText(data.access_token, config.encryptionKey), Date.now() + (Number(data.expires_in || 3600) * 1000),
      data.refresh_token ? encryptText(data.refresh_token, config.encryptionKey) : connection.refresh_token_enc);
  return data.access_token;
}

export class GoogleApiError extends Error {
  constructor(status, message, reason = null) {
    super(message);
    this.name = 'GoogleApiError';
    this.status = status;
    this.reason = reason;
  }
}

export async function bloggerRequest(db, config, { method = 'GET', path, query, body }) {
  const accessToken = await getFreshAccessToken(db, config);
  const url = new URL(`${BLOGGER_API}${path}`);
  for (const [key, value] of Object.entries(query || {})) {
    if (Array.isArray(value)) value.forEach(item => url.searchParams.append(key, String(item)));
    else if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(20000),
  });
  const data = response.status === 204 ? {} : await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = data?.error || {};
    throw new GoogleApiError(response.status, error.message || `Blogger API returned HTTP ${response.status}.`, error.errors?.[0]?.reason || null);
  }
  return data;
}

export async function listAuthorizedBlogs(db, config) {
  const connection = getGoogleConnection(db);
  if (!connection?.setup_complete) return [];
  const data = await bloggerRequest(db, config, { path: '/users/self/blogs' });
  return (data.items || [])
    .filter(blog => String(blog.id) === String(connection.blog_id))
    .map(blog => ({ id: String(blog.id), name: blog.name || blog.title, url: blog.url || '' }));
}
