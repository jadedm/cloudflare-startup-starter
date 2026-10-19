import { betterAuth } from "better-auth";
import { captcha } from "better-auth/plugins";
import type { SecondaryStorage } from "better-auth";
import type { Env } from "./env";
import type { Bindings } from "./bindings";
import { logEvent } from "./log";

// A KV error message can contain the key, and the key is a session token, so
// only the error's name is logged.
const errorName = (e: unknown): string => (e instanceof Error ? e.name : "unknown");

// KV rejects expirationTtl below 60 seconds.
const KV_MIN_TTL = 60;
const KV_DEFAULT_MAX_TTL = 300;

// A missing or non-numeric setting would make every KV put fail quietly, so it
// falls back to the default; a number below KV's floor is raised to the floor.
const maxTtlFrom = (raw: string | undefined): number => {
  const n = Number(raw);
  if (!Number.isFinite(n)) return KV_DEFAULT_MAX_TTL;
  return Math.max(n, KV_MIN_TTL);
};

// KV has no atomic read-and-delete and no atomic counter, so it must never hold
// single-use verification values (OAuth state) or rate-limit counters. Those
// stay in D1 (see verification and rateLimit below); these two methods throw
// so any path that still reaches them fails loudly instead of racing.
const notOnKv = (op: string) => () => {
  throw new Error(`${op} is not safe on KV`);
};

// A failed cache read falls back to D1 and a failed cache write is skipped.
// A failed delete is logged and skipped too. Better Auth deletes from KV before
// D1, and if this threw it would abort the D1 delete while sign-out still
// returned 200, leaving the session alive. Skipping it means the D1 row goes,
// and the stale KV copy lives at most maxTtl seconds, which is why the TTL is
// capped rather than following the session's own expiry.
const kvSessionStore = (kv: KVNamespace, maxTtl: number): SecondaryStorage => ({
  getAndDelete: notOnKv("getAndDelete"),
  increment: notOnKv("increment"),
  async get(key) {
    const [value] = await kv.get(key).then(
      (v) => [v] as const,
      (e: unknown) => {
        logEvent("warn", "cache.kv_failed", { op: "get", error: errorName(e) });
        return [null] as const;
      },
    );
    return value;
  },
  async set(key, value, ttl) {
    const expirationTtl = Math.max(Math.min(ttl ?? maxTtl, maxTtl), KV_MIN_TTL);
    await kv.put(key, value, { expirationTtl }).catch((e: unknown) => {
      logEvent("warn", "cache.kv_failed", { op: "put", error: errorName(e) });
    });
  },
  async delete(key) {
    await kv.delete(key).catch((e: unknown) => {
      logEvent("warn", "cache.kv_failed", { op: "delete", error: errorName(e) });
    });
  },
});

const googleProvider = (env: Env) => {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return {};
  return { google: { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET } };
};

// The siteverify fault points at a closed local port to simulate an outage.
const siteVerifyOverride = (env: Env) =>
  env.FAULT === "siteverify" ? "http://127.0.0.1:9/siteverify" : undefined;

export const createAuth = (env: Env, b: Bindings) =>
  betterAuth({
    database: b.db,
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    basePath: "/api/auth",
    trustedOrigins: [env.BETTER_AUTH_URL],
    emailAndPassword: { enabled: true },
    socialProviders: googleProvider(env),
    secondaryStorage:
      env.SESSION_CACHE === "kv" ? kvSessionStore(b.sessions, maxTtlFrom(env.SESSION_CACHE_MAX_TTL)) : undefined,
    verification: { storeInDatabase: true },
    rateLimit: { enabled: true, storage: "database" },
    session: {
      storeSessionInDatabase: true,
      cookieCache: { enabled: env.COOKIE_CACHE === "on", maxAge: 60 },
    },
    advanced: {
      ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
      database: { validateSchema: env.AUTH_VALIDATE_SCHEMA !== "off" },
    },
    plugins: [
      captcha({
        provider: "cloudflare-turnstile",
        secretKey: env.TURNSTILE_SECRET,
        allowedHostnames: env.TURNSTILE_ALLOWED_HOSTNAMES.split(",").filter(Boolean),
        siteVerifyURLOverride: siteVerifyOverride(env),
      }),
    ],
  });

export type Auth = ReturnType<typeof createAuth>;

// Better Auth caches its runtime schema check per instance, so one instance per
// request repeats the check on every request. Every option here comes from the
// deployment's env, which is the same for every request an isolate serves, so
// one instance per isolate is safe. AUTH_INSTANCE=request keeps the old
// behaviour for comparison.
const authCache = new WeakMap<D1Database, Auth>();

export const authFor = (env: Env, b: Bindings): Auth => {
  if (env.AUTH_INSTANCE === "request") return createAuth(env, b);
  const cached = authCache.get(env.DB);
  if (cached) return cached;
  const built = createAuth(env, b);
  authCache.set(env.DB, built);
  return built;
};
