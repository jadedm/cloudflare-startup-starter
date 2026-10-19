export type Fault = "" | "d1" | "kv" | "kv-delete" | "r2" | "siteverify";

export interface Env {
  DB: D1Database;
  SESSIONS: KVNamespace;
  UPLOADS: R2Bucket;
  ASSETS: Fetcher;

  APP_ENV: "local" | "deployed";
  BETTER_AUTH_URL: string;
  BETTER_AUTH_SECRET: string;
  SESSION_CACHE: "kv" | "off";
  SESSION_CACHE_MAX_TTL: string;
  COOKIE_CACHE: "on" | "off";
  AUTH_VALIDATE_SCHEMA?: "on" | "off";
  AUTH_INSTANCE?: "isolate" | "request";
  DEBUG_TIMING?: "on" | "off";
  TURNSTILE_SECRET: string;
  TURNSTILE_ALLOWED_HOSTNAMES: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  FAULT: Fault;
}
