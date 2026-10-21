// Connection options shared by the Postgres scripts (migrate-pg.mjs,
// set-worker-password.mjs). The owner password crosses this connection, so
// certificate verification is the default: Supabase's CA must be given, or the
// risk taken explicitly with --tls insecure. --tls off is for a loopback host
// only (the local Docker database).
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

export const CONNECT_USAGE =
  "--host <db host> --owner-password-file <file> (--ca-file <Supabase CA pem> | --tls insecure | --tls off)\n" +
  "       [--port 5432] [--database postgres] [--owner postgres]";

const connectOptions = {
  host: { type: "string" },
  port: { type: "string", default: "5432" },
  database: { type: "string", default: "postgres" },
  owner: { type: "string", default: "postgres" },
  "owner-password-file": { type: "string" },
  "ca-file": { type: "string" },
  tls: { type: "string" },
};

// Only a trailing line ending is stripped, the same as $(cat file) does, so a
// script and a TF_VAR_ read from the same file get the same password.
export const readSecret = (file) => readFileSync(file, "utf8").replace(/\r?\n$/, "");

const fail = (usage, message) => {
  if (message) console.error(message);
  console.error(usage);
  process.exit(2);
};

// The pg `ssl` option for a host, or an Error saying why none is allowed.
// Shared with scripts/smoke.mjs (#16), so the rule lives in one place.
export const sslFor = ({ host, caFile, tls }) => {
  const loopback = ["127.0.0.1", "::1", "localhost"].includes(host);
  if (tls === "off" && loopback) return false;
  if (tls === "off") return new Error("--tls off is only for a loopback host");
  if (caFile) return { ca: readFileSync(caFile, "utf8"), servername: host, rejectUnauthorized: true };
  if (tls === "insecure") {
    console.error("warning: --tls insecure, so the database certificate is not verified");
    return { rejectUnauthorized: false };
  }
  return new Error("give --ca-file <Supabase CA pem>, or --tls insecure to connect without verifying the certificate");
};

const tlsFor = (v, usage) => {
  const ssl = sslFor({ host: v.host, caFile: v["ca-file"], tls: v.tls });
  return ssl instanceof Error ? fail(usage, ssl.message) : ssl;
};

// Returns the script's own options and a pg client config for the owner.
export const parseConnectArgs = (extraOptions, usage) => {
  const parsed = (() => {
    try {
      return parseArgs({ strict: true, options: { ...connectOptions, ...extraOptions } }).values;
    } catch (e) {
      return fail(usage, e instanceof Error ? e.message : String(e));
    }
  })();
  if (!parsed.host || !parsed["owner-password-file"]) fail(usage);
  const port = Number(parsed.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail(usage, "bad --port");
  const ssl = tlsFor(parsed, usage);
  const client = (user, password) => ({ host: parsed.host, port, database: parsed.database, user, password, ssl });
  return { values: parsed, client, ownerConfig: client(parsed.owner, readSecret(parsed["owner-password-file"])) };
};
