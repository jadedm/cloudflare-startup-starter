import pg from "pg";
import type { Env } from "./env";
import { recordDbQuery } from "./bindings";

// Hyperdrive does the real pooling, so the Worker makes a small pool per
// request, as Cloudflare's Hyperdrive guide recommends, and closes it when the
// request is done. A pool kept across requests would carry a connection opened
// by one request into the next, which Workers does not allow.
const POOL_MAX = 3;
// The database stops a query itself at 3 s (statement_timeout on app_worker,
// migrations-pg/0005); the client-side timeout is a backstop for a server
// that stops answering. Neither ends a TCP connect that never completes (see
// PG_DEADLINE_MS in index.ts), which is why the request also has a deadline.
const CONNECT_TIMEOUT_MS = 3_000;
const QUERY_TIMEOUT_MS = 5_000;

const timedQuery = async (query: (...a: unknown[]) => Promise<unknown>, args: unknown[]) => {
  const started = Date.now();
  const first = args[0] as { text?: string } | string | undefined;
  const text = typeof first === "string" ? first : (first?.text ?? "");
  try {
    return await query(...args);
  } finally {
    recordDbQuery(Date.now() - started, text);
  }
};

// Better Auth's Postgres adapter checks a client out of the pool and queries
// through it, so the timing hooks each client as the pool creates it; a
// wrapper on pool.query alone would miss every auth query.
const instrument = (pool: pg.Pool): pg.Pool => {
  pool.on("connect", (client) => {
    const query = client.query.bind(client) as (...a: unknown[]) => Promise<unknown>;
    (client as unknown as { query: (...a: unknown[]) => unknown }).query = (...args: unknown[]) => {
      // Callback calls and submittables (cursors, streams) pass through
      // untimed; wrapping them in a promise would change what they return.
      const last = args[args.length - 1];
      const submittable = typeof (args[0] as { submit?: unknown } | undefined)?.submit === "function";
      if (typeof last === "function" || submittable) return query(...args);
      return timedQuery(query, args);
    };
  });
  // An idle client whose connection drops emits error on the pool; without a
  // listener that is an uncaught exception. The next query on it fails and is
  // reported there.
  pool.on("error", () => undefined);
  return pool;
};

export const requestPool = (hyperdrive: Hyperdrive): pg.Pool =>
  instrument(
    new pg.Pool({
      connectionString: hyperdrive.connectionString,
      max: POOL_MAX,
      connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
      query_timeout: QUERY_TIMEOUT_MS,
    }),
  );

export const hyperdriveOf = (env: Env): Hyperdrive | null => env.HYPERDRIVE ?? null;
