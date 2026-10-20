import { betterAuth } from "better-auth";
import { captcha } from "better-auth/plugins";
import type { SecondaryStorage } from "better-auth";
import type pg from "pg";
import type { Env } from "./env";
import type { Bindings } from "./bindings";
import { errorKindOf, logEvent } from "./log";

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
// stay in the database, D1 or Postgres (see verification and rateLimit
// below); these two methods throw
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
        logEvent("warn", "cache.kv_failed", { op: "get", error: errorKindOf(e) });
        return [null] as const;
      },
    );
    return value;
  },
  async set(key, value, ttl) {
    const expirationTtl = Math.max(Math.min(ttl ?? maxTtl, maxTtl), KV_MIN_TTL);
    await kv.put(key, value, { expirationTtl }).catch((e: unknown) => {
      logEvent("warn", "cache.kv_failed", { op: "put", error: errorKindOf(e) });
    });
  },
  async delete(key) {
    await kv.delete(key).catch((e: unknown) => {
      logEvent("warn", "cache.kv_failed", { op: "delete", error: errorKindOf(e) });
    });
  },
});

// Workers Free stops password hashing at its 10 ms CPU limit after a short
// burst (jadedm/sandbox#119), so password login is on only when PASSWORD_LOGIN
// is exactly "on", which needs Workers Paid. Anything else counts as off.
export const passwordLoginOn = (env: Env) => env.PASSWORD_LOGIN === "on";

// Better Auth's own switch guards sign-up and sign-in only; the other routes
// that hash or check a password ignore it. disabledPaths refuses all of them
// with 404 before the captcha check or any query. The paths are relative to
// basePath. GET /reset-password/:token cannot be listed (exact matches only),
// but it hashes nothing and no reset token can be issued with this list in place.
const PASSWORD_PATHS = [
  "/sign-up/email",
  "/sign-in/email",
  "/change-password",
  "/reset-password",
  "/request-password-reset",
  "/verify-password",
  "/delete-user",
];

export const googleOn = (env: Env) => Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);

const googleProvider = (env: Env) => {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return {};
  return { google: { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET } };
};

// The siteverify fault points at a closed local port to simulate an outage.
const siteVerifyOverride = (env: Env) =>
  env.FAULT === "siteverify" ? "http://127.0.0.1:9/siteverify" : undefined;

// On D1 the instance is kept per isolate, so the schema check runs once. On
// Postgres the instance is per request (authFor), so the check would run on
// every request; it is off there unless AUTH_VALIDATE_SCHEMA is exactly "on".
const schemaCheckOn = (env: Env, pool: pg.Pool | null): boolean => {
  if (pool) return env.AUTH_VALIDATE_SCHEMA === "on";
  return env.AUTH_VALIDATE_SCHEMA !== "off";
};

// pool is the request's Postgres pool on DB_DRIVER=pg, null on D1.
export const createAuth = (env: Env, b: Bindings, pool: pg.Pool | null) =>
  betterAuth({
    database: pool ?? b.db,
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    basePath: "/api/auth",
    trustedOrigins: [env.BETTER_AUTH_URL],
    emailAndPassword: { enabled: passwordLoginOn(env) },
    disabledPaths: passwordLoginOn(env) ? [] : PASSWORD_PATHS,
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
      database: { validateSchema: schemaCheckOn(env, pool) },
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

// Drops this isolate's instance so the next request builds a fresh one. Only
// the instance that timed out: a request still waiting on an old instance must
// not throw away the newer one another request has since built.
export const forgetAuth = (env: Env, auth: Auth) => {
  if (authCache.get(env.DB) === auth) authCache.delete(env.DB);
};

// A Postgres pool is made per request (pg.ts), so an instance built on it
// cannot outlive the request either, and is never cached.
export const authFor = (env: Env, b: Bindings, pool: pg.Pool | null): Auth => {
  if (pool || env.AUTH_INSTANCE === "request") return createAuth(env, b, pool);
  const cached = authCache.get(env.DB);
  if (cached) return cached;
  const built = createAuth(env, b, null);
  authCache.set(env.DB, built);
  return built;
};
