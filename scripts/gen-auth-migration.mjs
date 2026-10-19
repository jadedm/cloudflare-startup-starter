// Writes the Better Auth core schema as a D1 migration. Uses an empty in-memory
// SQLite so the output is the full CREATE set, not a diff against a local DB.
import { DatabaseSync } from "node:sqlite";
import { writeFileSync } from "node:fs";
import { getMigrations } from "better-auth/db/migration";

const out = process.argv[2];
if (!out) throw new Error("usage: gen-auth-migration.mjs <out.sql>");

const { compileMigrations } = await getMigrations({
  database: new DatabaseSync(":memory:"),
  emailAndPassword: { enabled: true },
  socialProviders: { google: { clientId: "x", clientSecret: "x" } },
  rateLimit: { enabled: true, storage: "database" },
});
const sql = await compileMigrations();
if (!sql.trim()) throw new Error("no SQL produced");
writeFileSync(out, sql.endsWith("\n") ? sql : sql + "\n");
console.log(`wrote ${out}`);
