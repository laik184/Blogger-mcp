import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { rateLimit } from 'express-rate-limit';
import { requireBearerAuth } from '@modelcontextprotocol/express';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { getGoogleConnection } from './db.js';
import { createOAuthRouter, createTokenVerifier } from './oauth-server.js';
import { buildMcpServer } from './mcp-server.js';

export function createApp(config, db) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.production ? 1 : false);
  app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], formAction: ["'self'", 'https://accounts.google.com'], frameAncestors: ["'none'"] } } }));
  app.use(express.json({ limit: '1mb', strict: true }));
  app.use(express.urlencoded({ extended: false, limit: '32kb' }));
  app.use(cookieParser());

  app.use((req, res, next) => {
    const started = Date.now();
    res.on('finish', () => {
      // Never record query strings, authorization headers, OAuth codes, or post bodies.
      console.log(JSON.stringify({ level: 'info', method: req.method, path: req.path, status: res.statusCode, ms: Date.now() - started }));
    });
    next();
  });

  const oauthLimiter = rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: true, legacyHeaders: false });
  const setupLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 8, standardHeaders: true, legacyHeaders: false });
  app.use('/oauth', oauthLimiter);
  app.use('/setup/start', setupLimiter);
  app.use('/setup/reconnect', setupLimiter);
  app.use('/', createOAuthRouter(db, config));

  app.get('/healthz', (_req, res) => {
    const connection = getGoogleConnection(db);
    res.json({
      status: 'ok',
      app: 'Blogger AI Publisher',
      setup_complete: Boolean(connection?.setup_complete),
      publishing_enabled: config.publishEnabled,
    });
  });

  const tokenVerifier = createTokenVerifier(db, config);
  const requireMcpAuth = requireBearerAuth({
    verifier: tokenVerifier,
    expectedResource: new URL(config.resource),
    resourceMetadataUrl: config.protectedResourceMetadataUrl,
  });
  const mcpHandler = createMcpHandler(
    () => buildMcpServer(db, config),
    {
      // Current MCP v2 supports the 2026-07-28 per-request protocol and keeps
      // stateless compatibility with clients that still use the 2025 handshake.
      legacy: 'stateless',
      onerror: error => console.error(JSON.stringify({ level: 'error', event: 'mcp_request_failed', name: error.name, message: error.message })),
    },
  );
  const handleMcpRequest = toNodeHandler(mcpHandler, {
    onerror: error => console.error(JSON.stringify({ level: 'error', event: 'mcp_adapter_failed', name: error.name, message: error.message })),
    maxRequestBodySize: 1024 * 1024,
  });

  app.all('/mcp', requireMcpAuth, (req, res) => handleMcpRequest(req, res, req.body));

  app.use((_req, res) => res.status(404).json({ error: 'Not found.' }));
  app.use((error, _req, res, _next) => {
    console.error(JSON.stringify({ level: 'error', event: 'http_error', name: error.name, message: error.message }));
    if (res.headersSent) return;
    return res.status(error.status || 500).json({ error: error.status && error.status < 500 ? error.message : 'Request failed.' });
  });
  return app;
}
