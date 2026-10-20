# The Postgres option (#4): Supabase Postgres through Hyperdrive. Created only
# when db_driver = "pg". The password lands in Terraform state (the origin
# block needs it), which stays local, gitignored and mode 600.

# Supabase signs its database certificates with its own CA, so Hyperdrive's
# default require mode would connect without checking them. The CA is uploaded
# to the account and the config verifies against it, hostname included, which
# holds for the direct host db.<ref>.supabase.co (jadedm/sandbox#114).
# The certificate cannot be updated in place, so a new file replaces it. The
# replacement is created before the old one is destroyed, so the live config
# never points at a deleted certificate, and the name carries a hash of the
# file because names must be unique. The account refuses a second copy of the
# same certificate, so changing app_name, which renames it with the same file,
# cannot go through create-first: destroy the old certificate with the
# Hyperdrive config first, or keep app_name. For the same reason a second app
# on an account that already holds this CA cannot upload it again; it reuses
# the existing one through supabase_ca_certificate_id, and nothing is uploaded.
resource "cloudflare_mtls_certificate" "supabase_ca" {
  count        = var.db_driver == "pg" && var.supabase_ca_certificate_id == "" ? 1 : 0
  account_id   = var.account_id
  name         = "${var.app_name}-supabase-ca-${substr(sha256(file(var.supabase_ca_file)), 0, 8)}"
  ca           = true
  certificates = file(var.supabase_ca_file)

  lifecycle {
    create_before_destroy = true
  }
}

resource "cloudflare_hyperdrive_config" "supabase" {
  count      = var.db_driver == "pg" ? 1 : 0
  account_id = var.account_id
  name       = "${var.app_name}-supabase"

  origin = {
    scheme   = "postgres"
    host     = var.supabase_host
    port     = 5432
    database = var.supabase_database
    user     = var.supabase_user
    password = var.supabase_password
  }

  # Hyperdrive caches read query results by default. A cached session lookup
  # would keep a signed-out session working, so caching is off.
  caching = {
    disabled = true
  }

  mtls = {
    ca_certificate_id = var.supabase_ca_certificate_id != "" ? var.supabase_ca_certificate_id : one(cloudflare_mtls_certificate.supabase_ca[*].id)
    sslmode           = "verify-full"
  }
}
