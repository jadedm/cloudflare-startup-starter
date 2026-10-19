# Contributing

Issues and pull requests are welcome.

- Open an issue first for anything larger than a small fix, so the approach can be agreed before the work.
- Run `pnpm typecheck` and `scripts/local-suite.sh` before opening a pull request, and say in the PR which cases you ran.
- A change to a security check (auth, Origin, Access, uploads, logging) needs a test that fails when the check is removed.
- Terraform changes: include the output of `scripts/plan-audit.sh` for a plan against a test account, with ids removed.
- Never commit `.dev.vars`, `terraform.tfvars`, Terraform state or plans, or any token.
