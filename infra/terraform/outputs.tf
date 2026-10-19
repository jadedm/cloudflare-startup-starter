output "turnstile_sitekey" {
  value = cloudflare_turnstile_widget.app.sitekey
}

output "turnstile_secret" {
  value     = cloudflare_turnstile_widget.app.secret
  sensitive = true
}

output "access_aud" {
  value = cloudflare_zero_trust_access_application.admin.aud
}

output "d1_database_id" {
  value = cloudflare_d1_database.main.id
}

output "d1_database_name" {
  value = cloudflare_d1_database.main.name
}

output "r2_bucket_name" {
  value = cloudflare_r2_bucket.uploads.name
}

output "kv_namespace_id" {
  value = cloudflare_workers_kv_namespace.sessions.id
}
