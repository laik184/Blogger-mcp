# Blogger AI Publisher

A private MCP server that connects ChatGPT to one Blogger blog through the official Blogger API v3. ChatGPT is responsible for research, source review, article writing, SEO, and editorial decisions. This server only provides Blogger read and post-management tools. It does not call the OpenAI API and it does not use Make, Zapier, n8n, or Pipedream.

## Included

- MCP v2 server at `/mcp` using Streamable HTTP. It serves the current `2026-07-28` protocol and stateless compatibility for clients still using the 2025 handshake.
- Google OAuth setup and reconnect flow using the `https://www.googleapis.com/auth/blogger` scope.
- AES-256-GCM encrypted Google credentials in SQLite locally/Render or Catalyst Data Store on AppSail. MCP access and refresh tokens are stored as hashes.
- One Google identity and one selected Blog ID are bound during setup. Tool arguments cannot change the Blog ID.
- Tools: `list_blogs`, `list_posts`, `get_post`, `search_existing_posts`, `create_draft`, `update_draft`, `publish_draft`, and `get_post_status`.
- Duplicate checks across live, draft, and scheduled posts; write idempotency; audit/error records; and read-after-write verification.
- Public publishing is off by default. A publish call also requires a server-side enable flag and a separate explicit confirmation phrase.
- Render Blueprint, Dockerfile, MCP host configuration, and plugin metadata examples.

## Important scope detail

