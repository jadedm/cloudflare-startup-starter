#!/usr/bin/env node
// Applies migrations-pg/*.sql in name order, each in its own transaction, and
// records each file in app_meta.migrations so a second run applies nothing.
// The ledger has its own schema so the Supabase Data API, which serves public,
// never sees it. Run as the owner (postgres), against a database of the app's
// own: 0004 changes grants on everything already in public.
// A file that was already applied and has since changed is an error, not a
// skip, so an edited migration cannot pass for applied.
// --until <NNNN> stops after that migration, for testing an upgrade onto a
// database that already holds rows.
// usage: node scripts/migrate-pg.mjs [--until NNNN] <connection options, see scripts/pg-connect.mjs>
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import pg from "pg";
import { CONNECT_USAGE, parseConnectArgs } from "./pg-connect.mjs";

const usage = `usage: node scripts/migrate-pg.mjs [--until NNNN] ${CONNECT_USAGE}`;
const { values, ownerConfig } = parseConnectArgs({ until: { type: "string" } }, usage);
const dir = new URL("../migrations-pg/", import.meta.url);
const files = readdirSync(dir)
  .filter((f) => /^\d{4}_.+\.sql$/.test(f))
  .filter((f) => !values.until || f.slice(0, 4) <= values.until)
  .sort();
if (files.length === 0) throw new Error("no migrations found in migrations-pg/");

const client = new pg.Client(ownerConfig);
await client.connect();
try {
  await client.query(`
    create schema if not exists app_meta;
    revoke all on schema app_meta from public;
    create table if not exists app_meta.migrations (
      name text primary key,
      sha256 text not null,
      applied_at timestamptz not null default now()
    );`);
  const applied = new Map((await client.query("select name, sha256 from app_meta.migrations")).rows.map((r) => [r.name, r.sha256]));
  let ran = 0;
  for (const name of files) {
    const text = readFileSync(new URL(name, dir), "utf8");
    const sha = createHash("sha256").update(text).digest("hex");
    const seen = applied.get(name);
    if (seen === sha) continue;
    if (seen) throw new Error(`${name} changed after it was applied; add a new migration instead`);
    await client.query("begin");
    try {
      await client.query(text);
      await client.query("insert into app_meta.migrations (name, sha256) values ($1, $2)", [name, sha]);
      await client.query("commit");
    } catch (e) {
      await client.query("rollback");
      throw e;
    }
    console.log(`applied ${name}`);
    ran += 1;
  }
  console.log(ran === 0 ? "nothing to apply" : `applied ${ran} of ${files.length}`);
} finally {
  await client.end();
}
