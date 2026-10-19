# Observability

How to see what the app is doing: the events it logs, where to read them, and how to ask an AI assistant about them through Cloudflare's MCP servers.

## What the Worker logs

`src/worker/log.ts` writes one JSON object per line. Workers Logs indexes the fields, so you can filter by `event`, `status`, `code` and so on.

| Event | Level | Fields | When |
|---|---|---|---|
| `auth.request` | info, warn on 4xx, error on 5xx | `route`, `method`, `status`, `code` | Every call to `/api/auth/*`. `code` is Better Auth's error code on failure, for example `INVALID_EMAIL_OR_PASSWORD`, `VERIFICATION_FAILED` (Turnstile) or `MISSING_RESPONSE` (no Turnstile token) |
| `request.unauthenticated` | info | `path`, `method` | An API call with no valid session (401) |
| `request.origin_rejected` | warn | `path`, `method` | A cookie-bearing write without this app's Origin or Referer (403) |
| `upload.rejected` | warn | `reason` (`no_length`, `too_large`, `not_an_image`) | An avatar upload refused |
| `admin.access_denied` | warn | `path` | `/admin` without a valid Access token |
| `cache.kv_failed` | warn | `op`, `message` | A KV session cache read, write or delete failed; the app carried on from D1 |
| `error.unhandled` | error | `path`, `method`, `message` | Anything that became a 500 |

Every event carries `requestId`, which is Cloudflare's ray id. The same value is in the `cf-ray` response header, so a user's report can be matched to its log line.

Events never carry an email, password, cookie, token or secret. The local test suite checks this on every run (cases S6 and S7 in [TESTING.md](TESTING.md)).

Rate limit blocks at the edge happen before the Worker runs, so they do not appear here. Find them in the dashboard under your zone's Security events.

## Where to read them

- **Dashboard:** Workers and Pages, your Worker, Observability. Filter with the query builder, for example `event = "auth.request" AND status >= 400`.
- **Live:** `npx wrangler tail starter-app --format json`.
- **API:** the Workers Observability query API, which the dashboard and the MCP server below both use.
- **Grouped failures:** Workers Issues groups recurring errors. Turn it on with `observability.issues.enabled` if you want it.

On the Free plan Workers Logs keeps 200,000 events a day for 3 days; from 1 December 2026 that becomes 0.5 GB a day for 7 days.

## Ask an AI assistant: Cloudflare's MCP servers

Cloudflare runs remote MCP servers that an assistant such as Claude Code, Cursor or VS Code can connect to. Two are useful here:

| Server | URL | Use it for |
|---|---|---|
| Observability | `https://observability.mcp.cloudflare.com/mcp` | Querying your Workers logs and analytics |
| Cloudflare API (Code Mode) | `https://mcp.cloudflare.com/mcp` | Anything else in your account through the API |

Add the observability server to your client. For Claude Code:

```
claude mcp add --transport http cloudflare-observability https://observability.mcp.cloudflare.com/mcp
```

The first call opens a browser to sign in to Cloudflare and choose an account. Then ask in plain language, for example:

- "List the Workers in my account and show the last hour of logs for starter-app."
- "How many auth.request events with status 403 and code VERIFICATION_FAILED in the last day?"
- "Show error.unhandled events since yesterday, grouped by path."
- "Find the log line for ray id <id from a user's cf-ray header>."

The assistant reads through the same query API as the dashboard and sees only what your Cloudflare login can see.

A word on access: the API server can change things in your account if your login allows it. Use a Cloudflare login or token scoped to read-only for day-to-day questions, and keep changes going through Terraform.
