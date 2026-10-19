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
  type    = string
  default = "off"
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
  description = "Requests per IP per 10 s to POST /api/auth/sign-in/email before the edge blocks."
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
