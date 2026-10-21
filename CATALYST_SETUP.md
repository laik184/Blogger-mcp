# Zoho Catalyst AppSail setup

This guide prepares the Blogger AI Publisher for **AppSail → Catalyst-Managed Runtime**. Zoho's [Console deployment guide](https://docs.catalyst.zoho.com/en/serverless/help/appsail/catalyst-managed-runtimes/deploy-from-console/) confirms the form accepts a ZIP of the AppSail build directory. The app uses Catalyst Data Store for durable shared state; it does not rely on a local SQLite file. Google credentials and tokens are not included in the upload ZIP.

## 1. Create the persistent Data Store table

In the Catalyst project, open **Serverless → Cloud Scale → Data Store** (the console may label the section **Cloud Scale**). Create a table named exactly `BAPStore`, then add these columns:

| Column | Type | Size | Required settings |
|---|---|---:|---|
| `RecordKey` | VarChar | 255 characters | Mandatory; Unique |
| `Collection` | VarChar | 64 characters | Mandatory |
| `LogicalKey` | VarChar | 255 characters | Mandatory |
| `PayloadEnc` | Text | Maximum 10,000 characters | Mandatory |

`RecordKey` is the unique index used for safe one-time OAuth and draft-idempotency claims. `PayloadEnc` holds application-level AES-256-GCM ciphertext. Do not change column names or use Catalyst Encrypted Text: the app encrypts this field itself with `TOKEN_ENCRYPTION_KEY`.

Catalyst creates its standard `ROWID`, `CREATORID`, `CREATEDTIME`, and `MODIFIEDTIME` columns automatically. See the official [Data Store column reference](https://docs.catalyst.zoho.com/en/cloud-scale/help/data-store/columns/) for data type limits and the Unique/Mandatory settings.

## 2. AppSail form values

Upload `blogger-ai-publisher-appsail.zip`, then fill the form:

| AppSail field | Value |
|---|---|
| AppSail Name | `blogger-ai-publisher` |
| Deployment Type | `Catalyst-Managed Runtime` |
| Stack | `Node.js 24` |
| Build File | `blogger-ai-publisher-appsail.zip` |
| Startup Command | `node src/index.js` |
| Port Number | `9000` |
| Memory | `512 MB` |

The code listens on Catalyst's `X_ZOHO_CATALYST_LISTEN_PORT` when supplied and otherwise uses the form's port. Keep `PUBLISH_ENABLED=false` for the initial setup and testing.

## 3. Environment variables

Add one key/value row for each entry below. Use your actual Google OAuth client values and generate the two secrets on your own computer; never send them in chat or commit them to GitHub.

| Key | Value |
|---|---|
| `NODE_ENV` | `production` |
| `DATABASE_BACKEND` | `catalyst` |
| `PUBLIC_BASE_URL` | `https://<the exact AppSail URL shown by Catalyst>` |
| `GOOGLE_CLIENT_ID` | Google Cloud OAuth **Web application** client ID |
| `GOOGLE_CLIENT_SECRET` | Google Cloud OAuth client secret |
| `GOOGLE_REDIRECT_URI` | `https://<the exact AppSail URL shown by Catalyst>/oauth/google/callback` |
| `TOKEN_ENCRYPTION_KEY` | Output of `openssl rand -base64 32` |
| `SETUP_ADMIN_SECRET` | A separate output of `openssl rand -base64 32` |
| `CHATGPT_OAUTH_REDIRECT_URIS` | `https://chatgpt.com/connector_platform_oauth_redirect` |
| `PUBLISH_ENABLED` | `false` |
| `MAX_POSTS_PER_SEARCH` | `100` |

The AppSail public URL is assigned by Catalyst when the service is created. Use that exact HTTPS URL in both `PUBLIC_BASE_URL` and `GOOGLE_REDIRECT_URI`; add the callback to the Google Cloud OAuth client as an **Authorized redirect URI**. If the form requires values before Catalyst displays the URL, create the service first with a temporary HTTPS placeholder for those two URL values, then replace both with the assigned URL before opening `/setup` or connecting ChatGPT. Replace any temporary values and restart/redeploy the service; do not attempt OAuth setup until the values match exactly.

## 4. After AppSail is running

1. Confirm `https://<AppSail URL>/healthz` returns `"status":"ok"` and `"database":"catalyst"`.
2. Open `https://<AppSail URL>/setup`, enter the `SETUP_ADMIN_SECRET`, sign in to the intended Google account, and bind exactly one Blogger blog.
3. Connect ChatGPT to `https://<AppSail URL>/mcp` only if the current ChatGPT plan/workspace supports custom MCP write actions. Complete OAuth in ChatGPT.
4. Test `list_blogs`, `list_posts`, and a single `create_draft`; verify that the post is a Blogger Draft.
5. Leave `PUBLISH_ENABLED=false`. No public post is published by initial testing.

The hosted MCP connector configuration is the `/mcp` URL plus OAuth. `mcp.json` and `plugin.json` in the repository are reference configuration files; they are not uploaded as a Marketplace plugin.

## Build and test locally

```bash
npm ci
npm run check
npm test
```

The upload archive contains production dependencies, source, `package.json`, and the lockfile. It contains no `.env`, OAuth secrets, tests, or local database.
