import path from 'node:path';

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function cleanBaseUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' && process.env.NODE_ENV === 'production') {
    throw new Error('PUBLIC_BASE_URL must use HTTPS in production.');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('PUBLIC_BASE_URL must not contain credentials, query, or fragment.');
  }
  return url.toString().replace(/\/$/, '');
}

export function loadConfig() {
  const publicBaseUrl = cleanBaseUrl(required('PUBLIC_BASE_URL'));
  const redirectUris = (process.env.CHATGPT_OAUTH_REDIRECT_URIS ||
    'https://chatgpt.com/connector_platform_oauth_redirect')
    .split(',').map(value => value.trim()).filter(Boolean);

  for (const redirect of redirectUris) {
    const url = new URL(redirect);
    if (url.protocol !== 'https:' || url.origin !== 'https://chatgpt.com') {
      throw new Error('ChatGPT OAuth redirect URIs must be exact HTTPS URLs on chatgpt.com.');
    }
  }

  const encryptionKeyText = required('TOKEN_ENCRYPTION_KEY');
  let encryptionKey;
  if (/^[a-f0-9]{64}$/i.test(encryptionKeyText)) {
    encryptionKey = Buffer.from(encryptionKeyText, 'hex');
  } else {
    encryptionKey = Buffer.from(encryptionKeyText, 'base64');
  }
  if (encryptionKey.length !== 32) {
    throw new Error('TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes (base64 or 64-char hex).');
  }

  const googleRedirectUri = process.env.GOOGLE_REDIRECT_URI?.trim() || `${publicBaseUrl}/oauth/google/callback`;
  const googleRedirect = new URL(googleRedirectUri);
  if (process.env.NODE_ENV === 'production' && googleRedirect.protocol !== 'https:') {
    throw new Error('GOOGLE_REDIRECT_URI must use HTTPS in production.');
  }

  const databaseBackend = (process.env.DATABASE_BACKEND || 'sqlite').trim().toLowerCase();
  if (!['sqlite', 'catalyst'].includes(databaseBackend)) {
    throw new Error('DATABASE_BACKEND must be either sqlite or catalyst.');
  }

  return Object.freeze({
    nodeEnv: process.env.NODE_ENV || 'development',
    production: process.env.NODE_ENV === 'production',
    port: Number(process.env.X_ZOHO_CATALYST_LISTEN_PORT || process.env.PORT || 3000),
    publicBaseUrl,
    issuer: publicBaseUrl,
    resource: `${publicBaseUrl}/mcp`,
    protectedResourceMetadataUrl: `${publicBaseUrl}/.well-known/oauth-protected-resource/mcp`,
    googleClientId: required('GOOGLE_CLIENT_ID'),
    googleClientSecret: required('GOOGLE_CLIENT_SECRET'),
    googleRedirectUri,
    encryptionKey,
    setupAdminSecret: required('SETUP_ADMIN_SECRET'),
    databasePath: path.resolve(process.env.DATABASE_PATH || './data/blogger-ai-publisher.sqlite'),
    databaseBackend,
    allowedChatGptRedirectUris: new Set(redirectUris),
    publishEnabled: process.env.PUBLISH_ENABLED === 'true',
    maxPostsPerSearch: Math.max(10, Math.min(200, Number(process.env.MAX_POSTS_PER_SEARCH || 100))),
  });
}
