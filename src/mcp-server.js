import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { bloggerRequest, GoogleApiError, listAuthorizedBlogs } from './google.js';
import { getGoogleConnection, writeAudit } from './db.js';
import { sha256 } from './crypto.js';
import { requireGoogleSub, requireScope } from './oauth-server.js';
import { requireScopes } from '@modelcontextprotocol/server';

const readAnnotations = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const writeAnnotations = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
const publishAnnotations = { readOnlyHint: false, destructiveHint: true, openWorldHint: false };

function jsonResult(value) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
  };
}

function toolError(message, data = undefined) {
  return {
    content: [{ type: 'text', text: message }],
    ...(data ? { structuredContent: data } : {}),
    isError: true,
  };
}

function normalizeTitle(value) {
  return String(value || '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US');
}

function normalizeContent(value) {
  return String(value || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US');
}

function toSummary(post, includeContent = false) {
  const plain = normalizeContent(post.content);
  return {
    id: String(post.id),
    title: post.title || '',
    status: post.status || 'UNKNOWN',
    url: post.url || null,
    updated: post.updated || null,
    published: post.published || null,
    labels: post.labels || [],
    excerpt: plain ? plain.slice(0, 400) : undefined,
    content: includeContent ? (post.content || '') : undefined,
  };
}

function stableHash(value) {
  return sha256(JSON.stringify(value, Object.keys(value).sort()));
}

function bindAuthorizedContext(db, context) {
  const connection = getGoogleConnection(db);
  const googleSub = requireGoogleSub(context);
  const boundBlogId = context?.http?.authInfo?.extra?.blogId;
  if (!connection?.setup_complete || !connection.blog_id || !googleSub ||
      connection.google_sub !== googleSub || String(boundBlogId) !== String(connection.blog_id)) {
    throw new Error('This request is not authorized for the server’s bound Google account and blog. Reconnect the private app.');
  }
  return connection;
}

function requireToolAuth(db, config, context, scope) {
  const scopeError = requireScope(context, scope, config);
  if (scopeError) return { error: scopeError };
  try {
    return { connection: bindAuthorizedContext(db, context) };
  } catch (error) {
    return { error: toolError(error.message) };
  }
}

function logTool(db, name, status, connection, postId, detail = null) {
  writeAudit(db, { event: 'tool_call', toolName: name, status, blogId: connection?.blog_id || null, postId, detail });
}

async function listPostsInternal(db, config, connection, { statuses = ['LIVE', 'DRAFT', 'SCHEDULED'], maxResults = 50, pageToken, fetchBodies = true } = {}) {
  return bloggerRequest(db, config, {
    path: `/blogs/${encodeURIComponent(connection.blog_id)}/posts`,
    query: {
      status: statuses.map(status => String(status).toLowerCase()),
      maxResults,
      pageToken,
      fetchBodies,
      view: 'ADMIN',
    },
  });
}

async function collectPostsInternal(db, config, connection, limit) {
  const posts = [];
  const visited = new Set();
  let capped = false;
  const statuses = ['LIVE', 'DRAFT', 'SCHEDULED'];
  for (let statusIndex = 0; statusIndex < statuses.length; statusIndex++) {
    const status = statuses[statusIndex];
    let pageToken;
    do {
      const result = await listPostsInternal(db, config, connection, { statuses: [status], maxResults: 50, pageToken, fetchBodies: true });
      for (const post of result.items || []) {
        const id = String(post.id);
        if (visited.has(id)) continue;
        if (visited.size >= limit) {
          capped = true;
          break;
        }
        visited.add(id);
        posts.push(post);
      }
      if (capped || (result.nextPageToken && visited.size >= limit)) {
        capped = true;
        break;
      }
      pageToken = result.nextPageToken;
    } while (pageToken);
    if (capped) break;
    if (statusIndex < statuses.length - 1 && visited.size >= limit) {
      capped = true;
      break;
    }
  }
  return { posts, scanned: visited.size, capped };
}

async function searchPostsInternal(db, config, connection, query, maxResults) {
  const queryTitle = normalizeTitle(query);
  const queryText = normalizeContent(query);
  const scanned = await collectPostsInternal(db, config, connection, Math.min(config.maxPostsPerSearch, Math.max(10, maxResults * 3)));
  const matches = scanned.posts.filter(post => normalizeTitle(post.title).includes(queryTitle) || normalizeContent(post.content).includes(queryText))
    .slice(0, maxResults).map(post => toSummary(post));
  return { matches, scanned: scanned.scanned, capped: scanned.capped };
}

async function findDuplicate(db, config, connection, title, content, excludingPostId = null) {
  const titleKey = normalizeTitle(title);
  const contentKey = normalizeContent(content);
  const scan = await collectPostsInternal(db, config, connection, config.maxPostsPerSearch);
  const duplicate = scan.posts.find(post => {
    if (String(post.id) === String(excludingPostId || '')) return false;
    return normalizeTitle(post.title) === titleKey || (contentKey.length > 100 && normalizeContent(post.content) === contentKey);
  }) || null;
  return { duplicate, capped: scan.capped, scanned: scan.scanned };
}

function validateIdempotencyKey(value) {
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(value)) throw new Error('idempotency_key must contain 8–128 letters, numbers, dots, underscores, colons, or hyphens.');
}

