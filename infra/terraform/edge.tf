data "cloudflare_zone" "app" {
  filter = { name = var.zone_name }
}

resource "cloudflare_workers_custom_domain" "app" {
  account_id = var.account_id
  zone_id    = data.cloudflare_zone.app.zone_id
  hostname   = var.host
  service    = cloudflare_workers_script.app.script_name
}

# Sign-in rate limit at the edge. The Free plan allows one rate limiting rule per zone, a 10 s period
# and timeout, counting by IP and colo, Block only, and only the Path and
# Verified Bot fields in the expression: no host and no method. So this rule
# applies to this path on every hostname in the zone.
# A zone has one rate limit phase entrypoint. If yours already has a rule
# (from the dashboard or another app), set create_rate_limit = false, or this
# apply fails; importing the existing ruleset would replace your rule.
resource "cloudflare_ruleset" "rate_limit" {
  count   = var.create_rate_limit ? 1 : 0
  zone_id = data.cloudflare_zone.app.zone_id
  name    = "${var.app_name} rate limits"
  kind    = "zone"
  phase   = "http_ratelimit"

  rules = [{
    description = "Sign-in attempts per IP"
    # With password login off, sign-in/email answers 404 at the Worker, so the
    # zone's one rule goes to sign-in/social, which writes a state row per call.
    expression = var.password_login == "on" ? "(http.request.uri.path eq \"/api/auth/sign-in/email\")" : "(http.request.uri.path eq \"/api/auth/sign-in/social\")"
    action     = "block"
    ratelimit = {
      characteristics     = ["ip.src", "cf.colo.id"]
      period              = 10
      requests_per_period = var.signin_rate_limit_per_10s
      mitigation_timeout  = 10
    }
  }]
}

# Access covers this hostname's /admin paths only; the Worker also
# verifies the Access token itself, because workers.dev bypasses Access.
resource "cloudflare_zero_trust_access_policy" "admin" {
  account_id = var.account_id
  name       = "${var.app_name} admin"
  decision   = "allow"
  include    = [{ email = { email = var.admin_email } }]
  # Without this an Access session from another login method would also pass.
  require = [{ login_method = { id = var.access_otp_idp_id } }]
}

resource "cloudflare_zero_trust_access_application" "admin" {
  account_id       = var.account_id
  name             = "${var.app_name} admin"
  type             = "self_hosted"
  domain           = "${var.host}/admin"
  destinations     = [{ type = "public", uri = "${var.host}/admin" }]
  session_duration = "1h"
  # The policy names an email; this makes one-time PIN the only way to prove it.
  allowed_idps              = [var.access_otp_idp_id]
  auto_redirect_to_identity = true
  policies                  = [{ id = cloudflare_zero_trust_access_policy.admin.id, precedence = 1 }]
}
