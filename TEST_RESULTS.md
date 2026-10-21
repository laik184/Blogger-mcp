# Test results

Run on 2026-10-21 in Node.js using the project lockfile:

```text
npm run check  PASS
npm test       PASS — 2 tests, 2 passed, 0 failed
```

The tests use the official `@modelcontextprotocol/client` package against a local HTTP server and a mocked Blogger API.

| Check | Result |
|---|---|
| Current MCP `2026-07-28` negotiation, tool discovery | Passed; 8 tools discovered |
| Legacy MCP initialize and tool discovery | Passed |
| OAuth protected-resource and authorization-server metadata | Passed |
| Dynamic client registration | Passed; redirect URI allowlist enforced |
| OAuth code use, PKCE S256, resource binding, hashed tokens, rotating refresh tokens | Passed |
| Reject token bound to a different Google identity | Passed |
| Blogger blog/post reads, status lookup, and search | Passed against mock API |
| Create draft, verify returned post ID and DRAFT status | Passed against mock API |
| Idempotent replay and conflicting payload rejection | Passed |
| Duplicate post blocking | Passed |
| Ambiguous Blogger create response blocks duplicate retry | Passed |
| Update draft and verify DRAFT status | Passed against mock API |
| Publish disabled in initial configuration; post remains a draft | Passed |

No real Google sign-in, live Blogger read, or live Blogger draft creation was tested. Those require the deployer's Google OAuth client and authorization of the intended Blogger account. No post was published.
