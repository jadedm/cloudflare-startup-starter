#!/usr/bin/env node
// Gives app_worker a login password. Generates a random password into the
// output file (created new, mode 600, refusing to follow a symlink), sends
// Postgres only a SCRAM-SHA-256 verifier so the plaintext never appears in SQL
// or server logs, then logs in as the worker, with the password read back from
// the file, to prove both work.
// Prints no secret and no derivative of one; the verifier, which is derived
// from the password, appears only in the ALTER ROLE statement sent to the
// server. The file is reserved first and filled only after the ALTER succeeds;
// on any failure before the file is complete it is removed, so a rerun can
// start clean. Once the file is complete it is kept even if the login check
// fails, because it then holds the role's only copy of the password.
// Run after scripts/migrate-pg.mjs and before the Terraform apply that points
// Hyperdrive at the role. Rotating: the role's password changes here, before
// Hyperdrive has the new one, so requests fail until that apply finishes.
// usage: node scripts/set-worker-password.mjs --out <file> <connection options, see scripts/pg-connect.mjs>
import { constants, openSync, writeSync, closeSync, existsSync, unlinkSync } from "node:fs";
import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import pg from "pg";
import { CONNECT_USAGE, parseConnectArgs, readSecret } from "./pg-connect.mjs";

const usage = `usage: node scripts/set-worker-password.mjs --out <file> ${CONNECT_USAGE}`;
const { values, client, ownerConfig } = parseConnectArgs({ out: { type: "string" } }, usage);
const { out } = values;
if (!out) {
  console.error(usage);
  process.exit(2);
}

if (existsSync(out)) {
  console.error(`${out} already exists; remove it first if a new password is intended`);
  process.exit(1);
}

const role = "app_worker";
const password = randomBytes(32).toString("base64url");

// RFC 7677 / PostgreSQL's stored form: SCRAM-SHA-256$<iter>:<salt>$<StoredKey>:<ServerKey>
const scramVerifier = (secret) => {
  const salt = randomBytes(16);
  const iterations = 4096;
  const salted = pbkdf2Sync(secret, salt, iterations, 32, "sha256");
  const clientKey = createHmac("sha256", salted).update("Client Key").digest();
  const storedKey = createHash("sha256").update(clientKey).digest();
  const serverKey = createHmac("sha256", salted).update("Server Key").digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString("base64")}$${storedKey.toString("base64")}:${serverKey.toString("base64")}`;
};

const connect = async (config) => {
  const c = new pg.Client(config);
  await c.connect();
  return c;
};

const owner = await connect(ownerConfig);
const exists = await owner.query("select 1 from pg_roles where rolname = $1", [role]);
if (exists.rowCount !== 1) {
  console.error(`${role} does not exist; run scripts/migrate-pg.mjs first`);
  process.exit(1);
}

const fd = openSync(out, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
const discard = () => {
  try {
    closeSync(fd);
  } catch {
    // already closed
  }
  unlinkSync(out);
};
try {
  await owner.query(`alter role ${role} login password ${owner.escapeLiteral(scramVerifier(password))}`);
} catch (error) {
  discard();
  throw error;
}
// If the file cannot be written in full now, the role holds a password nobody
// has; remove the partial file so a rerun can set a fresh one.
try {
  const bytes = Buffer.from(password, "utf8");
  const written = writeSync(fd, bytes);
  if (written !== bytes.length) throw new Error(`short write: ${written} of ${bytes.length} bytes`);
  closeSync(fd);
} catch (error) {
  discard();
  console.error("password was set on the role but could not be saved; rerun to set a new one");
  throw error;
}
await owner.end();
console.log(`${role}: login enabled, password set from a SCRAM verifier, written to ${out} (mode 600)`);

const worker = await connect(client(role, readSecret(out)));
const who = await worker.query(
  "select current_user, (select rolbypassrls from pg_roles where rolname = current_user) as bypassrls",
);
await worker.end();
const { current_user: user, bypassrls } = who.rows[0];
if (user !== role || bypassrls !== false) {
  console.error(`login check failed: current_user=${user}, bypassrls=${bypassrls}`);
  process.exit(1);
}
console.log(`login check: current_user=${user}, bypassrls=${bypassrls}`);
