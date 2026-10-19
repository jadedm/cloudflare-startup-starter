locals {
  # Spelled out in full: with only enabled = true, Cloudflare fills in these
  # defaults and every plan shows the Worker changing.
  observability = {
    enabled            = true
    head_sampling_rate = 1
    logs               = { enabled = true, head_sampling_rate = 1, invocation_logs = true, persist = true }
    traces             = { enabled = false, head_sampling_rate = 1, persist = true }
  }
}

resource "cloudflare_workers_script" "app" {
  account_id          = var.account_id
  script_name         = var.app_name
  main_module         = "index.js"
  content_file        = var.worker_bundle
  content_sha256      = filesha256(var.worker_bundle)
  compatibility_date  = "2026-10-13"
  compatibility_flags = ["nodejs_compat"]

  assets = {
    directory = var.assets_dir
    config = {
      not_found_handling = "single-page-application"
      # Without this a browser navigation to /api/auth/callback/google is
      # served index.html and the Worker never sees the OAuth code.
      run_worker_first = ["/api/*", "/admin", "/admin/*"]
    }
  }

  bindings = [
    { type = "d1", name = "DB", id = cloudflare_d1_database.main.id },
    { type = "kv_namespace", name = "SESSIONS", namespace_id = cloudflare_workers_kv_namespace.sessions.id },
    { type = "r2_bucket", name = "UPLOADS", bucket_name = cloudflare_r2_bucket.uploads.name },
    { type = "assets", name = "ASSETS" },
    { type = "plain_text", name = "APP_ENV", text = "deployed" },
    { type = "plain_text", name = "BETTER_AUTH_URL", text = "https://${var.host}" },
    { type = "plain_text", name = "SESSION_CACHE", text = var.session_cache },
    { type = "plain_text", name = "SESSION_CACHE_MAX_TTL", text = "300" },
    { type = "plain_text", name = "COOKIE_CACHE", text = "off" },
    { type = "plain_text", name = "AUTH_VALIDATE_SCHEMA", text = var.auth_validate_schema },
    { type = "plain_text", name = "AUTH_INSTANCE", text = var.auth_instance },
    { type = "plain_text", name = "PASSWORD_LOGIN", text = var.password_login },
    { type = "plain_text", name = "TURNSTILE_ALLOWED_HOSTNAMES", text = var.host },
    { type = "plain_text", name = "ACCESS_TEAM_DOMAIN", text = var.access_team_domain },
    { type = "plain_text", name = "ACCESS_AUD", text = cloudflare_zero_trust_access_application.admin.aud },
    { type = "plain_text", name = "DEBUG_TIMING", text = var.debug_timing },
    { type = "plain_text", name = "FAULT", text = "" },
  ]

  # BETTER_AUTH_SECRET, TURNSTILE_SECRET and the Google client stay with
  # wrangler secret (scripts/secrets.sh) so their values never enter state.
  keep_bindings = ["secret_text"]

  placement     = var.placement_mode == "smart" ? { mode = "smart" } : null
  observability = local.observability
}

# workers.dev and preview URLs are not covered by the zone's rate limit or
# Access, so both are off unless you turn them on for a reason.
resource "cloudflare_workers_script_subdomain" "app" {
  account_id       = var.account_id
  script_name      = cloudflare_workers_script.app.script_name
  enabled          = var.workers_dev_enabled
  previews_enabled = var.workers_dev_enabled
}
