import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/client';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createApp } from '../src/app.js';
import { openDatabase } from '../src/db.js';
import { encryptText, randomToken, sha256 } from '../src/crypto.js';

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

async function getFreePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

test('MCP initialization, tool discovery, OAuth metadata, read, draft, idempotency, duplicate guard, and publish lock', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bap-test-'));
  const databasePath = path.join(directory, 'test.sqlite');
  const encryptionKey = Buffer.alloc(32, 7);
  const port = await getFreePort();
  const publicBaseUrl = `http://127.0.0.1:${port}`;
  const config = {
    nodeEnv: 'test', production: false, port, publicBaseUrl, issuer: publicBaseUrl,
    resource: `${publicBaseUrl}/mcp`, protectedResourceMetadataUrl: `${publicBaseUrl}/.well-known/oauth-protected-resource/mcp`,
    googleClientId: 'test-google-client', googleClientSecret: 'not-a-real-secret',
    googleRedirectUri: `${publicBaseUrl}/oauth/google/callback`, encryptionKey,
    setupAdminSecret: randomToken(), databasePath,
    allowedChatGptRedirectUris: new Set(['https://chatgpt.com/connector_platform_oauth_redirect']),
    publishEnabled: false, maxPostsPerSearch: 50,
  };
  const db = openDatabase(databasePath);
  const googleSub = 'google-sub-test-123';
  const blogId = 'blog-test-456';
  const accessToken = randomToken();
  const mcpAccessToken = randomToken();
  const clientId = 'bap_test_client';
  const now = Math.floor(Date.now() / 1000);

  await db.put('google_connection', 'singleton', {
    google_sub: googleSub, email: 'publisher@example.com', display_name: 'Test Publisher',
    refresh_token_enc: encryptText('refresh-token-for-test', encryptionKey),
    access_token_enc: encryptText(accessToken, encryptionKey), token_expiry: Date.now() + 60 * 60 * 1000,
    blog_id: blogId, blog_name: 'Test Blog', blog_url: 'https://example.blogspot.com',
    connected_at: new Date().toISOString(), setup_complete: 1,
  });
  await db.insert('oauth_clients', clientId, {
    client_id: clientId, client_name: 'Test ChatGPT', redirect_uris_json: JSON.stringify(['https://chatgpt.com/connector_platform_oauth_redirect']), created_at: new Date().toISOString(),
  });
  await db.insert('oauth_access_tokens', sha256(mcpAccessToken), {
    client_id: clientId, google_sub: googleSub, scope: 'blogger.read blogger.write offline_access', resource: config.resource,
    expires_at: now + 3600, created_at: new Date().toISOString(),
  });
  const wrongGoogleToken = randomToken();
  await db.insert('oauth_access_tokens', sha256(wrongGoogleToken), {
    client_id: clientId, google_sub: 'different-google-account', scope: 'blogger.read blogger.write', resource: config.resource,
    expires_at: now + 3600, created_at: new Date().toISOString(),
  });

  const posts = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input.toString() : input.url);
    if (url.hostname === 'www.googleapis.com' && url.pathname === '/blogger/v3/users/self/blogs') {
      return jsonResponse({ items: [{ id: blogId, name: 'Test Blog', url: 'https://example.blogspot.com' }] });
    }
    if (url.hostname === 'www.googleapis.com' && url.pathname === `/blogger/v3/blogs/${blogId}/posts`) {
      if (init.method === 'POST') {
        const payload = JSON.parse(init.body || '{}');
        const post = { id: `draft-${String(posts.length + 1).padStart(3, '0')}`, title: payload.title, content: payload.content, labels: payload.labels, status: 'DRAFT', updated: new Date().toISOString(), url: null };
        posts.push(post);
        if (payload.title === 'Lost response idempotency check') {
          return jsonResponse({ error: { message: 'Simulated response loss after Blogger created the draft.' } }, 502);
        }
        return jsonResponse(post);
      }
      const requestedStatus = url.searchParams.getAll('status').map(status => status.toUpperCase());
      return jsonResponse({ items: posts.filter(post => !requestedStatus.length || requestedStatus.includes(post.status)) });
    }
    if (url.hostname === 'www.googleapis.com' && url.pathname.startsWith(`/blogger/v3/blogs/${blogId}/posts/`)) {
      const postId = decodeURIComponent(url.pathname.split('/').at(-1));
      const post = posts.find(item => item.id === postId);
      if (!post) return jsonResponse({ error: { message: 'Post not found.' } }, 404);
      if (init.method === 'PUT') Object.assign(post, JSON.parse(init.body || '{}'), { status: 'DRAFT', updated: new Date().toISOString() });
      return jsonResponse(post);
    }
    return realFetch(input, init);
  };

  const app = createApp(config, db);
  const httpServer = app.listen(port, '127.0.0.1');
  await once(httpServer, 'listening');
  let client;
  t.after(async () => {
    if (client) await client.close();
    httpServer.closeAllConnections();
    globalThis.fetch = realFetch;
    await new Promise(resolve => httpServer.close(resolve));
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const resourceMetadata = await realFetch(`${publicBaseUrl}/.well-known/oauth-protected-resource/mcp`);
  assert.equal(resourceMetadata.status, 200);
  assert.deepEqual((await resourceMetadata.json()).authorization_servers, [config.issuer]);
  const authorizationMetadata = await realFetch(`${publicBaseUrl}/.well-known/oauth-authorization-server`);
  const metadata = await authorizationMetadata.json();
  assert.equal(metadata.code_challenge_methods_supported[0], 'S256');
  assert.equal(metadata.authorization_response_iss_parameter_supported, true);
  const wrongAccountCall = await realFetch(`${publicBaseUrl}/mcp`, {
    method: 'POST', headers: { authorization: `Bearer ${wrongGoogleToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'wrong-account-test', version: '1.0' } } }),
  });
  assert.equal(wrongAccountCall.status, 401, 'tokens for any other Google identity must be rejected');

  const registration = await realFetch(`${publicBaseUrl}/oauth/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Test ChatGPT', redirect_uris: ['https://chatgpt.com/connector_platform_oauth_redirect'],
      grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none',
    }),
  });
  assert.equal(registration.status, 201);
  assert.ok((await registration.json()).client_id);

  const transport = new StreamableHTTPClientTransport(new URL(`${publicBaseUrl}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${mcpAccessToken}` } },
    fetch: realFetch,
  });
  client = new Client({ name: 'blogger-ai-publisher-test', version: '1.0.0' });
  await client.connect(transport);
  const discovered = await client.listTools();
  const names = discovered.tools.map(tool => tool.name).sort();
  assert.deepEqual(names, ['create_draft', 'get_post', 'get_post_status', 'list_blogs', 'list_posts', 'publish_draft', 'search_existing_posts', 'update_draft'].sort());

  const modernTransport = new StreamableHTTPClientTransport(new URL(`${publicBaseUrl}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${mcpAccessToken}` } }, fetch: realFetch,
  });
  const modernClient = new Client({ name: 'blogger-ai-publisher-modern-test', version: '1.0.0' }, {
    versionNegotiation: { mode: { pin: '2026-07-28' } },
  });
  await modernClient.connect(modernTransport);
  assert.ok((await modernClient.listTools()).tools.length === 8);
  await modernClient.close();

  const blogs = await client.callTool({ name: 'list_blogs', arguments: {} });
  assert.equal(blogs.isError, undefined);
  assert.match(blogs.content[0].text, /blog-test-456/);

  const list = await client.callTool({ name: 'list_posts', arguments: { status: 'DRAFT', max_results: 10 } });
  assert.equal(list.isError, undefined);
  assert.match(list.content[0].text, /"posts": \[\]/);

  const draftArgs = {
    title: 'How Blogger OAuth Drafts Work',
    content_html: `<p>${'A verified explanation of OAuth and Blogger drafts. '.repeat(8)}</p>`,
    labels: ['Blogger', 'OAuth'],
    idempotency_key: 'test-draft-key-001',
  };
  const created = await client.callTool({ name: 'create_draft', arguments: draftArgs });
  assert.equal(created.isError, undefined);
  assert.match(created.content[0].text, /"status": "DRAFT"/);
  assert.equal(posts.length, 1);

  const retrieved = await client.callTool({ name: 'get_post', arguments: { post_id: 'draft-001' } });
  assert.equal(retrieved.isError, undefined);
  assert.match(retrieved.content[0].text, /How Blogger OAuth Drafts Work/);
  const status = await client.callTool({ name: 'get_post_status', arguments: { post_id: 'draft-001' } });
  assert.match(status.content[0].text, /"status": "DRAFT"/);
  const searched = await client.callTool({ name: 'search_existing_posts', arguments: { query: 'Blogger OAuth Drafts' } });
  assert.match(searched.content[0].text, /draft-001/);

  const conflictingReplay = await client.callTool({ name: 'create_draft', arguments: { ...draftArgs, content_html: `${draftArgs.content_html}<p>different</p>` } });
  assert.equal(conflictingReplay.isError, true);
  assert.match(conflictingReplay.content[0].text, /already used with different post content/);

  const replay = await client.callTool({ name: 'create_draft', arguments: draftArgs });
  assert.match(replay.content[0].text, /"replayed": true/);
  assert.equal(posts.length, 1, 'repeating an idempotency key must not insert another post');

  const duplicate = await client.callTool({ name: 'create_draft', arguments: { ...draftArgs, idempotency_key: 'test-draft-key-002' } });
  assert.equal(duplicate.isError, true);
  assert.match(duplicate.content[0].text, /same title already exists/);
  assert.equal(posts.length, 1);

  const uncertainArgs = {
    title: 'Lost response idempotency check',
    content_html: `<p>${'Simulate an ambiguous Blogger create response. '.repeat(8)}</p>`,
    labels: ['Blogger', 'Test'], idempotency_key: 'test-uncertain-create-001',
  };
  const uncertain = await client.callTool({ name: 'create_draft', arguments: uncertainArgs });
  assert.equal(uncertain.isError, true);
  assert.equal(posts.length, 2, 'the mock Blogger API created a draft before losing its response');
  const uncertainRetry = await client.callTool({ name: 'create_draft', arguments: uncertainArgs });
  assert.equal(uncertainRetry.isError, true);
  assert.match(uncertainRetry.content[0].text, /No second create request was sent/);
  assert.equal(posts.length, 2, 'an ambiguous result must never trigger a duplicate create');

  const updateArgs = {
    post_id: 'draft-001', title: 'How Blogger OAuth Drafts Work — Updated',
    content_html: `<p>${'Updated draft text about Blogger OAuth. '.repeat(8)}</p>`,
    labels: ['Blogger', 'OAuth', 'Updated'], idempotency_key: 'test-update-key-001',
  };
  const updated = await client.callTool({ name: 'update_draft', arguments: updateArgs });
  assert.equal(updated.isError, undefined);
  assert.match(updated.content[0].text, /"draft_updated": true/);
  assert.equal(posts[0].status, 'DRAFT');
  const updateReplay = await client.callTool({ name: 'update_draft', arguments: updateArgs });
  assert.match(updateReplay.content[0].text, /"replayed": true/);

  const publish = await client.callTool({ name: 'publish_draft', arguments: {
    post_id: 'draft-001', idempotency_key: 'test-publish-key-1', approval_phrase: 'I APPROVE PUBLICATION',
  } });
  assert.equal(publish.isError, true);
  assert.match(publish.content[0].text, /disabled on this server/);
  assert.equal(posts[0].status, 'DRAFT');
});

