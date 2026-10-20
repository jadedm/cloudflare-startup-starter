import { AsyncLocalStorage } from "node:async_hooks";
import type { Env } from "./env";
import { isLocalRequest } from "./local";

// Records D1's own reported query time for every statement the request runs,
// so a measurement can read server-side D1 time rather than Worker wall time.
export interface D1Timing {
  queries: number;
  d1Ms: number;
  // First words of each statement, so a slow request shows which queries ran.
  statements: string[];
  kvOps: number;
  kvMs: number;
}

// Per-request timing lives in AsyncLocalStorage so the wrapped bindings can be
// built once per isolate. Better Auth caches its runtime schema check in a
// WeakMap keyed by the database object; a fresh wrapper per request defeated
// that cache and re-ran the check (a sqlite_master read) on every request.
export const timingStore = new AsyncLocalStorage<D1Timing>();
const currentTiming = (): D1Timing | undefined => timingStore.getStore();

// KV and R2 failures arrive as rejected promises, so this fault does too.
const failingProxy = <T extends object>(target: T, name: string): T =>
  new Proxy(target, {
    get(t, prop, recv) {
      const value = Reflect.get(t, prop, recv);
      if (typeof value !== "function") return value;
      return () => Promise.reject(new Error(`fault injected: ${name} unavailable`));
    },
  });

const timedStatement = (stmt: D1PreparedStatement, sql: string): D1PreparedStatement =>
  new Proxy(stmt, {
    get(t, prop, recv) {
      const value = Reflect.get(t, prop, recv);
      if (prop === "bind") {
        return (...args: unknown[]) => timedStatement(t.bind(...args), sql);
      }
      if (prop === "all" || prop === "run") {
        return async () => {
          const result = await (value as () => Promise<D1Result>).call(t);
          const timing = currentTiming();
          if (!timing) return result;
          timing.queries += 1;
          timing.d1Ms += result.meta?.duration ?? 0;
          timing.statements.push(sql.replace(/\s+/g, " ").slice(0, 40));
          return result;
        };
      }
      return typeof value === "function" ? value.bind(t) : value;
    },
  });

const recordBatch = (results: D1Result[]) => {
  const timing = currentTiming();
  if (!timing) return;
  timing.queries += results.length;
  timing.d1Ms += results.reduce((sum, r) => sum + (r.meta?.duration ?? 0), 0);
  timing.statements.push(`batch of ${results.length}`);
};

// prepare() and batch() both reach D1; Better Auth's schema check uses batch.
const timedDb = (db: D1Database): D1Database =>
  new Proxy(db, {
    get(t, prop, recv) {
      const value = Reflect.get(t, prop, recv);
      if (prop === "prepare") {
        return (sql: string) => timedStatement(t.prepare(sql), sql);
      }
      if (prop === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          const results = await t.batch(statements);
          recordBatch(results);
          return results;
        };
      }
      return typeof value === "function" ? value.bind(t) : value;
    },
  });

// A D1 outage shows up when a statement runs, not when it is prepared, so the
// fault hands back statements whose execution rejects.
const failingStatement = (): D1PreparedStatement => {
  const fail = () => Promise.reject(new Error("fault injected: D1 unavailable"));
  const stmt: D1PreparedStatement = new Proxy({} as D1PreparedStatement, {
    get(_t, prop) {
      if (prop === "bind") return () => stmt;
      // Not a thenable, so awaiting the statement itself cannot hang.
      if (prop === "then") return undefined;
      return fail;
    },
  });
  return stmt;
};

const failingDb = (db: D1Database): D1Database =>
  new Proxy(db, {
    get(t, prop, recv) {
      if (prop === "prepare") return () => failingStatement();
      if (prop === "batch" || prop === "exec") return () => Promise.reject(new Error("fault injected: D1 unavailable"));
      const value = Reflect.get(t, prop, recv);
      return typeof value === "function" ? value.bind(t) : value;
    },
  });

// "kv-delete" breaks only deletes, the case where sign-out cannot clear the cache.
// The first D1 query on the isolate waits forever, as a D1 that stopped
// answering would; later queries go through. That lets a test see both the
// stuck request and the recovery after the stuck auth instance is dropped.
let hungOnce = false;
const hangingDb = (db: D1Database): D1Database => {
  const never = () => new Promise<never>(() => undefined);
  const stmt: D1PreparedStatement = new Proxy({} as D1PreparedStatement, {
    get(_t, prop) {
      if (prop === "bind") return () => stmt;
      if (prop === "then") return undefined;
      return never;
    },
  });
  return new Proxy(db, {
    get(t, prop, recv) {
      if (prop === "prepare" && !hungOnce) {
        hungOnce = true;
        return () => stmt;
      }
      const value = Reflect.get(t, prop, recv);
      return typeof value === "function" ? value.bind(t) : value;
    },
  });
};

const dbFor = (db: D1Database, fault: Env["FAULT"]): D1Database => {
  if (fault === "d1") return failingDb(db);
  if (fault === "d1-hang") return hangingDb(db);
  return db;
};

const failingDeletes = (kv: KVNamespace): KVNamespace =>
  new Proxy(kv, {
    get(t, prop, recv) {
      if (prop === "delete") return () => Promise.reject(new Error("fault injected: KV delete unavailable"));
      const value = Reflect.get(t, prop, recv);
      return typeof value === "function" ? value.bind(t) : value;
    },
  });

// Wall time of each KV call, which unlike D1 reports no server-side duration.
const timedKv = (kv: KVNamespace): KVNamespace =>
  new Proxy(kv, {
    get(t, prop, recv) {
      const value = Reflect.get(t, prop, recv);
      if (typeof value !== "function") return value;
      return async (...args: unknown[]) => {
        const started = Date.now();
        try {
          return await (value as (...a: unknown[]) => Promise<unknown>).apply(t, args);
        } finally {
          const timing = currentTiming();
          if (timing) {
            timing.kvOps += 1;
            timing.kvMs += Date.now() - started;
          }
        }
      };
    },
  });

const kvFor = (env: Env): KVNamespace => {
  if (env.FAULT === "kv") return failingProxy(env.SESSIONS, "KV");
  if (env.FAULT === "kv-delete") return failingDeletes(env.SESSIONS);
  return env.SESSIONS;
};

// Fault injection exists only for the failure tests. It is refused unless the request
// is to the local dev server, so a stray FAULT var cannot break a public Worker.
export const assertFaultAllowed = (env: Env, req: Request): void => {
  if (!env.FAULT) return;
  if (isLocalRequest(env, req)) return;
  throw new Error("FAULT is set on a non-local Worker");
};

const buildBindings = (env: Env) => {
  const db = timedDb(env.DB);
  return {
    db: dbFor(db, env.FAULT),
    sessions: timedKv(kvFor(env)),
    uploads: env.FAULT === "r2" ? failingProxy(env.UPLOADS, "R2") : env.UPLOADS,
  };
};

export type Bindings = ReturnType<typeof buildBindings>;

// Keyed by the env.DB binding object, which the runtime reuses across requests
// in one isolate, so each isolate builds its wrappers once.
const bindingsCache = new WeakMap<D1Database, Bindings>();

export const isolateBindings = (env: Env): Bindings => {
  const cached = bindingsCache.get(env.DB);
  if (cached) return cached;
  const built = buildBindings(env);
  bindingsCache.set(env.DB, built);
  return built;
};
