#!/usr/bin/env node
// Turns on observability.redact_query_string for the app's Worker, so Workers
// Logs keeps request URLs without their query strings. The Google callback
// carries the one-time OAuth code there (#11). The Terraform provider (5.28.x)
// has no field for it, so scripts/tf.sh runs this after every apply.
// Reads Terraform state on stdin (`terraform state pull`) to find the Worker's
// account and name; with no Worker in state (a destroy, or a first apply that
// stopped early) it does nothing. Otherwise it reads the script settings,
// sends observability back with only the flag changed, and reads again: it
// exits 1 unless the flag is now true.
// Needs CLOUDFLARE_API_TOKEN in the environment. CF_API_BASE points it at the
// local fake, for scripts/check-redact-logs.sh. Never prints the token.
// usage: terraform state pull | node scripts/redact-logs.mjs
import { readFileSync } from "node:fs";

const fail = (what) => {
  console.error(`redact-logs: ${what}`);
  process.exit(1);
};

const token = process.env.CLOUDFLARE_API_TOKEN;
if (!token) fail("CLOUDFLARE_API_TOKEN must be set");
// The override is for the local fake only, so the token cannot be sent to
// some other host that happens to be named in the environment.
const apiBase = process.env.CF_API_BASE ?? "https://api.cloudflare.com/client/v4";
const isLocal = (u) => {
  const url = URL.canParse(u) ? new URL(u) : null;
  return url?.protocol === "http:" && url.hostname === "127.0.0.1" && !url.username && !url.password;
};
if (apiBase !== "https://api.cloudflare.com/client/v4" && !isLocal(apiBase)) {
  fail("CF_API_BASE may only point at http://127.0.0.1 (the test fake)");
}

// No state at all (an apply that stopped before creating anything) prints
// nothing, which counts as no Worker.
const raw = readFileSync(0, "utf8");
let state = {};
try {
  if (raw.trim()) state = JSON.parse(raw);
} catch {
  fail("stdin is not Terraform state");
}
const worker = (state.resources ?? []).find(
  (r) => r.mode === "managed" && !r.module && r.type === "cloudflare_workers_script" && r.name === "app",
);
const attrs = worker?.instances?.[0]?.attributes;
if (!attrs) {
  console.log("no Worker in state; query string redaction not checked");
  process.exit(0);
}
if (!attrs.account_id || !attrs.script_name) fail("the Worker in state has no account_id or script_name");

const url = `${apiBase}/accounts/${encodeURIComponent(attrs.account_id)}/workers/scripts/${encodeURIComponent(attrs.script_name)}/script-settings`;

// An answer counts only when Cloudflare says it succeeded; a 200 carrying
// success: false is a failure. Errors print codes and messages, not the request.
// Each call gives up after 30 s, so a stalled API cannot hang tf.sh after the apply.
const call = async (method, body) => {
  const init = { method, headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) };
  if (body) {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const res = await fetch(url, init).catch((e) => fail(`${method} failed: ${e.cause?.code ?? e.message}`));
  const answer = await res.json().catch(() => null);
  if (res.ok && answer?.success === true) return answer.result;
  const errors = (answer?.errors ?? []).map((e) => `${e.code} ${e.message}`).join("; ");
  fail(`${method} script-settings answered ${res.status}${errors ? `: ${errors}` : ""}`);
};

const observability = (await call("GET"))?.observability;
if (!observability || typeof observability !== "object") fail("script settings carry no observability block; nothing sent");
if (observability.redact_query_string === true) {
  console.log(`${attrs.script_name}: query strings already redacted in logs`);
  process.exit(0);
}
// PATCH replaces the whole observability block (wrangler sends it whole too),
// so everything read is sent back and only the flag changes.
await call("PATCH", { observability: { ...observability, redact_query_string: true } });
const after = (await call("GET"))?.observability;
if (after?.redact_query_string !== true) fail(`${attrs.script_name}: the PATCH was accepted but the flag still reads ${after?.redact_query_string}`);
console.log(`${attrs.script_name}: query strings now redacted in logs`);