test('OAuth authorization codes are one-use, PKCE-bound, and resource-bound', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bap-oauth-test-'));
  const db = openDatabase(path.join(directory, 'oauth.sqlite'));
  const config = {
    nodeEnv: 'test', production: false, port: 3000, publicBaseUrl: 'http://127.0.0.1:3000',
    issuer: 'http://127.0.0.1:3000', resource: 'http://127.0.0.1:3000/mcp',
    protectedResourceMetadataUrl: 'http://127.0.0.1:3000/.well-known/oauth-protected-resource/mcp',
    googleClientId: 'fake', googleClientSecret: 'fake', googleRedirectUri: 'http://127.0.0.1:3000/oauth/google/callback',
    encryptionKey: Buffer.alloc(32, 8), setupAdminSecret: randomToken(), databasePath: path.join(directory, 'oauth.sqlite'),
    allowedChatGptRedirectUris: new Set(['https://chatgpt.com/connector_platform_oauth_redirect']),
    publishEnabled: false, maxPostsPerSearch: 50,
  };
  const port = await getFreePort();
  config.port = port;
  config.publicBaseUrl = `http://127.0.0.1:${port}`;
  config.issuer = config.publicBaseUrl;
  config.resource = `${config.publicBaseUrl}/mcp`;
  config.protectedResourceMetadataUrl = `${config.publicBaseUrl}/.well-known/oauth-protected-resource/mcp`;
  config.googleRedirectUri = `${config.publicBaseUrl}/oauth/google/callback`;
  const app = createApp(config, db);
  const server = app.listen(port, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { await new Promise(resolve => server.close(resolve)); db.close(); fs.rmSync(directory, { recursive: true, force: true }); });

  await db.insert('oauth_clients', 'client-oauth-test', {
    client_id: 'client-oauth-test', client_name: 'Test', redirect_uris_json: JSON.stringify(['https://chatgpt.com/connector_platform_oauth_redirect']), created_at: new Date().toISOString(),
  });
  const code = randomToken();
  const verifier = randomToken(48);
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const sub = 'google-oauth-sub';
  const scope = 'blogger.read blogger.write offline_access';
  const now = Math.floor(Date.now() / 1000);
  await db.insert('oauth_codes', sha256(code), {
    code_hash: sha256(code), client_id: 'client-oauth-test', redirect_uri: 'https://chatgpt.com/connector_platform_oauth_redirect',
    google_sub: sub, scope, code_challenge: challenge, resource: config.resource, expires_at: now + 300,
  });

  const badVerifier = await fetch(`${config.publicBaseUrl}/oauth/token`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', client_id: 'client-oauth-test', code, redirect_uri: 'https://chatgpt.com/connector_platform_oauth_redirect', code_verifier: `${verifier}bad`, resource: config.resource }),
  });
  assert.equal(badVerifier.status, 400);

  // Bad PKCE does not consume a valid authorization code, allowing the legitimate client exchange.
  const tokenResponse = await fetch(`${config.publicBaseUrl}/oauth/token`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', client_id: 'client-oauth-test', code, redirect_uri: 'https://chatgpt.com/connector_platform_oauth_redirect', code_verifier: verifier, resource: config.resource }),
  });
  assert.equal(tokenResponse.status, 200);
  const tokens = await tokenResponse.json();
  assert.equal(tokens.token_type, 'Bearer');
  assert.ok(tokens.access_token && tokens.refresh_token);
  assert.ok(await db.get('oauth_access_tokens', sha256(tokens.access_token)));
  assert.equal(await db.get('oauth_access_tokens', tokens.access_token), null, 'raw token values are not stored');

  const reused = await fetch(`${config.publicBaseUrl}/oauth/token`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', client_id: 'client-oauth-test', code, redirect_uri: 'https://chatgpt.com/connector_platform_oauth_redirect', code_verifier: verifier, resource: config.resource }),
  });
  assert.equal(reused.status, 400, 'authorization codes can be exchanged only once');

  const refreshResponse = await fetch(`${config.publicBaseUrl}/oauth/token`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', client_id: 'client-oauth-test', refresh_token: tokens.refresh_token, resource: config.resource }),
  });
  assert.equal(refreshResponse.status, 200);
  const refreshed = await refreshResponse.json();
  assert.notEqual(refreshed.refresh_token, tokens.refresh_token, 'refresh tokens rotate');
});
