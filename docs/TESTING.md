# Testing

`scripts/local-suite.sh` builds the app, migrates a fresh local D1 in its own folder (your `pnpm dev` data in `.wrangler/state` is left alone), then boots the compiled Worker once per configuration group and runs `scripts/smoke.mjs` against it over real HTTPS. D1 rows are read directly as ground truth, and the server's log output is checked for the expected events. Any failed case, or a group that runs no cases, exits non-zero.

```
scripts/local-suite.sh                # every group
scripts/local-suite.sh base kv        # chosen groups
```

`fault-d1` reuses a signed cookie the `base` group saves, so run it after `base` in the same command; `pg-down` and `pg-blackhole` do the same with `pg-base`.

The `pg-*` groups run the Postgres option against a local Docker Postgres, `starter-pg` on port 54330, which the suite creates or starts. Each such group gets a fresh database migrated from `migrations-pg/` as the owner, with Supabase's default grants to `anon` and `authenticated` set first, and the Worker connects as `app_worker`. Rows are read from Postgres instead of D1. Three checks need no Worker:

```
scripts/pg-checks.sh         # the worker role, what it and the Data API roles are refused, migrations, the password script, pg-setup.sh
scripts/check-pg-schema.sh   # migrations-pg/0001 matches the schema Better Auth generates for Postgres
node scripts/check-sql.mjs   # the query template numbers values per driver and leaves SQL text alone
```

`scripts/check-tf-guard.sh` needs neither Docker nor Terraform: it runs `scripts/tf.sh` against a fake `terraform` and checks that a build carrying Turnstile's test site key is refused except with `--first-deploy` on a workspace with no widget, that destroys and saved plans pass, and that state files end up mode 600 without making the workspace folder unreadable.

`scripts/check-redact-logs.sh` needs neither a Cloudflare account nor Terraform: it runs `scripts/redact-logs.mjs` against a local fake of the script settings API (`scripts/fake-script-settings-api.mjs`), and `tf.sh` in a throwaway tree with a fake `terraform` that serves state per workspace. It checks that the setting is turned on with every other setting sent back as read, that refused, malformed, ignored and stalled answers fail (the stalled case waits out the 30 s timeout), that the step runs after saved, implicit and failed applies but not after a destroy or other commands, that a named workspace changes only its own Worker, that terraform's exit code is kept, and that the token is never printed or sent anywhere but the API.

`scripts/check-empty-avatars.sh` needs neither a Cloudflare account nor Terraform: it runs `scripts/empty-avatars.mjs` against a local fake of the R2 list and delete API (`scripts/fake-r2-api.mjs`), and `teardown-prepare.sh` in a throwaway tree with a fake `terraform`. It checks that every page of avatars is listed before the first delete, that refused, malformed and looping list answers stop the run with nothing deleted, that objects outside `avatars/` are left and reported, that a failed delete leaves no destroy plan (an earlier one is removed), and that the token is never printed.

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
| 12a | kv | The signed-in check went through KV, and after sign-out the old cookie is refused at once |
| 12b | cookie-cache | Recorded, not judged: how long Better Auth's cookie cache keeps a signed-out cookie working |
| 13, 13b, 13d | base | Uploads stay private; oversized, mislabelled, chunked uploads and oversized notes are refused |
| 16-local | base | The session check reads D1 at least once (timing headers on locally) |
| 18-guard | base | The local config answering a public hostname keeps `/admin` closed |
| 19a to 19d | base | Foreign Origin, CORS preflight, cross-site writes, and cookie-bearing writes with no Origin or Referer are refused |
| 22-* | fault-* | With siteverify, D1, KV or R2 down, requests fail closed and leave no partial rows; with KV down, D1 takes over; with KV deletes failing, a signed-out session lives no longer than the cache cap |
| F8 | first-admin | On a fresh server, a first request that does not use auth (`/admin`) does not leave later sign-ups waiting forever |
| T1 | fault-d1-hang | When the first auth instance's schema check never settles, that request gets 503 after 5 s with `auth.not_ready`, and the next requests work on a fresh instance |
| P7, P24, P25, P28-on | pw-on | Password login on: advertised and working; one user for two concurrent sign-ups; wrong password and unknown user both 401 |
| P1 to P4, P6, P26, P28-off | pw-off | Password login off: every password route answers 404 before the captcha check, and no user or session is made; other auth (sessions, sign-out) still works |
| P9, P4b | pw-bad | An unknown `PASSWORD_LOGIN` value counts as off; doubled-slash paths never reach an endpoint |
| 23 | no-secret | With Better Auth's public default secret, the Worker answers 503 and logs `config.invalid` |
| S6 | base | Every outcome above leaves its structured log event, each with a request id |
| S6-error | fault-d1 | An outage shows up as an `error.unhandled` event |
| S7 | base | No email, password, session cookie name or token value, Turnstile token or auth secret appears anywhere in the server log |
| base cases, 12a, F8 | pg-base, pg-kv, pg-first-admin | The same cases on Postgres through the Worker's own role |
| PG3, PG4 | pg-invalid, pg-no-binding | An unknown `DB_DRIVER`, or `pg` with no Hyperdrive binding, makes every route answer 503 with `config.invalid` |
| PG14 | pg-down | With the database refusing connections, Better Auth's routes fail with a 5xx at once, `/api/me` answers 503 with `db.unavailable`, and `/api/auth-methods` still answers |
| PG27a | pg-blackhole | With the database address never answering, auth routes answer 503 at the 8 s deadline instead of waiting |
| PG25, PG26 | pg-extra | 20 overlapping requests on one isolate all complete while a lock holds them; the Worker's connections go back to zero after a burst, a success, a 4xx and an aborted client. Workers closes a request's sockets when it ends, so PG26 also passes with the pool's close removed: it checks the runtime as much as the code |
| PG27 | pg-extra | A write held past the database's 3 s statement timeout is cancelled (503 `db.unavailable`, and the row is not stored); a backend killed mid-request also answers 503; the next request works |
| PG28, PG12 | pg-extra | A note is stored under the session's user whatever the body says; a `?` in a value is stored as given |
| PG31 | pg-extra | With the notes table gone, notes routes answer 500 quickly and work again once it is back |
| PG22-log | pg-extra | The database password never appears in the server log |

## Against a deployed app

```
export CLOUDFLARE_API_TOKEN="$(cat <your token file>)" CLOUDFLARE_ACCOUNT_ID=<account id>
node scripts/smoke.mjs deployed-anon https://<host>
```

Covers the cases that need no login: static serving, the callback route, missing and forged Turnstile tokens, unauthenticated requests, CORS, and the Access redirect on `/admin`. With password login off, the default, cases 4 and 5 expect 404 from the password routes instead of the captcha errors; the group reads which it is from `/api/auth-methods`. Real Turnstile and Google sign-in need a browser.

## Measuring

- `debug_timing = "on"` in Terraform adds `Server-Timing` and `x-d1-statements` headers to API responses: session check time, D1 time and query count, KV time, and the edge location.
- `scripts/cpu-report.sh` reads CPU per invocation for a time window from Workers analytics, split by outcome, and exits non-zero when the window has no data.
