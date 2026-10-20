import type pg from "pg";
import type { Env } from "./env";

// The app's own queries (notes) go through one interface so the same routes
// run on D1 and on Postgres. A query is written as a tagged template,
// sql`... where "id" = ${id}`, and each driver numbers the values its own way:
// ? for D1, $1..$n for Postgres. No SQL text is rewritten, so a ? inside a
// string literal or a jsonb operator stays as written.
export interface Query {
  strings: readonly string[];
  values: unknown[];
}

export const sql = (strings: TemplateStringsArray, ...values: unknown[]): Query => ({ strings: [...strings], values });

export const render = (q: Query, mark: (n: number) => string): string =>
  q.strings.map((s, i) => (i === 0 ? s : mark(i) + s)).join("");

export interface AppDb {
  all<T>(q: Query): Promise<T[]>;
  run(q: Query): Promise<void>;
}

export type DbDriver = "d1" | "pg";

// Unset means d1. Any other value is a configuration error the caller refuses
// to serve on, the same rule as PASSWORD_LOGIN.
export const dbDriverOf = (env: Env): DbDriver | null => {
  if (env.DB_DRIVER === undefined || env.DB_DRIVER === "" || env.DB_DRIVER === "d1") return "d1";
  if (env.DB_DRIVER === "pg") return "pg";
  return null;
};

export const d1AppDb = (db: D1Database): AppDb => ({
  async all<T>(q: Query) {
    const { results } = await db.prepare(render(q, () => "?")).bind(...q.values).all();
    return results as T[];
  },
  async run(q: Query) {
    await db.prepare(render(q, () => "?")).bind(...q.values).run();
  },
});

// Thrown for a database that cannot be reached or did not answer in time, so
// the error handler can answer 503 rather than 500.
export class DbUnavailable extends Error {
  constructor(cause: unknown) {
    super("database unavailable", { cause });
    this.name = "DbUnavailable";
  }
}

// Connection failures and timeouts on Postgres, not query errors. 57014 is a
// statement cancelled by app_worker's statement_timeout (migrations-pg/0005),
// 57P01 to 57P03 a server shutting down or refusing, 08xxx the connection
// exception class. pg's own connection errors carry no code, so those are
// matched by message; only errors from pgQuery are classified, never D1's.
const unavailableCode = (code: unknown) =>
  typeof code === "string" && (code === "57014" || /^57P0[123]$/.test(code) || code.startsWith("08"));
const unavailableMessage = /Query read timeout|Connection terminated|connection lost|ECONNREFUSED|ECONNRESET/i;

const isUnavailable = (e: unknown): boolean => {
  if (!(e instanceof Error)) return false;
  return unavailableCode((e as { code?: unknown }).code) || unavailableMessage.test(e.message);
};

const pgQuery = async (pool: pg.Pool, q: Query) => {
  const client = await pool.connect().catch((e: unknown) => {
    throw new DbUnavailable(e);
  });
  // A client whose query failed may still have it running (a client-side
  // timeout does not stop it), so it is destroyed, not returned to the pool.
  let failure: Error | undefined;
  try {
    return await client.query(render(q, (n) => `$${n}`), q.values);
  } catch (e) {
    failure = e instanceof Error ? e : new Error(String(e));
    throw isUnavailable(e) ? new DbUnavailable(e) : e;
  } finally {
    client.release(failure);
  }
};

export const pgAppDb = (pool: pg.Pool): AppDb => ({
  async all<T>(q: Query) {
    return (await pgQuery(pool, q)).rows as T[];
  },
  async run(q: Query) {
    await pgQuery(pool, q);
  },
});
