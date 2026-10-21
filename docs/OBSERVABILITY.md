# Observability

How to see what the app is doing: the events it logs, where to read them, and how to ask an AI assistant about them through Cloudflare's MCP servers.

## What the Worker logs

`src/worker/log.ts` writes one JSON object per line. Workers Logs indexes the fields, so you can filter by `event`, `status`, `code` and so on.

| Event | Level | Fields | When |
|---|---|---|---|
| `auth.request` | info, warn on 4xx, error on 5xx | `route`, `method`, `status`, `code` | Every call to `/api/auth/*`. `code` is Better Auth's error code on failure, for example `INVALID_EMAIL_OR_PASSWORD`, `VERIFICATION_FAILED` (Turnstile) or `MISSING_RESPONSE` (no Turnstile token) |
| `request.unauthenticated` | info | `resource`, `method` | An API call with no valid session (401) |
| `request.origin_rejected` | warn | `resource`, `method` | A cookie-bearing write without this app's Origin or Referer (403) |
| `upload.rejected` | warn | `reason` (`no_length`, `too_large`, `not_an_image`) | An avatar upload refused |
| `admin.access_denied` | warn | `route` | `/admin` without a valid Access token |
| `cache.kv_failed` | warn | `op`, `error` | A KV session cache read, write or delete failed; the app carried on from the database |
| `error.unhandled` | error | `resource`, `method`, `error` | Anything that became a 500 |
| `config.invalid` | error | `setting` | A required setting is missing or unsafe. For `BETTER_AUTH_SECRET`, `DB_DRIVER` (not `d1` or `pg`) and `HYPERDRIVE` (`pg` without the binding) the Worker answers 503; for `sign-in method` (password login off and no Google client) the site loads but offers no way to sign in |
| `auth.not_ready` | error | `waitedMs` | Better Auth's setup or schema check did not settle in time; the Worker answers 503 and starts a fresh auth instance on the next request |
| `db.unavailable` | error | `resource`, `method`, `error` | Postgres only. On the app's own routes (`/api/me`, notes, avatar): the session check or a notes query could not reach the database, or the database cancelled a query at its 3 s statement timeout. On any route: the request passed the 8 s Postgres deadline (`error` is `deadline`). The Worker answers 503. A database error inside `/api/auth/*` before the deadline is answered by Better Auth as a 500 and shows as `auth.request` with that status |

`resource` is which API resource the request was for (`me`, `notes`, `avatar`, or `other`), and `route` on `admin.access_denied` is the route pattern; neither is the full path, so ids in URLs stay out of these events. `error` is a fixed category (`d1` for D1 errors, otherwise the error's class name), never the message, because a message can carry a key: for the KV session cache, the key is a session token.

Every event carries `requestId`, which is Cloudflare's ray id. The same value is in the `cf-ray` response header with a location suffix added (for example `a4cfccc36bc8e1dc-MRS` in the header, `a4cfccc36bc8e1dc` in the event), so a user's report can be matched to its log line.

These events never carry an email, password, cookie, token or secret. The local test suite checks this on every run, including the actual session token values it created (cases S6 and S7 in [TESTING.md](TESTING.md)).

By default Workers Logs stores only what the Worker writes with `console.*`: these events, plus anything a library logs. Cloudflare can also store one invocation log per request, with the URL, the status and the client's network and location; set `invocation_logs = true` in `terraform.tfvars` to turn that on. It is off because of the URL. Query strings carry one-time values, such as the code on the Google sign-in callback, and the setting that keeps them out of the logs, `redact_query_string`, cannot be set through Terraform. `scripts/tf.sh` turns it on after every apply (see [DEPLOY.md](DEPLOY.md), step 3), but each apply that uploads the Worker resets it first: in two measured deploys on 21 Oct 2026, URLs were stored whole for under 6 seconds, and for longer if the step fails. With invocation logs on, that happens on every deploy that changes the Worker. A deploy made before this default (#19) had them on; its next apply turns them off. The `wrangler*.jsonc` files set them off too, so a direct `wrangler deploy` does not turn them back on.

Rate limit blocks at the edge happen before the Worker runs, so they do not appear here. Find them in the dashboard under your zone's Security events.

## Where to read them

- **Dashboard:** Workers and Pages, your Worker, Observability. Filter with the query builder, for example `event = "auth.request" AND status >= 400`.
- **Live:** `npx wrangler tail <app_name> --format json` (`starter-app` by default).
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

The first call opens a browser to sign in to Cloudflare and choose an account. Then ask in plain language. Questions that count or group events work well, for example:

- "List the Workers in my account."
- "In the last day, count starter-app's events grouped by event."
- "Count auth.request events grouped by code for the last hour."
- "How many error.unhandled events since yesterday, grouped by resource?"

Tested on 19 Oct 2026 with invocation logs on, and on 21 Oct 2026 with them off: listing Workers and counting or grouping the app's events worked. Asking the observability server to list the app's raw events failed with a parse error, because it expects invocation fields such as `outcome` or `requestId` on every event and the app's log lines do not have them. For a single log line, for example the one matching a user's ray id, use the dashboard's query builder or the Workers Observability query API instead.

The assistant reads through the same query API as the dashboard and sees only what your Cloudflare login can see.

A word on access: the API server can change things in your account if your login allows it. Use a Cloudflare login or token scoped to read-only for day-to-day questions, and keep changes going through Terraform.
