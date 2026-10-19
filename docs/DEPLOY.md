# Deploy

From an empty Cloudflare account to the first sign-in. Every resource is created by Terraform; the Worker's secrets are set with wrangler so their values stay out of Terraform state.

## What you need

- A Cloudflare account with a domain (zone) on it.
- Terraform 1.15 or later, Node 22, pnpm.
- A Cloudflare API token, saved to a file only you can read (for example with `chmod 600`). Give it these permissions on your account: Workers Scripts Edit, Workers KV Storage Edit, Workers R2 Storage Edit, D1 Edit, Turnstile Sites Edit, Access: Apps and Policies Edit, Access: Organizations, Identity Providers, and Groups Read; and on your zone: Zone Read, Workers Routes Edit, Zone WAF Edit, DNS Edit.
- In Cloudflare Zero Trust, a team domain and the One-time PIN login method turned on. Copy the One-time PIN method's id; Terraform needs it.

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

## 4. Migrate the database

```
CLOUDFLARE_API_TOKEN="$(cat <your token file>)" CLOUDFLARE_ACCOUNT_ID=<account id> \
  npx wrangler d1 migrations apply starter-app-db --remote
```

Use `<app_name>-db` if you changed `app_name`.

## 5. Set the secrets

```
scripts/secrets.sh --token-file <your token file> --account <account id> --script starter-app --rotate-auth-secret
```

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

## Tear it down

```
scripts/teardown-prepare.sh --token-file <your token file> --account <account id>
scripts/tf.sh --token-file <your token file> apply tfplan-destroy
```

The first command empties the R2 bucket and writes a destroy plan for you to read. The second deletes everything, including the database. Delete `infra/terraform/terraform.tfstate*` afterwards; it still holds the Turnstile secret.
