# Deploy

From a Cloudflare account with a domain to the first sign-in. Every app resource is created by Terraform; the Worker's secrets are set with wrangler so their values stay out of Terraform state.

## What you need

- A Cloudflare account with a domain (zone) on it.
- Terraform 1.15 or later, Node 22, pnpm.
- A Cloudflare API token, saved to a file only you can read (for example with `chmod 600`). Give it these permissions on your account: Workers Scripts Edit, Workers KV Storage Edit, Workers R2 Storage Edit, D1 Edit, Turnstile Sites Edit, Access: Apps and Policies Edit, Access: Organizations, Identity Providers, and Groups Read, and Account Analytics Read (for `scripts/cpu-report.sh`); and on your zone: Zone Read, Workers Routes Edit, Zone WAF Edit, DNS Edit.
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
scripts/tf.sh --token-file <your token file> plan -out=tfplan
scripts/plan-audit.sh --token-file <your token file>
scripts/tf.sh --token-file <your token file> apply tfplan
```

`plan-audit.sh` prints counts by action, every destroy, and which attributes each update changes, without printing the Worker's code or any secret. Read it before you apply. State stays in `infra/terraform`, gitignored and mode 600, because it holds the Turnstile widget's secret.

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

The Worker refuses to serve (503, and a `config.invalid` log event) until `BETTER_AUTH_SECRET` is set, because Better Auth would otherwise sign sessions with a public default key. Use `--script <app_name>` if you changed `app_name`.

For Google login, create an OAuth web client in Google Cloud with the redirect URI `https://<host>/api/auth/callback/google`, save the client id and secret to two files, and add `--google-id-file <file> --google-secret-file <file>`. Leave out `--rotate-auth-secret` on later runs; rotating it signs everyone out.

## 6. Rebuild with your site key and apply again

```
scripts/build-worker.sh --turnstile-sitekey "$(scripts/tf.sh --token-file <your token file> output -raw turnstile_sitekey)"
scripts/tf.sh --token-file <your token file> plan -out=tfplan
scripts/plan-audit.sh --token-file <your token file>
scripts/tf.sh --token-file <your token file> apply tfplan
```

Open `https://<host>`, sign up, and check the logs as described in [OBSERVABILITY.md](OBSERVABILITY.md).

## Check it from outside

```
export CLOUDFLARE_API_TOKEN="$(cat <your token file>)" CLOUDFLARE_ACCOUNT_ID=<account id>
node scripts/smoke.mjs deployed-anon https://<host>
```

If you changed `app_name`, add `D1_NAME=<app_name>-db` in front of the `node` command.

## Tear it down

```
scripts/teardown-prepare.sh --token-file <your token file> --account <account id>
scripts/tf.sh --token-file <your token file> apply tfplan-destroy
```

The first command empties the R2 bucket and writes a destroy plan for you to read. The second deletes everything, including the database. Afterwards delete `infra/terraform/terraform.tfstate*` and every `infra/terraform/tfplan*` file: state and saved plans both hold the Turnstile secret.
