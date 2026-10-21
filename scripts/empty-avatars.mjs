#!/usr/bin/env node
// Deletes every object under avatars/ in the app's R2 bucket, so the bucket
// can be destroyed. The keys come from listing the bucket, not from the user
// table, so it works whichever database holds the users (#13) and also
// removes avatars whose user is gone. Every page is listed before anything is
// deleted, so the deletes cannot disturb a cursor in use. Afterwards the whole
// bucket is listed again; anything left, inside avatars/ or outside it (the
// app writes nothing else), makes it exit 1, because the destroy would fail.
// Needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID in the environment.
// CF_API_BASE points it at the local fake, for scripts/check-empty-avatars.sh.
// Prints counts and keys outside avatars/; never the token.
// usage: node scripts/empty-avatars.mjs --bucket <name>
import { parseArgs } from "node:util";

const usage = "usage: node scripts/empty-avatars.mjs --bucket <name>";
const { values } = parseArgs({ options: { bucket: { type: "string" } } });
const token = process.env.CLOUDFLARE_API_TOKEN;
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
if (!values.bucket || !token || !account) {
  console.error(usage);
  console.error("CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID must be set");
  process.exit(2);
}
// The override is for the local fake only, so the token cannot be sent to
// some other host that happens to be named in the environment.
const apiBase = process.env.CF_API_BASE ?? "https://api.cloudflare.com/client/v4";
const isLocal = (u) => {
  const url = URL.canParse(u) ? new URL(u) : null;
  return url?.protocol === "http:" && url.hostname === "127.0.0.1" && !url.username && !url.password;
};
if (apiBase !== "https://api.cloudflare.com/client/v4" && !isLocal(apiBase)) {
  console.error("CF_API_BASE may only point at http://127.0.0.1 (the test fake)");
  process.exit(2);
}
const base = `${apiBase}/accounts/${account}/r2/buckets/${encodeURIComponent(values.bucket)}/objects`;
const headers = { authorization: `Bearer ${token}` };

const fail = (what) => {
  console.error(`empty-avatars: ${what}`);
  process.exit(1);
};

// An answer counts only when Cloudflare says it succeeded; a 200 carrying
// success: false is a failure. Errors print codes and messages, not the request.
// The REST API allows 1,200 R2 calls per five minutes, so a 429 waits (for
// Retry-After, else 60 s) and tries again, up to six times. A DELETE that
// answers 404 means the object is already gone, which is the goal.
const call = async (method, url) => {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, { method, headers }).catch((e) => fail(`${method} failed: ${e.cause?.code ?? e.message}`));
    const body = await res.json().catch(() => null);
    if (res.ok && body?.success === true) return body;
    if (method === "DELETE" && res.status === 404) return body;
    if (res.status === 429 && attempt <= 6) {
      const wait = Number(res.headers.get("retry-after")) || 60;
      console.error(`rate limited; waiting ${wait} s (retry ${attempt} of 6)`);
      await new Promise((r) => setTimeout(r, wait * 1000));
      continue;
    }
    const errors = (body?.errors ?? []).map((e) => `${e.code} ${e.message}`).join("; ");
    fail(`${method} answered ${res.status}${errors ? `: ${errors}` : ""}`);
  }
};

const listAll = async (prefix) => {
  const keys = [];
  const seen = new Set();
  let cursor = "";
  for (;;) {
    const params = new URLSearchParams({ per_page: "1000", ...(prefix && { prefix }), ...(cursor && { cursor }) });
    const body = await call("GET", `${base}?${params}`);
    if (!Array.isArray(body.result)) fail("list answer has no result array");
    keys.push(...body.result.map((o) => o.key));
    const info = body.result_info;
    if (!info?.is_truncated) return keys;
    if (!info.cursor) fail("list says there is more but gives no cursor");
    if (seen.has(info.cursor)) fail("list returned the same cursor twice");
    seen.add(info.cursor);
    cursor = info.cursor;
  }
};

// Checked here as well as by the list's prefix, so nothing outside avatars/
// is deleted even if the API returned more than was asked for.
const avatars = (await listAll("avatars/")).filter((k) => k.startsWith("avatars/"));
// Slashes stay as they are, as wrangler sends them; each part is encoded.
const objectPath = (key) => key.split("/").map(encodeURIComponent).join("/");
for (const key of avatars) await call("DELETE", `${base}/${objectPath(key)}`);
console.log(`avatars deleted from ${values.bucket}: ${avatars.length}`);

const left = await listAll("");
if (left.length === 0) {
  console.log(`${values.bucket} is empty`);
  process.exit(0);
}
const outside = left.filter((k) => !k.startsWith("avatars/"));
const inside = left.length - outside.length;
console.error(`${values.bucket} still holds ${left.length} objects; the destroy would fail on the bucket`);
if (inside > 0) console.error(`  ${inside} under avatars/, uploaded since the list or not removed by its delete: run this again, and if the count does not fall, delete them by hand`);
for (const key of outside.slice(0, 20)) console.error(`  outside avatars/, not deleted: ${key}`);
if (outside.length > 20) console.error(`  and ${outside.length - 20} more outside avatars/`);
process.exit(1);
