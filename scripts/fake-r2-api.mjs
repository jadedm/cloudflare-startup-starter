#!/usr/bin/env node
// A stand-in for the R2 object list and delete endpoints of the Cloudflare
// API, for scripts/check-empty-avatars.sh. It holds the keys from FAKE_KEYS
// (a JSON array) and pages lists by per_page, as the real API does. FAKE_MODE
// breaks one thing at a time. It records what it was asked in FAKE_LOG, one
// JSON line per request, and prints the port it listens on.
// usage: FAKE_KEYS='["avatars/a"]' FAKE_LOG=<file> node scripts/fake-r2-api.mjs
import { appendFileSync } from "node:fs";
import { createServer } from "node:http";

const keys = new Set(JSON.parse(process.env.FAKE_KEYS ?? "[]"));
const mode = process.env.FAKE_MODE ?? "";
let uploaded = false;
let throttled = 0;
const log = (entry) => appendFileSync(process.env.FAKE_LOG, `${JSON.stringify(entry)}\n`);
const prefix = "/client/v4/accounts/acct/r2/buckets/bucket/objects";

const send = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};
const ok = (res, extra) => send(res, 200, { success: true, errors: [], ...extra });

const list = (url, res) => {
  const want = url.searchParams.get("prefix") ?? "";
  const perPage = Number(url.searchParams.get("per_page") ?? 20);
  const start = Number(url.searchParams.get("cursor") || 0);
  const all = [...keys].filter((k) => k.startsWith(want)).sort();
  const page = all.slice(start, start + perPage);
  const more = start + perPage < all.length;
  if (mode === "list-ignores-prefix") return ok(res, { result: [...keys].sort().map((key) => ({ key })) });
  if (mode === "list-403") return send(res, 403, { success: false, errors: [{ code: 10000, message: "Authentication error" }] });
  // Carries a result, so only the success flag says it failed.
  if (mode === "list-success-false") return send(res, 200, { success: false, errors: [{ code: 10001, message: "nope" }], result: [] });
  if (mode === "list-no-result") return ok(res, {});
  if (mode === "list-repeat-cursor") return ok(res, { result: page.map((key) => ({ key })), result_info: { is_truncated: true, cursor: "0", per_page: perPage } });
  if (mode === "list-no-cursor") return ok(res, { result: page.map((key) => ({ key })), result_info: { is_truncated: true, per_page: perPage } });
  const info = more ? { result_info: { is_truncated: true, cursor: String(start + perPage), per_page: perPage } } : {};
  return ok(res, { result: page.map((key) => ({ key })), ...info });
};

const server = createServer((req, res) => {
  const url = new URL(req.url, "http://fake");
  log({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), auth: req.headers.authorization ?? "" });
  if (req.method === "GET" && url.pathname === prefix) return list(url, res);
  const isDelete = req.method === "DELETE" && url.pathname.startsWith(`${prefix}/`);
  if (!isDelete) return send(res, 404, { success: false, errors: [{ code: 7003, message: "no route" }] });
  if (mode === "delete-429-twice" && throttled < 2) {
    throttled++;
    res.writeHead(429, { "content-type": "application/json", "retry-after": "1" });
    return res.end(JSON.stringify({ success: false, errors: [{ code: 10429, message: "rate limited" }] }));
  }
  // The object goes, but the answer says it was not there: a user removed
  // their avatar between the list and this delete.
  if (mode === "delete-404") {
    keys.delete(decodeURIComponent(url.pathname.slice(prefix.length + 1)));
    return send(res, 404, { success: false, errors: [{ code: 10007, message: "not found" }] });
  }
  if (mode === "delete-500") return send(res, 500, { success: false, errors: [{ code: 10001, message: "internal" }] });
  const key = url.pathname.slice(prefix.length + 1).split("/").map(decodeURIComponent).join("/");
  if (!keys.delete(key)) return send(res, 404, { success: false, errors: [{ code: 10007, message: "not found" }] });
  // Simulates an upload landing between the deletes and the final check.
  if (mode === "upload-during" && !uploaded) {
    uploaded = true;
    keys.add("avatars/late-upload");
  }
  return ok(res, { result: {} });
});
server.listen(0, "127.0.0.1", () => console.log(server.address().port));
