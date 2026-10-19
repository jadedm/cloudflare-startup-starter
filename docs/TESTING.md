# Testing

`scripts/local-suite.sh` builds the app, migrates a fresh local D1, then boots the compiled Worker once per configuration group and runs `scripts/smoke.mjs` against it over real HTTPS. D1 rows are read directly as ground truth, and the server's log output is checked for the expected events. Any failed case, or a group that runs no cases, exits non-zero.

```
scripts/local-suite.sh                # every group
scripts/local-suite.sh base kv        # chosen groups
```

`fault-d1` reuses a signed cookie the `base` group saves, so run it after `base` in the same command.

## Cases

| Case | Group | What it proves |
|---|---|---|
| 1, 2 | base | The page and its assets are served without running the Worker |
| 3a | no-worker-first | Without `run_worker_first`, a browser navigation to the OAuth callback gets `index.html` (the bug this repo avoids) |
| 3b | base | With it, the callback reaches the Worker |
| 4 | base | Sign-up and sign-in without a Turnstile token are refused, no user row |
| 5, 5b, 5c | ts-fail, ts-spent, ts-host | Forged, already-used and wrong-hostname Turnstile tokens are refused |
| 6 | base | Sign-up sets an HttpOnly, Secure, SameSite=Lax cookie with no Domain |
| 6b | base | Two concurrent sign-ups for one email create one user |
| 7, 8 | base | A wrong password is refused; a right one creates a session and a new token |
| 9 | base | No cookie and a tampered cookie get 401; a valid one gets 200 |
| 10 | base | One user cannot read another user's note |
| 11 | base | Sign-out deletes the session and the old cookie stops working |
| 12a | kv | With the KV session cache, a signed-out cookie is refused at once |
| 12b | cookie-cache | Recorded, not judged: how long Better Auth's cookie cache keeps a signed-out cookie working |
| 13, 13b, 13d | base | Uploads stay private; oversized, mislabelled, chunked uploads and oversized notes are refused |
| 16-local | base | The session check reads D1 at least once (timing headers on locally) |
| 18-guard | base | The local config answering a public hostname keeps `/admin` closed |
| 19a to 19d | base | Foreign Origin, CORS preflight, cross-site writes, and cookie-bearing writes with no Origin or Referer are refused |
| 22-* | fault-* | With siteverify, D1, KV or R2 down, requests fail closed and leave no partial rows; with KV down, D1 takes over |
| S6 | base | Every outcome above leaves its structured log event, each with a request id |
| S6-error | fault-d1 | An outage shows up as an `error.unhandled` event |
| S7 | base | No email, password, session cookie, Turnstile token or auth secret appears anywhere in the server log |

## Against a deployed app

```
export CLOUDFLARE_API_TOKEN="$(cat <your token file>)" CLOUDFLARE_ACCOUNT_ID=<account id>
node scripts/smoke.mjs deployed-anon https://<host>
```

Covers the cases that need no login: static serving, the callback route, missing and forged Turnstile tokens, unauthenticated requests, CORS, and the Access redirect on `/admin`. Real Turnstile and Google sign-in need a browser.

## Measuring

- `debug_timing = "on"` in Terraform adds `Server-Timing` and `x-d1-statements` headers to API responses: session check time, D1 time and query count, KV time, and the edge location.
- `scripts/cpu-report.sh` reads CPU per invocation for a time window from Workers analytics, split by outcome, and exits non-zero when the window has no data.