Google's Blogger API uses the Blogger OAuth scope for private blog reads and writes. That Google scope covers the user's Blogger access broadly; the server then enforces the one configured account and Blog ID on every request. For least privilege, use a Google account that has access only to the intended blog. Google documents the Blogger scope and draft insert parameter in the [Posts: insert reference](https://developers.google.com/blogger/docs/3.0/reference/posts/insert).

## Requirements

- Node.js 20 or newer for local use. The Dockerfile uses Node 24.
- A Google Cloud project with Blogger API v3 enabled and a Google OAuth 2.0 **Web application** client.
- A publicly reachable HTTPS host with durable storage for SQLite. The provided Render Blueprint uses a persistent disk. Keep the encryption key and database backup together; losing the encryption key makes stored Google tokens unreadable.
- A ChatGPT account/workspace where custom MCP servers and the required write actions are enabled by its current plan and workspace policy. OpenAI availability can vary by account and workspace; check the current ChatGPT web app and workspace settings.

## Local run

```bash
cp .env.example .env
```

Set the Google client ID and secret, then use a local callback URI such as `http://localhost:3000/oauth/google/callback` in both Google Cloud and `.env`. For local development set `PUBLIC_BASE_URL=http://localhost:3000`, `GOOGLE_REDIRECT_URI=http://localhost:3000/oauth/google/callback`, and `NODE_ENV=development`.

Generate the two secrets independently and put their values in `.env`:

```bash
openssl rand -base64 32
openssl rand -base64 32
```

Use the first output for `TOKEN_ENCRYPTION_KEY` and the second for `SETUP_ADMIN_SECRET`. Keep `.env` private and do not paste either secret, Google client secret, OAuth code, access token, or refresh token into ChatGPT.

```bash
npm ci
npm run check
npm test
npm start
```

The local `/mcp` endpoint is not reachable from ChatGPT. Use the public HTTPS deployment for ChatGPT connections.

## Deploy on Render

The Blueprint in `render.yaml` creates a Node web service and a 1 GB persistent disk mounted at `/var/data`. The selected `starter` service plan and disk may incur charges; review Render's current pricing before creating the service.

1. Put this folder in a private Git repository. Do not commit `.env`, credentials, or a production SQLite database.
2. In Render, create a Blueprint from the private repository. The service is configured with `autoDeploy: false` so updates are not deployed without a manual action.
3. Note the final HTTPS service URL assigned by Render. Use it as `PUBLIC_BASE_URL`, without a trailing slash.
4. In Google Cloud Console, enable **Blogger API v3**. Configure the OAuth consent screen. For an external app used only by you, add your Google account as a test user while the consent screen is in Testing; Google may require verification before the app can be used by a wider set of accounts.
5. Create an OAuth client ID of type **Web application**. Add this exact authorized redirect URI:

   ```text
   https://YOUR-RENDER-HOST/oauth/google/callback
   ```

6. In Render → Environment, set the following values, then deploy:

   ```text
   NODE_ENV=production
   PUBLIC_BASE_URL=https://YOUR-RENDER-HOST
   GOOGLE_CLIENT_ID=your Google OAuth client ID
   GOOGLE_CLIENT_SECRET=your Google OAuth client secret
   GOOGLE_REDIRECT_URI=https://YOUR-RENDER-HOST/oauth/google/callback
   TOKEN_ENCRYPTION_KEY=base64 output from openssl rand -base64 32
   SETUP_ADMIN_SECRET=separate output from openssl rand -base64 32
   DATABASE_PATH=/var/data/blogger-ai-publisher.sqlite
   CHATGPT_OAUTH_REDIRECT_URIS=https://chatgpt.com/connector_platform_oauth_redirect
   PUBLISH_ENABLED=false
   ```

   `render.yaml` supplies `DATABASE_PATH`, `NODE_ENV`, `CHATGPT_OAUTH_REDIRECT_URIS`, and the safe publishing default. Enter all `sync: false` values as Render secrets. Keep the encryption key stable across restarts and backups.

7. Confirm `https://YOUR-RENDER-HOST/healthz` returns `"status":"ok"`.
8. Open `https://YOUR-RENDER-HOST/setup`, enter `SETUP_ADMIN_SECRET`, sign into Google, and select the one allowed Blogger blog. The browser flow checks the Google identity, binds the Blog ID, and stores the refresh token encrypted on the server.
9. If Google later revokes access, open `/setup` and use **Reconnect this Google account**. The reconnect flow requires the setup secret and the same Google identity, and checks that the originally bound Blog ID is still accessible before replacing tokens.

## Deploy on Zoho Catalyst AppSail

For the Zoho Catalyst AppSail upload, follow [`CATALYST_SETUP.md`](./CATALYST_SETUP.md). It includes the exact managed-runtime form values, the persistent `BAPStore` Data Store schema, required environment variables, and the upload archive build contents. Set `DATABASE_BACKEND=catalyst`; do not use SQLite for AppSail because service instances can scale independently. Publishing remains disabled during the setup and draft test.

## Connect to ChatGPT

OpenAI's current [custom MCP guide](https://developers.openai.com/api/docs/guides/custom-mcp-server) says ChatGPT supports both read and write tools from a custom MCP server. Actual availability depends on the account and workspace permissions, so check whether **Add custom MCP server** appears in ChatGPT web and whether the workspace allows it. A tool call that writes data requires confirmation by default; workspace action controls can also limit available tools.

When the server is deployed and connected, follow the current guide:

1. Open ChatGPT on the web → **Plugins** → **+** → **Add custom MCP server**.
2. Name it **Blogger AI Publisher** and set the connection URL to `https://YOUR-APPSAIL-URL/mcp` (or the selected host's URL plus `/mcp`).
3. Select OAuth authentication. ChatGPT should discover the authorization server metadata, use dynamic client registration, and open Google's sign-in consent flow through this server.
4. Review the risk warning, create the plugin, and inspect the discovered tools. Leave `publish_draft` disabled in ChatGPT action controls if those controls are available. The server-side `PUBLISH_ENABLED=false` lock is authoritative regardless of ChatGPT settings.
5. In a chat, select or `@mention` Blogger AI Publisher and test `list_blogs`, `list_posts`, and `get_post_status`. Then ask for one draft and verify the returned ID and `DRAFT` status in Blogger.

`mcp.json` and `plugin.json` are portable host/configuration examples. ChatGPT's custom MCP UI connects to the HTTPS endpoint and performs OAuth; it does not import these JSON files as a public Marketplace submission.

## OAuth and data handling

- Google authorization is server-to-server: Google refresh tokens never go to ChatGPT.
- Google refresh/access tokens are AES-256-GCM encrypted at rest. OAuth authorization codes, MCP access tokens, and MCP refresh tokens are hashed before storage.
- OAuth authorization uses state, a same-browser HttpOnly cookie, a 5-minute one-use authorization code, exact redirect URI allowlisting, resource binding, and PKCE S256.
- Refresh tokens rotate. Access tokens expire after one hour; MCP refresh tokens expire after 90 days.
- The MCP OAuth authorization screen only accepts the one Google account already bound in `/setup`.
- Logs omit HTTP query strings, authorization headers, OAuth codes, and request bodies. Tool audit rows include tool names, statuses, Blog IDs, post IDs, and bounded error text.
- The SQLite database contains encrypted Google tokens and hashed MCP/OAuth credentials. Protect the volume and backups as sensitive data.

## Tools and safeguards

| Tool | What it does | Guardrails |
|---|---|---|
| `list_blogs` | Returns the bound blog only | Fixed account and Blog ID |
| `list_posts` | Lists live, draft, or scheduled posts | Fixed Blog ID; max 50 per call |
| `get_post` | Reads one post and its HTML | Fixed Blog ID |
| `search_existing_posts` | Searches titles and content across post statuses | Bounded scan; reports when capped |
| `create_draft` | Creates a Blogger draft | Duplicate check, idempotency key, post-ID and DRAFT verification |
| `update_draft` | Replaces the content of an existing draft | Refuses non-drafts; duplicate check, idempotency key, post-ID and DRAFT verification |
| `publish_draft` | Publishes a draft | Disabled by default; requires `PUBLISH_ENABLED=true`, an explicit phrase, idempotency key, and LIVE+URL verification |
| `get_post_status` | Checks ID, status, URL, and timestamps | Fixed Blog ID |

If a draft-create request may have reached Blogger but its result cannot be verified, retrying with the same key is blocked. Search Blogger and verify manually. Use a new key only after confirming that the original request did not create a draft.

To enable publishing later, set `PUBLISH_ENABLED=true` in Render and redeploy. Then use `publish_draft` only in a separate interactive ChatGPT conversation after reviewing the verified draft. A scheduled task must remain draft-only. ChatGPT may ask for an action confirmation, and workspace action policy can block writes.

## Daily workflow prompt

The prompt is in [`DAILY_WORKFLOW.md`](./DAILY_WORKFLOW.md). OpenAI's [scheduled tasks guide](https://learn.chatgpt.com/docs/automations) says tasks can use plugins, but availability depends on the plan and workspace settings; unattended execution also follows workspace approval policy. This project has not created an 8:00 AM Asia/Kolkata task. First connect the plugin and test draft creation manually. Keep `PUBLISH_ENABLED=false`: even if a scheduled task is available, this server cannot publish while that lock is off.

## Tests and limits

Run `npm run check && npm test`. The integration tests use the official MCP TypeScript client and a local mocked Blogger API. They cover current MCP v2 discovery and the legacy handshake, OAuth metadata/DCR/PKCE/token rotation, wrong-account rejection, Blogger reads, create/update drafts, duplicate handling, an ambiguous create response, idempotency replay, and disabled publication.

No real Google OAuth was completed and no live Blogger draft was created during this build because Google Cloud credentials and the user's Blogger authorization were not available. Run the connected ChatGPT test in the deployment steps to verify the real account and blog.

## Troubleshooting

- **Google says redirect URI mismatch:** the Cloud Console callback must exactly match `GOOGLE_REDIRECT_URI`, including scheme, hostname, and path.
- **OAuth consent says app is unverified:** keep the Google OAuth app in Testing and add the account as a test user, or complete Google's verification process for broader access.
- **ChatGPT cannot discover tools:** confirm the endpoint is public HTTPS, `/healthz` is healthy, `/mcp` is set as the endpoint, and OAuth metadata endpoints respond. Ensure custom MCP and its required actions are allowed by the current account/workspace settings.
- **Draft operation reports an uncertain previous result:** use `search_existing_posts` and inspect Blogger. The server intentionally will not retry a create request that might already have succeeded.
- **Google access is revoked:** reconnect at `/setup` with the setup secret, sign into the same Google account, and re-confirm the bound blog remains accessible.
