# cloudflare-startup-starter

A small app that runs entirely on Cloudflare, with sign-up and login, a database, file uploads, bot protection, an admin area and logs, set up with Terraform. It is meant as day zero for a startup: clone it, point it at your Cloudflare account, and have a real, tested app on your own domain the same day.

Everything here was built and tested on the Workers Free plan and a Free zone. The settings that matter, and why, are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## What you get

| Piece | What it does |
|---|---|
| Worker with Static Assets | Serves a React frontend and the API from one deploy |
| Better Auth on D1 | Email and password, Google login, sessions in a SQLite database |
| KV | Caches sessions so signed-in requests do not wait on the database |
| R2 | Private file storage, served only through the Worker |
| Turnstile | Bot check on sign-up and sign-in, verified server-side |
| Rate limit rule | Blocks sign-in floods at the edge, before the Worker runs |
| Access | One-time PIN login in front of `/admin` |
| Workers Logs | One JSON event per auth result, refusal and error, with no personal data |
| Terraform | Every Cloudflare resource above, from an empty account |

## What it costs

$0 on the Workers Free plan while you test. Move to Workers Paid ($5 a month) before real users arrive: sign-up and sign-in use more CPU than the Free plan's 10 ms per request allows, and Free only tolerates that at low volume. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) lists the Free plan limits that apply.

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
infra/terraform/   every Cloudflare resource
scripts/           build, deploy helpers, tests, teardown
docs/              architecture, deploy, testing, observability
```

## Licence

MIT. See [LICENSE](LICENSE).