function beginIdempotency(db, blogId, key, requestHash) {
  const transaction = db.transaction(() => {
    const existing = db.prepare('SELECT * FROM idempotency WHERE blog_id=? AND idempotency_key=?').get(blogId, key);
    if (existing && existing.request_hash !== requestHash) throw new Error('This idempotency_key was already used with different post content.');
    if (existing?.state === 'succeeded') return { replay: true, existing };
    if (existing?.state === 'in_progress') return { pending: true, existing };
    if (existing?.uncertain) return { uncertain: true, existing };
    const priorFailed = existing?.state === 'failed';
    if (existing) {
      db.prepare(`UPDATE idempotency SET state='in_progress',uncertain=0,updated_at=? WHERE blog_id=? AND idempotency_key=?`)
        .run(new Date().toISOString(), blogId, key);
    } else {
      db.prepare(`INSERT INTO idempotency(blog_id,idempotency_key,request_hash,state,updated_at)
        VALUES(?,?,?,'in_progress',?)`).run(blogId, key, requestHash, new Date().toISOString());
    }
    return { replay: false, priorFailed: Boolean(priorFailed), existing };
  });
  return transaction();
}

function finishIdempotency(db, blogId, key, result) {
  db.prepare(`UPDATE idempotency SET state='succeeded',uncertain=0,post_id=?,post_url=?,updated_at=?
    WHERE blog_id=? AND idempotency_key=?`).run(result.id, result.url || null, new Date().toISOString(), blogId, key);
}

function failIdempotency(db, blogId, key, uncertain = false) {
  db.prepare(`UPDATE idempotency SET state='failed',uncertain=?,updated_at=? WHERE blog_id=? AND idempotency_key=?`)
    .run(uncertain ? 1 : 0, new Date().toISOString(), blogId, key);
}

