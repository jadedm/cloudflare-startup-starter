# Deploy

From a Cloudflare account with a domain to the first sign-in. Every app resource is created by Terraform; the Worker's secrets are set with wrangler so their values stay out of Terraform state. State does hold two secrets: the Turnstile widget's secret, which Terraform creates, and with the Postgres option the database password, which Hyperdrive's configuration needs.

## What you need

- A Cloudflare account with a domain (zone) on it.
- Terraform 1.15 or later, Node 22, pnpm.
- A Cloudflare API token, saved to a file only you can read (for example with `chmod 600`). Give it these permissions on your account: Workers Scripts Edit, Workers KV Storage Edit, Workers R2 Storage Edit, D1 Edit, Turnstile Sites Edit, Access: Apps and Policies Edit, Access: Organizations, Identity Providers, and Groups Read, and Account Analytics Read (for `scripts/cpu-report.sh`); and on your zone: Zone Read, Workers Routes Edit, Zone WAF Edit, DNS Edit. For the Postgres option, add Hyperdrive Edit and Account: SSL and Certificates Edit on the account (the second uploads Supabase's CA certificate).
- Cloudflare Zero Trust set up on the account, with a team domain and the One-time PIN login method turned on. The Zero Trust Free plan can still ask for a payment method when you set it up. Find the One-time PIN method's id with:

  ```
  curl -s "https://api.cloudflare.com/client/v4/accounts/<account id>/access/identity_providers" \
    -H @<(printf 'Authorization: Bearer %s\n' "$(cat <your token file>)") | jq -r '.result[] | "\(.type) \(.id)"'
  ```

Before you start, check two things about the zone:

- **Its rate limit rule.** A Free zone allows one rate limit rule. If the zone already has one, from the dashboard or another app, set `create_rate_limit = false` in `terraform.tfvars`, or the apply fails. Do not import the existing ruleset to get past that; the apply would then replace your rule.
- **The hostname.** If `host` already has a DNS record, the custom domain cannot be attached. Pick an unused hostname or remove the record.

## 1. Fill in your values

```
cp infra/terraform/terraform.tfvars.example infra/terraform/terraform.tfvars
```

Edit `terraform.tfvars`. It is gitignored. `host` is the hostname the app will answer on, inside `zone_name`.

## 2. Build

The Worker is bundled locally and Terraform uploads the bundle. The frontend needs the Turnstile site key, which exists only after the first apply, so the first build uses Cloudflare's test key and the second uses yours.

```
pnpm install
scripts/build-worker.sh --turnstile-sitekey 1x00000000000000000000AA
```

## 3. Plan, read, apply

```
scripts/tf.sh --token-file <your token file> init
scripts/tf.sh --token-file <your token file> --first-deploy plan -out=tfplan
scripts/plan-audit.sh --token-file <your token file>
scripts/tf.sh --token-file <your token file> apply tfplan
```

`--first-deploy` lets this one plan carry the test site key. `tf.sh` refuses a build with a test key otherwise, and refuses it even with the flag once the Turnstile widget is in state, so a test build cannot reach a live site by accident.

`plan-audit.sh` prints counts by action, every destroy, and which attributes each update changes, without printing the Worker's code or any secret. Read it before you apply. State stays in `infra/terraform`, gitignored and mode 600, because it holds the Turnstile widget's secret and, with Postgres, the database password.

After every apply, `tf.sh` also turns on the Worker's `redact_query_string` setting, so its logs keep request URLs without their query strings; the Google callback carries a one-time sign-in code there. The Terraform provider has no field for this setting, so it is set through the API. If that step fails, `tf.sh` exits 1 even though the apply went through. Fix the error it prints, then plan and apply again: the saved plan is spent, and an apply with nothing to change still runs the step. The step also runs after an apply that fails, or that you decline at the prompt, if the Worker is already in state; it only ever turns redaction on.

The first apply puts the Worker on your hostname before the database has tables and before the secrets exist. Until steps 4 and 5 are done, the auth routes answer 500 or 503. That is expected.

## 4. Migrate the database

```
scripts/migrate-remote.sh --token-file <your token file> --account <account id>
```

`wrangler.jsonc` holds a placeholder database id for local development, so running `wrangler d1 migrations apply --remote` from the repo would target a database that does not exist. The script takes the real id and name from Terraform and applies `migrations/` to it.

## 5. Set the secrets

```
scripts/secrets.sh --token-file <your token file> --account <account id> --script starter-app --rotate-auth-secret
```

The Worker refuses to serve (503, and a `config.invalid` log event) until `BETTER_AUTH_SECRET` is set to at least 32 characters (the script generates 64), because Better Auth would otherwise sign sessions with a public default key. Use `--script <app_name>` if you changed `app_name`.

With the default `password_login = "off"`, Google is the only sign-in method, so set it up here or the site offers no way to sign in (the Worker logs `config.invalid`). Password login needs Workers Paid: on Free, password hashing is cut off by the 10 ms CPU limit after a short burst.

For Google login, create an OAuth web client in Google Cloud with the redirect URI `https://<host>/api/auth/callback/google`, save the client id and secret to two files, and add `--google-id-file <file> --google-secret-file <file>`. Leave out `--rotate-auth-secret` on later runs; rotating it signs everyone out. The redirect URI goes under "Authorised redirect URIs"; "Authorised JavaScript origins" is not needed, and Google can take a few minutes to apply the change.

A new Google OAuth app starts in testing, where only the test users you list (up to 100) can sign in. The starter asks Google only for `openid`, `email` and `profile`, so you can publish the app (Google Auth Platform, Audience, Publish app) without Google's verification review, and then any Google account can sign in. Showing your app's name or logo on Google's consent screen does need brand verification. These rules come from Google's help pages ([Manage App Audience](https://support.google.com/cloud/answer/15549945), [brand verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/brand-verification)), checked on 21 October 2026; check them again before you publish.

## 6. Rebuild with your site key and apply again

```
scripts/build-worker.sh --turnstile-sitekey "$(scripts/tf.sh --token-file <your token file> output -raw turnstile_sitekey)"
scripts/tf.sh --token-file <your token file> plan -out=tfplan
scripts/plan-audit.sh --token-file <your token file>
scripts/tf.sh --token-file <your token file> apply tfplan
```

Open `https://<host>`, sign in with Google (or sign up with a password, if you turned password login on), and check the logs as described in [OBSERVABILITY.md](OBSERVABILITY.md).

## Postgres instead of D1

The same app with its tables in a Supabase Postgres database, reached through Hyperdrive. Terraform still creates the D1 database; it stays empty. Before step 2, run `pnpm install` (the setup script needs the `pg` package), then:

1. **Create a Supabase project**, and save its owner password (the `postgres` user's) to a file only you can read. You need the direct connection host, `db.<project ref>.supabase.co`, port 5432. Without Supabase's IPv4 add-on that host had only an IPv6 address when this was written (October 2026), so the machine that runs the setup needs IPv6.
2. **Check the CA certificate.** Hyperdrive verifies the database's certificate, hostname included, against `infra/terraform/certs/supabase-ca-2021.crt`. Compare it with the one in the Supabase dashboard (Database Settings, SSL Configuration). If yours differs, use it in both places: `--ca-file` below (a path from where you run the command) and `supabase_ca_file` in `terraform.tfvars` (a path from `infra/terraform`).
3. **Network restrictions.** If the project restricts database access by IP, Hyperdrive connects from Cloudflare's ranges ([cloudflare.com/ips](https://www.cloudflare.com/ips/)), so allow those, and allow your own address while the next step runs.
4. **Set up the database**, as the owner:

   ```
   scripts/pg-setup.sh --host db.<project ref>.supabase.co --database <app database> \
     --owner-password-file <owner password file> \
     --ca-file infra/terraform/certs/supabase-ca-2021.crt --out <new worker password file>
   ```

   It creates the app's database if it is missing, applies `migrations-pg/`, and gives the Worker's role, `app_worker`, a new random password in the `--out` file (mode 600). Use a database of the app's own, not the project's `postgres` database: the migrations take PUBLIC's execute right away from every function in its `public` schema. A second run applies only new migrations, then stops at the password step because the `--out` file exists; use `scripts/migrate-pg.mjs` for later migrations.
5. **Add to `terraform.tfvars`:** `db_driver = "pg"`, `supabase_host` and `supabase_database` (the commented block in `terraform.tfvars.example` lists them). Pass the password through the environment, never on a command line:

   ```
   export TF_VAR_supabase_password="$(cat <new worker password file>)"
   ```

   Every plan needs it, so export it again in any new shell before a plan, including the teardown. Without it the plan stops with `db_driver = "pg" needs supabase_password`.

Then follow steps 2 to 6 and skip step 4, which migrates D1.

If the account already holds Supabase's CA certificate, for example from a second app on the same account, Cloudflare refuses another copy (seen on 20 October 2026). Set `supabase_ca_certificate_id` to the existing certificate's id (`GET /accounts/<account id>/mtls_certificates`) and nothing is uploaded. That certificate then belongs to the other app, and destroying it there breaks this one.

The destroy below removes the Hyperdrive configuration and the certificate this app uploaded. The Supabase database, its tables and the `app_worker` role stay; drop them in Supabase.

## Check it from outside

```
export CLOUDFLARE_API_TOKEN="$(cat <your token file>)" CLOUDFLARE_ACCOUNT_ID=<account id>
node scripts/smoke.mjs deployed-anon https://<host>
```

If you changed `app_name`, add `D1_NAME=<app_name>-db` in front of the `node` command. Cases 4 and 5 check that no user row was created, which on D1 is read with wrangler.

On Postgres, skip the `export` line above: the rows are read from the database instead, as the owner, with the certificate verified as in "Postgres instead of D1". If the project restricts database access by IP, allow your address while it runs.

```
SMOKE_DB=pg SMOKE_PG_HOST=db.<project ref>.supabase.co SMOKE_PG_DATABASE=<app database> SMOKE_PG_OWNER_PASSWORD_FILE=<owner password file> \
  SMOKE_PG_CA_FILE=infra/terraform/certs/supabase-ca-2021.crt node scripts/smoke.mjs deployed-anon https://<host>
```

`SMOKE_PG_DATABASE` is the database `pg-setup.sh` created and has no default. `SMOKE_PG_PORT` and `SMOKE_PG_OWNER` default to 5432 and `postgres`. Without `SMOKE_DB=pg`, a Postgres deploy fails cases 4 and 5 with a note that D1 has no tables. A row read that fails marks only its case as failed; the rest of the group still runs.

## Tear it down

On Postgres, export `TF_VAR_supabase_password` first, as in "Postgres instead of D1": the destroy plan needs it.

```
scripts/teardown-prepare.sh --token-file <your token file> --account <account id>
scripts/tf.sh --token-file <your token file> apply tfplan-destroy
```

The first command deletes every avatar from the R2 bucket, found by listing the bucket, and writes a destroy plan for you to read. It stops without a plan if anything is left in the bucket: an object outside `avatars/`, which the app never writes and the script does not delete, or an avatar uploaded while it ran. Cloudflare's API allows 1,200 R2 calls per five minutes, so with more avatars than that the script pauses when it is rate limited and carries on. The site stays up until the destroy, so an upload after the script finishes also makes the destroy fail on the bucket; run the first command again. The second deletes everything, including the database. Afterwards delete `infra/terraform/terraform.tfstate*` and every `infra/terraform/tfplan*` file: state and saved plans both hold the Turnstile secret and, on Postgres, the database password.

## Troubleshooting

**`Provider produced inconsistent result after apply` on `cloudflare_workers_script.app`, about `startup_time_ms`.** Seen with provider 5.28.0 on an update that changed only the frontend: the plan assumed the Worker's measured startup time would not change, and Cloudflare reported a new one. The deploy itself goes through. Confirm with a fresh plan: if it shows no change to `cloudflare_workers_script.app`, the new version is live and state is consistent.

**`cloudflare_d1_database.main` shows an update on every plan.** The provider marks `file_size`, `num_tables` and `version` as unknown each time. Applying it changes nothing.
