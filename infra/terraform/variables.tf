variable "account_id" {
  description = "Cloudflare account id."
  type        = string
}

variable "app_name" {
  description = "Prefix for every resource name: Worker, database, bucket, KV namespace, widget, Access app."
  type        = string
  default     = "starter-app"
}

variable "zone_name" {
  type = string
}

variable "host" {
  description = "Hostname the app is served on, inside zone_name."
  type        = string
}

variable "admin_email" {
  description = "Address allowed through Cloudflare Access to /admin, by one-time PIN."
  type        = string
}

variable "access_otp_idp_id" {
  description = "The account's one-time PIN identity provider, the only login allowed for /admin."
  type        = string
}

variable "access_team_domain" {
  type = string
}

variable "worker_bundle" {
  description = "Bundled Worker entry built by scripts/build-worker.sh."
  type        = string
  default     = "../../dist/worker/index.js"
}

variable "assets_dir" {
  type    = string
  default = "../../dist/client"
}

# The settings below change speed and safety. The defaults are the fastest
# safe combination measured (docs/ARCHITECTURE.md); the others exist so you can
# measure the difference yourself.
variable "session_cache" {
  description = "kv puts Better Auth's session reads on KV; off reads D1 every time."
  type        = string
  default     = "kv"
  validation {
    condition     = contains(["kv", "off"], var.session_cache)
    error_message = "session_cache must be kv or off."
  }
}

# Password hashing is cut off by Workers Free's 10 ms CPU limit after a short
# burst (jadedm/sandbox#119). Turn this on only on Workers Paid; on Free, users
# sign in with Google.
variable "password_login" {
  description = "on offers email and password sign-in (needs Workers Paid); off leaves Google sign-in only."
  type        = string
  default     = "off"
  validation {
    condition     = contains(["on", "off"], var.password_login)
    error_message = "password_login must be on or off."
  }
}

variable "auth_validate_schema" {
  type    = string
  default = "on"
  validation {
    condition     = contains(["on", "off"], var.auth_validate_schema)
    error_message = "auth_validate_schema must be on or off."
  }
}

variable "auth_instance" {
  description = "isolate builds one Better Auth instance per isolate; request rebuilds it per request."
  type        = string
  default     = "isolate"
  validation {
    condition     = contains(["isolate", "request"], var.auth_instance)
    error_message = "auth_instance must be isolate or request."
  }
}

variable "placement_mode" {
  type    = string
  default = "off"
  validation {
    condition     = contains(["off", "smart"], var.placement_mode)
    error_message = "placement_mode must be off or smart."
  }
}

variable "workers_dev_enabled" {
  description = "Serve the app on workers.dev and preview URLs too. They skip the zone rate limit and Access."
  type        = bool
  default     = false
}

variable "create_rate_limit" {
  description = "Create the sign-in rate limit rule. The Free plan allows one rule per zone; set false if the zone already uses it."
  type        = bool
  default     = true
}

variable "signin_rate_limit_per_10s" {
  description = "Requests per IP per 10 s to the sign-in route before the edge blocks: /api/auth/sign-in/email with password login on, /api/auth/sign-in/social with it off."
  type        = number
  default     = 5
}

variable "debug_timing" {
  description = "on adds Server-Timing and x-d1-statements headers to API responses, for measuring. Leave off in production."
  type        = string
  default     = "off"
  validation {
    condition     = contains(["on", "off"], var.debug_timing)
    error_message = "debug_timing must be on or off."
  }
}

# The Postgres option (#4): Supabase Postgres through Hyperdrive instead of D1.
# Nothing below is created while db_driver is d1.
variable "db_driver" {
  description = "d1, or pg for Supabase Postgres through Hyperdrive."
  type        = string
  default     = "d1"
  validation {
    condition     = contains(["d1", "pg"], var.db_driver)
    error_message = "db_driver must be d1 or pg."
  }
}

variable "supabase_host" {
  description = "The direct connection host, db.<project ref>.supabase.co. Hyperdrive verifies its certificate against supabase_ca_file, hostname included."
  type        = string
  default     = ""
  validation {
    condition     = var.db_driver != "pg" || length(var.supabase_host) > 0
    error_message = "db_driver = \"pg\" needs supabase_host."
  }
}

variable "supabase_database" {
  description = "The database migrations-pg was applied to. It must be one of the app's own, not a project's shared postgres database: migrations-pg/0004 takes PUBLIC's execute away from every function in public, and from functions the owner creates there later."
  type        = string
  default     = ""
  validation {
    condition     = var.db_driver != "pg" || length(var.supabase_database) > 0
    error_message = "db_driver = \"pg\" needs supabase_database, a database of the app's own."
  }
}

variable "supabase_user" {
  description = "The Worker's own role from migrations-pg/0004. Only app_worker is accepted: it is the role the migrations limit and scripts/set-worker-password.mjs gives a password."
  type        = string
  default     = "app_worker"
  validation {
    condition     = var.supabase_user == "app_worker"
    error_message = "supabase_user must be app_worker, the role migrations-pg/0004 creates and limits; any other role, the owner postgres included, has not been limited."
  }
}

variable "supabase_password" {
  description = "app_worker's password, from scripts/set-worker-password.mjs. Set through TF_VAR_supabase_password from that file, never on a command line. It is stored in Terraform state, which stays local and mode 600."
  type        = string
  default     = ""
  sensitive   = true
  validation {
    condition     = var.db_driver != "pg" || length(var.supabase_password) > 0
    error_message = "db_driver = \"pg\" needs supabase_password (TF_VAR_supabase_password)."
  }
}

variable "supabase_ca_file" {
  description = "PEM of the CA Hyperdrive verifies Supabase's certificate against. From the Supabase dashboard: Database Settings, SSL Configuration."
  type        = string
  default     = "certs/supabase-ca-2021.crt"
  validation {
    condition     = var.db_driver != "pg" || var.supabase_ca_certificate_id != "" || fileexists(var.supabase_ca_file)
    error_message = "supabase_ca_file does not exist (it is not needed when supabase_ca_certificate_id is set)."
  }
}

variable "supabase_ca_certificate_id" {
  description = "Optional. The id of a CA certificate already on the account (GET /accounts/<id>/mtls_certificates) to verify Supabase against, instead of uploading supabase_ca_file. Needed for a second app on an account that already holds Supabase's CA, since the account refuses a second copy. The certificate then belongs to the other app: destroying that app's copy breaks this one's connection. Never give this app's own certificate id: the plan would point Hyperdrive at it and then destroy it."
  type        = string
  default     = ""
  validation {
    condition     = can(regex("^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?$", var.supabase_ca_certificate_id))
    error_message = "supabase_ca_certificate_id must be a certificate id (a UUID), or empty to upload supabase_ca_file."
  }
}