export function buildMcpServer(db, config) {
  const server = new McpServer({
    name: 'blogger-ai-publisher',
    version: '1.0.0',
    instructions: 'This server only exposes Blogger reading and post-management tools. ChatGPT performs research, fact checking, SEO writing, and decisions. The server never performs research. Blogger access is restricted to the single Google account and Blog ID bound during setup. Public publishing is disabled by default.',
  });

  server.registerTool('list_blogs', {
    title: 'List authorized blogs',
    description: 'Return the single Blogger blog bound to this private server. The blog ID is fixed by setup and cannot be changed by tool arguments.',
    inputSchema: z.object({}),
    annotations: readAnnotations,
    _meta: { securitySchemes: [{ type: 'oauth2', scopes: ['blogger.read'] }] },
    scopeChallenge: requireScopes('blogger.read'),
  }, async (_args, context) => {
    const auth = requireToolAuth(db, config, context, 'blogger.read');
    if (auth.error) return auth.error;
    try {
      const blogs = await listAuthorizedBlogs(db, config);
      logTool(db, 'list_blogs', 'ok', auth.connection);
      return jsonResult({ blogs, authorized_google_account: auth.connection.email });
    } catch (error) {
      logTool(db, 'list_blogs', 'error', auth.connection, null, error.message);
      return toolError(error.message);
    }
  });

  server.registerTool('list_posts', {
    title: 'List Blogger posts',
    description: 'List posts from the one authorized blog. Use status to select LIVE, DRAFT, or SCHEDULED posts. The server fixes the Blog ID.',
    inputSchema: z.object({
      status: z.enum(['LIVE', 'DRAFT', 'SCHEDULED']).optional(),
      max_results: z.number().int().min(1).max(50).default(20),
      page_token: z.string().max(500).optional(),
      fetch_bodies: z.boolean().default(false),
    }),
    annotations: readAnnotations,
    _meta: { securitySchemes: [{ type: 'oauth2', scopes: ['blogger.read'] }] },
    scopeChallenge: requireScopes('blogger.read'),
  }, async ({ status, max_results, page_token, fetch_bodies }, context) => {
    const auth = requireToolAuth(db, config, context, 'blogger.read');
    if (auth.error) return auth.error;
    try {
      const response = await listPostsInternal(db, config, auth.connection, {
        statuses: status ? [status] : ['LIVE', 'DRAFT', 'SCHEDULED'],
        maxResults: max_results,
        pageToken: page_token,
        fetchBodies: fetch_bodies,
      });
      const result = { posts: (response.items || []).map(toSummary), next_page_token: response.nextPageToken || null, blog_id: auth.connection.blog_id };
      logTool(db, 'list_posts', 'ok', auth.connection);
      return jsonResult(result);
    } catch (error) {
      logTool(db, 'list_posts', 'error', auth.connection, null, error.message);
      return toolError(error.message);
    }
  });

  server.registerTool('get_post', {
    title: 'Get a Blogger post',
    description: 'Read one post by ID from the authorized blog, including HTML content and status.',
    inputSchema: z.object({ post_id: z.string().min(1).max(128) }),
    annotations: readAnnotations,
    _meta: { securitySchemes: [{ type: 'oauth2', scopes: ['blogger.read'] }] },
    scopeChallenge: requireScopes('blogger.read'),
  }, async ({ post_id }, context) => {
    const auth = requireToolAuth(db, config, context, 'blogger.read');
    if (auth.error) return auth.error;
    try {
      const post = await bloggerRequest(db, config, { path: `/blogs/${encodeURIComponent(auth.connection.blog_id)}/posts/${encodeURIComponent(post_id)}` });
      logTool(db, 'get_post', 'ok', auth.connection, post_id);
      return jsonResult(toSummary(post, true));
    } catch (error) {
      logTool(db, 'get_post', 'error', auth.connection, post_id, error.message);
      return toolError(error.message);
    }
  });

  server.registerTool('search_existing_posts', {
    title: 'Search existing Blogger posts',
    description: 'Search titles and HTML content across live posts, drafts, and scheduled posts before creating an article. This is the duplicate-check tool.',
    inputSchema: z.object({ query: z.string().min(2).max(200), max_results: z.number().int().min(1).max(20).default(10) }),
    annotations: readAnnotations,
    _meta: { securitySchemes: [{ type: 'oauth2', scopes: ['blogger.read'] }] },
    scopeChallenge: requireScopes('blogger.read'),
  }, async ({ query, max_results }, context) => {
    const auth = requireToolAuth(db, config, context, 'blogger.read');
    if (auth.error) return auth.error;
    try {
      const result = await searchPostsInternal(db, config, auth.connection, query, max_results);
      logTool(db, 'search_existing_posts', 'ok', auth.connection);
      return jsonResult({ ...result, blog_id: auth.connection.blog_id });
    } catch (error) {
      logTool(db, 'search_existing_posts', 'error', auth.connection, null, error.message);
      return toolError(error.message);
    }
  });

  server.registerTool('create_draft', {
    title: 'Create Blogger draft',
    description: 'Create an unpublished Blogger draft after duplicate checks. Requires a unique idempotency_key so retries cannot create another post. This tool never publishes.',
    inputSchema: z.object({
      title: z.string().trim().min(4).max(200),
      content_html: z.string().min(50).max(100000),
      labels: z.array(z.string().trim().min(1).max(100)).max(20).default([]),
      idempotency_key: z.string().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/),
    }),
    annotations: writeAnnotations,
    _meta: { securitySchemes: [{ type: 'oauth2', scopes: ['blogger.write'] }] },
    scopeChallenge: requireScopes('blogger.write'),
  }, async ({ title, content_html, labels, idempotency_key }, context) => {
    const auth = requireToolAuth(db, config, context, 'blogger.write');
    if (auth.error) return auth.error;
    const requestHash = stableHash({ title: title.trim(), content_html, labels: [...labels].sort() });
    let idempotencyStarted = false;
    let postInsertStarted = false;
    try {
      validateIdempotencyKey(idempotency_key);
      const idempotency = beginIdempotency(db, auth.connection.blog_id, idempotency_key, requestHash);
      idempotencyStarted = !idempotency.replay && !idempotency.pending;
      if (idempotency.replay) {
        logTool(db, 'create_draft', 'replayed', auth.connection, idempotency.existing.post_id);
        return jsonResult({ created: false, replayed: true, id: idempotency.existing.post_id, url: idempotency.existing.post_url, status: 'DRAFT' });
      }
      if (idempotency.pending) return toolError('This idempotency_key is already being processed. Retry after the current request finishes.');
      if (idempotency.uncertain) {
        logTool(db, 'create_draft', 'uncertain_retry_blocked', auth.connection);
        return toolError('A previous create_draft request with this key may have reached Blogger, but its post ID was not verified. No second create request was sent. Search existing posts and check Blogger manually; use a new key only after confirming no draft was created.');
      }

      const duplicateCheck = await findDuplicate(db, config, auth.connection, title, content_html);
      const duplicate = duplicateCheck.duplicate;
      if (duplicate) {
        failIdempotency(db, auth.connection.blog_id, idempotency_key);
        logTool(db, 'create_draft', 'duplicate_blocked', auth.connection, duplicate.id);
        return toolError(`A post with the same title already exists (${duplicate.status}, post ID ${duplicate.id}). Review it with get_post before creating another draft.`, { duplicate });
      }
      if (duplicateCheck.capped) {
        failIdempotency(db, auth.connection.blog_id, idempotency_key);
        return toolError(`Duplicate scan reached the ${duplicateCheck.scanned}-post safety limit. No draft was created because the full blog could not be checked.`);
      }

      postInsertStarted = true;
      const post = await bloggerRequest(db, config, {
        method: 'POST',
        path: `/blogs/${encodeURIComponent(auth.connection.blog_id)}/posts`,
        query: { isDraft: true },
        body: { kind: 'blogger#post', title: title.trim(), content: content_html, labels },
      });
      if (!post.id) throw new Error('Blogger accepted the request but did not return a post ID. Check Blogger before retrying.');
      const verified = await bloggerRequest(db, config, { path: `/blogs/${encodeURIComponent(auth.connection.blog_id)}/posts/${encodeURIComponent(post.id)}` });
      if (String(verified.id) !== String(post.id) || verified.status !== 'DRAFT') {
        throw new Error('Draft creation returned a post ID, but status verification did not confirm DRAFT. Do not retry with a new idempotency key.');
      }
      const result = toSummary(verified);
      finishIdempotency(db, auth.connection.blog_id, idempotency_key, result);
      logTool(db, 'create_draft', 'ok', auth.connection, verified.id);
      return jsonResult({ created: true, ...result });
    } catch (error) {
      if (idempotencyStarted) failIdempotency(db, auth.connection.blog_id, idempotency_key, postInsertStarted);
      logTool(db, 'create_draft', 'error', auth.connection, null, error.message);
      return toolError(error instanceof GoogleApiError ? `Blogger API error (${error.status}): ${error.message}` : error.message);
    }
  });

  server.registerTool('update_draft', {
    title: 'Update Blogger draft',
    description: 'Update a post only if Blogger confirms it is still a draft in the authorized blog. The tool cannot update live or scheduled posts.',
    inputSchema: z.object({
      post_id: z.string().min(1).max(128),
      title: z.string().trim().min(4).max(200),
      content_html: z.string().min(50).max(100000),
      labels: z.array(z.string().trim().min(1).max(100)).max(20).default([]),
      idempotency_key: z.string().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/),
    }),
    annotations: writeAnnotations,
    _meta: { securitySchemes: [{ type: 'oauth2', scopes: ['blogger.write'] }] },
    scopeChallenge: requireScopes('blogger.write'),
  }, async ({ post_id, title, content_html, labels, idempotency_key }, context) => {
    const auth = requireToolAuth(db, config, context, 'blogger.write');
    if (auth.error) return auth.error;
    let idempotencyStarted = false;
    try {
      validateIdempotencyKey(idempotency_key);
      const requestHash = stableHash({ action: 'update', post_id, title: title.trim(), content_html, labels: [...labels].sort() });
      const idempotency = beginIdempotency(db, auth.connection.blog_id, idempotency_key, requestHash);
      idempotencyStarted = !idempotency.replay && !idempotency.pending;
      if (idempotency.replay) {
        const replayPost = await bloggerRequest(db, config, { path: `/blogs/${encodeURIComponent(auth.connection.blog_id)}/posts/${encodeURIComponent(post_id)}` });
        if (replayPost.status !== 'DRAFT') return toolError(`This update was already applied, but the post is now ${replayPost.status}.`);
        return jsonResult({ ...toSummary(replayPost), draft_updated: false, replayed: true });
      }
      if (idempotency.pending) return toolError('This draft update is already being processed. Retry after the current request finishes.');
      const current = await bloggerRequest(db, config, { path: `/blogs/${encodeURIComponent(auth.connection.blog_id)}/posts/${encodeURIComponent(post_id)}` });
      if (current.status !== 'DRAFT') {
        failIdempotency(db, auth.connection.blog_id, idempotency_key);
        return toolError(`Refusing update: post ${post_id} has status ${current.status || 'UNKNOWN'}, not DRAFT.`);
      }
      const duplicateCheck = await findDuplicate(db, config, auth.connection, title, content_html, post_id);
      if (duplicateCheck.duplicate) {
        failIdempotency(db, auth.connection.blog_id, idempotency_key);
        return toolError(`Another post has the same title or article body (${duplicateCheck.duplicate.status}, post ID ${duplicateCheck.duplicate.id}).`);
      }
      if (duplicateCheck.capped) {
        failIdempotency(db, auth.connection.blog_id, idempotency_key);
        return toolError(`Duplicate scan reached the ${duplicateCheck.scanned}-post safety limit. No draft was updated.`);
      }
      const updated = await bloggerRequest(db, config, {
        method: 'PUT',
        path: `/blogs/${encodeURIComponent(auth.connection.blog_id)}/posts/${encodeURIComponent(post_id)}`,
        body: { ...current, title: title.trim(), content: content_html, labels },
      });
      const verified = await bloggerRequest(db, config, { path: `/blogs/${encodeURIComponent(auth.connection.blog_id)}/posts/${encodeURIComponent(post_id)}` });
      if (String(verified.id) !== String(updated.id || post_id) || verified.status !== 'DRAFT') {
        throw new Error('Draft update was not verified as a Blogger draft.');
      }
      finishIdempotency(db, auth.connection.blog_id, idempotency_key, toSummary(verified));
      logTool(db, 'update_draft', 'ok', auth.connection, post_id);
      return jsonResult({ ...toSummary(verified), draft_updated: true });
    } catch (error) {
      if (idempotencyStarted) failIdempotency(db, auth.connection.blog_id, idempotency_key);
      logTool(db, 'update_draft', 'error', auth.connection, post_id, error.message);
      return toolError(error instanceof GoogleApiError ? `Blogger API error (${error.status}): ${error.message}` : error.message);
    }
  });

  server.registerTool('publish_draft', {
    title: 'Publish Blogger draft',
    description: 'Publish a verified draft only when PUBLISH_ENABLED=true on the server and approval_phrase is exactly “I APPROVE PUBLICATION”. Public publishing is disabled by default for initial testing.',
    inputSchema: z.object({
      post_id: z.string().min(1).max(128),
      idempotency_key: z.string().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/),
      approval_phrase: z.string().min(1).max(64),
    }),
    annotations: publishAnnotations,
    _meta: { securitySchemes: [{ type: 'oauth2', scopes: ['blogger.write'] }] },
    scopeChallenge: requireScopes('blogger.write'),
  }, async ({ post_id, idempotency_key, approval_phrase }, context) => {
    const auth = requireToolAuth(db, config, context, 'blogger.write');
    if (auth.error) return auth.error;
    if (!config.publishEnabled) return toolError('Public publishing is disabled on this server. Keep the post as a draft.');
    if (approval_phrase !== 'I APPROVE PUBLICATION') return toolError('Explicit publication approval is required.');
    let idempotencyStarted = false;
    try {
      validateIdempotencyKey(idempotency_key);
      const requestHash = stableHash({ post_id, action: 'publish' });
      const idempotency = beginIdempotency(db, auth.connection.blog_id, idempotency_key, requestHash);
      idempotencyStarted = !idempotency.replay && !idempotency.pending;
      if (idempotency.replay) return jsonResult({ published_now: true, replayed: true, id: idempotency.existing.post_id, url: idempotency.existing.post_url, status: 'LIVE' });
      if (idempotency.pending) return toolError('This publish request is already being processed. Check get_post_status before retrying.');

      const current = await bloggerRequest(db, config, { path: `/blogs/${encodeURIComponent(auth.connection.blog_id)}/posts/${encodeURIComponent(post_id)}` });
      if (current.status !== 'DRAFT') {
        if (current.status === 'LIVE') {
          const alreadyLive = toSummary(current);
          finishIdempotency(db, auth.connection.blog_id, idempotency_key, alreadyLive);
          return jsonResult({ ...alreadyLive, published_now: false, already_live: true });
        }
        failIdempotency(db, auth.connection.blog_id, idempotency_key);
        return toolError(`Refusing publish: post ${post_id} has status ${current.status || 'UNKNOWN'}, not DRAFT.`);
      }
      const result = await bloggerRequest(db, config, {
        method: 'POST',
        path: `/blogs/${encodeURIComponent(auth.connection.blog_id)}/posts/${encodeURIComponent(post_id)}/publish`,
      });
      const verified = result.status === 'LIVE' ? result : await bloggerRequest(db, config, {
        path: `/blogs/${encodeURIComponent(auth.connection.blog_id)}/posts/${encodeURIComponent(post_id)}`,
      });
      if (verified.status !== 'LIVE' || !verified.url) throw new Error('Blogger did not verify the post as LIVE with a public URL.');
      const summary = toSummary(verified);
      finishIdempotency(db, auth.connection.blog_id, idempotency_key, summary);
      logTool(db, 'publish_draft', 'ok', auth.connection, post_id);
      return jsonResult({ ...summary, published_now: true, published_url: verified.url });
    } catch (error) {
      if (idempotencyStarted) failIdempotency(db, auth.connection.blog_id, idempotency_key);
      logTool(db, 'publish_draft', 'error', auth.connection, post_id, error.message);
      return toolError(error instanceof GoogleApiError ? `Blogger API error (${error.status}): ${error.message}` : error.message);
    }
  });

  server.registerTool('get_post_status', {
    title: 'Get Blogger post status',
    description: 'Verify the current Blogger status, post ID, updated time, and URL for a post.',
    inputSchema: z.object({ post_id: z.string().min(1).max(128) }),
    annotations: readAnnotations,
    _meta: { securitySchemes: [{ type: 'oauth2', scopes: ['blogger.read'] }] },
    scopeChallenge: requireScopes('blogger.read'),
  }, async ({ post_id }, context) => {
    const auth = requireToolAuth(db, config, context, 'blogger.read');
    if (auth.error) return auth.error;
    try {
      const post = await bloggerRequest(db, config, { path: `/blogs/${encodeURIComponent(auth.connection.blog_id)}/posts/${encodeURIComponent(post_id)}` });
      const result = { id: String(post.id), status: post.status || 'UNKNOWN', url: post.url || null, updated: post.updated || null, published: post.published || null };
      logTool(db, 'get_post_status', 'ok', auth.connection, post_id);
      return jsonResult(result);
    } catch (error) {
      logTool(db, 'get_post_status', 'error', auth.connection, post_id, error.message);
      return toolError(error.message);
    }
  });

  return server;
}
