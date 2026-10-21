#!/usr/bin/env node
// A stand-in for the Workers script-settings endpoint of the Cloudflare API,
// for scripts/check-redact-logs.sh. It holds the settings from FAKE_SETTINGS
// (JSON) for every account and Worker, and a PATCH replaces each top-level key
// it is sent, as the real API does. FAKE_MODE breaks one thing at a time. It
// records what it was asked in FAKE_LOG, one JSON line per request, and
// prints the port it listens on.
// usage: FAKE_SETTINGS='{"observability":{}}' FAKE_LOG=<file> node scripts/fake-script-settings-api.mjs
import { appendFileSync } from "node:fs";
import { createServer } from "node:http";

let settings = JSON.parse(process.env.FAKE_SETTINGS ?? "{}");
const mode = process.env.FAKE_MODE ?? "";
const log = (entry) => appendFileSync(process.env.FAKE_LOG, `${JSON.stringify(entry)}\n`);
const route = /^\/client\/v4\/accounts\/[^/]+\/workers\/scripts\/[^/]+\/script-settings$/;

const send = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
};
const ok = (res, result) => send(res, 200, { success: true, errors: [], result });
const denied = (res) => send(res, 403, { success: false, errors: [{ code: 10000, message: "Authentication error" }] });
const refused = (res) => send(res, 200, { success: false, errors: [{ code: 10001, message: "nope" }], result: settings });

const get = (res) => {
  if (mode === "get-stall") return;
  if (mode === "get-403") return denied(res);
  if (mode === "get-success-false") return refused(res);
  if (mode === "get-bad-json") return send(res, 200, "not json");
  if (mode === "get-no-observability") return ok(res, { ...settings, observability: undefined });
  if (mode === "get-observability-not-object") return ok(res, { ...settings, observability: true });
  return ok(res, settings);
};

const patch = (body, res) => {
  if (mode === "patch-403") return denied(res);
  if (mode === "patch-success-false") return refused(res);
  if (mode === "patch-network") return res.socket.destroy();
  // Accepts the PATCH and keeps nothing, so only the read-back can tell.
  if (mode === "patch-ignored") return ok(res, settings);
  settings = { ...settings, ...body };
  return ok(res, settings);
};

const server = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const url = new URL(req.url, "http://fake");
    const body = raw ? JSON.parse(raw) : null;
    log({ method: req.method, path: url.pathname, auth: req.headers.authorization ?? "", type: req.headers["content-type"] ?? "", body });
    if (!route.test(url.pathname)) return send(res, 404, { success: false, errors: [{ code: 7003, message: "no route" }] });
    if (req.method === "GET") return get(res);
    if (req.method === "PATCH") return patch(body, res);
    return send(res, 405, { success: false, errors: [{ code: 10405, message: "method not allowed" }] });
  });
});
server.listen(0, "127.0.0.1", () => console.log(server.address().port));
