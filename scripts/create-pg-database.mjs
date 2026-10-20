#!/usr/bin/env node
// Creates the app's own database if it does not exist, connected to the
// maintenance database (--database, default postgres) as the owner. The app's
// migrations change grants on everything in public (0004), so they go into a
// database of their own rather than Supabase's postgres database.
// Prints whether it created the database or found it; no secret.
// usage: node scripts/create-pg-database.mjs --name <database> <connection options, see scripts/pg-connect.mjs>
import pg from "pg";
import { CONNECT_USAGE, parseConnectArgs } from "./pg-connect.mjs";

const usage = `usage: node scripts/create-pg-database.mjs --name <database> ${CONNECT_USAGE}`;
const { values, ownerConfig } = parseConnectArgs({ name: { type: "string" } }, usage);
const { name } = values;
// CREATE DATABASE takes no bind parameter, so the name is checked instead.
if (!name || !/^[a-z_][a-z0-9_]{0,62}$/.test(name)) {
  console.error("--name must be a lowercase identifier: letters, digits and _, at most 63 characters");
  console.error(usage);
  process.exit(2);
}
if (name === "postgres" || name.startsWith("template")) {
  console.error("--name must be the app's own database, not postgres or a template");
  process.exit(2);
}
if (name === values.database) {
  console.error("--name is the database being connected to; give the maintenance database with --database");
  process.exit(2);
}

const client = new pg.Client(ownerConfig);
await client.connect();
try {
  const found = await client.query("select 1 from pg_database where datname = $1", [name]);
  if (found.rowCount === 0) await client.query(`create database "${name}"`);
  console.log(found.rowCount === 0 ? `created database ${name}` : `database ${name} already exists`);
} finally {
  await client.end();
}
