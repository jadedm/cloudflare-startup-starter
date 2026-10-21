# cloudflare-startup-starter

A small app that runs entirely on Cloudflare, with sign-up and login, a database, file uploads, bot protection, an admin area and logs, set up with Terraform. It is meant as day zero for a startup: clone it, point it at your Cloudflare account, and have a real, tested app on your own domain the same day.

Everything here was built and tested on the Workers Free plan and a Free zone, except email and password login, which needs Workers Paid (see below). The settings that matter, and why, are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## What you get

| Piece | What it does |
|---|---|
| Worker with Static Assets | Serves a React frontend and the API from one deploy |
| Better Auth | Google sign-in, and email and password on Workers Paid; users and sessions in D1, or in Supabase Postgres through Hyperdrive |
| KV | Caches sessions so signed-in requests do not wait on the database |
| R2 | Private file storage, served only through the Worker |
| Turnstile | Bot check on email and password sign-up and sign-in, verified server-side; Google sign-in does not use it |
| Rate limit rule | Blocks sign-in floods at the edge, before the Worker runs |
| Access | One-time PIN login in front of `/admin` |
| Workers Logs | One JSON event per auth result, refusal and error; the app's events carry no personal data |
| Terraform | Every Cloudflare resource above, on an account with a domain |

## What it costs

$0 on the Workers Free plan with Google sign-in, the default. Email and password sign-in needs Workers Paid ($5 a month): hashing a password takes far more CPU than the Free plan's 10 ms per request, and in a load test on Free most sign-ups failed at two a second. Google sign-in has not been load tested. The Postgres option adds a Supabase project, which Supabase prices separately. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) lists the Free plan limits and the load test numbers.

## Which setup to pick

Two choices, made in `terraform.tfvars`:

- **Sign-in.** On Workers Free, keep `password_login = "off"`: Google is then the only way in, so people without a Google account cannot sign up. On Workers Paid you can set `password_login = "on"` to add email and password, with Turnstile on both forms.
- **Database.** D1, the default, needs nothing outside Cloudflare. Postgres (`db_driver = "pg"`) keeps the same tables in a Supabase project, reached through Hyperdrive; pick it if you want Postgres itself or your data outside Cloudflare. It takes more setup: a database, a role for the Worker, and its CA certificate ([docs/DEPLOY.md](docs/DEPLOY.md), "Postgres instead of D1").

## Run it locally

Needs Node 22 and pnpm.

```
pnpm install
scripts/dev-setup.sh
pnpm db:migrate:local
pnpm dev
```

`scripts/dev-setup.sh` writes `.dev.vars` with a random auth secret and Cloudflare's always-pass Turnstile test key. The app is then at `https://127.0.0.1:8787` with a self-signed certificate.

Run the test suite, which boots the compiled Worker once per configuration and checks each case over real HTTPS:

```
scripts/local-suite.sh
```

[docs/TESTING.md](docs/TESTING.md) explains each case.

## Deploy it

Needs Terraform 1.15 or later, a Cloudflare account, and a domain on that account. The steps, from creating an API token to the first sign-in, are in [docs/DEPLOY.md](docs/DEPLOY.md).

## See what it is doing

[docs/OBSERVABILITY.md](docs/OBSERVABILITY.md) covers the log events the Worker writes, how to query them, and how to read them from an AI assistant through Cloudflare's MCP servers.

## Layout

```
src/worker/        the Worker: routes, auth, logging, bindings
src/client/        the React frontend
migrations/        D1 schema, applied with wrangler
migrations-pg/     the same schema for Postgres, plus the Worker's role, applied by scripts/pg-setup.sh
infra/terraform/   every Cloudflare resource
scripts/           build, deploy helpers, tests, teardown
docs/              architecture, deploy, testing, observability
```

## Licence

MIT. See [LICENSE](LICENSE).
