resource "cloudflare_d1_database" "main" {
  account_id = var.account_id
  name       = "${var.app_name}-db"
  # Schema changes go through wrangler d1 migrations, not Terraform.
}

resource "cloudflare_workers_kv_namespace" "sessions" {
  account_id = var.account_id
  title      = "${var.app_name}-sessions"
}

resource "cloudflare_r2_bucket" "uploads" {
  account_id = var.account_id
  name       = "${var.app_name}-uploads"
}

# The bucket is reachable only through the Worker, never on a public URL.
resource "cloudflare_r2_managed_domain" "uploads" {
  account_id  = var.account_id
  bucket_name = cloudflare_r2_bucket.uploads.name
  enabled     = false
}

# The widget's secret is an attribute of this resource, so it is in state.
# State stays local, gitignored and mode 600 (scripts/tf.sh).
resource "cloudflare_turnstile_widget" "app" {
  account_id = var.account_id
  name       = var.app_name
  domains    = [var.host]
  mode       = "managed"
}
