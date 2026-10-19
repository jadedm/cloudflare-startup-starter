// Runs the test cases (see docs/TESTING.md) over real HTTP against a booted Worker.
// usage: node scripts/smoke.mjs <group> [baseUrl]
// Each group needs the server started with a matching config; scripts/local-suite.sh
// does that. Exits non-zero if any case fails or a group runs no cases.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { Agent, request, setGlobalDispatcher } from "undici";

const [group, base = "https://127.0.0.1:8787"] = process.argv.slice(2);
if (!group) throw new Error("usage: smoke.mjs <group> [baseUrl]");

const ORIGIN = new URL(base).origin;
const isLocal = ["127.0.0.1", "localhost"].includes(new URL(base).hostname);

// No connection reuse: the local HTTPS proxy closes idle sockets while the
// D1 row checks run, and a reused dead socket shows up as ECONNRESET.
// Certificate checks are skipped only for the local self-signed server.
// autoSelectFamily races IPv6 and IPv4 the way curl does; without it a slow
// first address family timed out against the deployed hostnames.
setGlobalDispatcher(
  new Agent({ pipelining: 0, connect: { rejectUnauthorized: !isLocal, autoSelectFamily: true, timeout: 30_000 } }),
);
const PASS_TOKEN = "XXXX.DUMMY.TOKEN.XXXX";
const PASSWORD = "correct-horse-battery";
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const runId = Date.now().toString(36);

// ok is true, false, or null for a measurement that is recorded but not judged.
const results = [];
const record = (id, ok, observed) => {
  results.push({ id, ok, observed });
  const label = ok === null ? "INFO" : ok ? "PASS" : "FAIL";
  console.log(`${label} ${id}: ${observed}`);
};

// Shared between groups of one local-suite run (same D1 state, same secret).
// fault-d1 reads what base wrote, so it only runs after base in the same run.
const stateDir = process.env.SMOKE_STATE_DIR;
const stateFile = (name) => (stateDir ? `${stateDir}/${name}` : null);

// The local server's output, written by local-suite.sh. Structured events are
// the JSON objects src/worker/log.ts prints, one per line.
const serverLogText = () => {
  const path = process.env.SMOKE_SERVER_LOG;
  return path ? readFileSync(path, "utf8") : null;
};
const logEvents = (text) =>
  text
    .split("\n")
    .map((line) => {
      // wrangler wraps warn and error lines in colour codes on both sides.
      const at = line.indexOf('{"level"');
      const end = line.lastIndexOf("}");
      if (at < 0 || end < at) return null;
      try {
        return JSON.parse(line.slice(at, end + 1));
      } catch {
        return null;
      }
    })
    .filter(Boolean);
const settle = () => new Promise((r) => setTimeout(r, 500));

// KV operations the Worker reported for a request (DEBUG_TIMING is on locally).
const kvOpsOf = (res) => Number(/kv;dur=\d+;desc="(\d+) ops"/.exec(res.headers.get("server-timing") ?? "")?.[1] ?? NaN);

// Every session token value this run saw, so S7 can look for the values
// themselves in the logs, not only the cookie name.
const seenTokens = new Set();
const rememberTokens = (cookie) => {
  for (const part of (cookie ?? "").split("; ")) {
    const value = decodeURIComponent(part.split("=").slice(1).join("="));
    if (part.includes("session_token") && value) seenTokens.add(value.split(".")[0]);
  }
};

// D1 is the ground truth for row counts, read outside the Worker. Deployed
// runs look the database up by name, from a folder with no wrangler config so
// the local placeholder id is not used, and need CLOUDFLARE_API_TOKEN and
// CLOUDFLARE_ACCOUNT_ID in the environment.
// The database name: wrangler.jsonc locally, `${app_name}-db` when deployed.
const D1_NAME = process.env.D1_NAME ?? "starter-app-db";
const wranglerBin = fileURLToPath(new URL("../node_modules/.bin/wrangler", import.meta.url));
const sql = (query) => {
  const persist = process.env.SMOKE_PERSIST ? ["--persist-to", process.env.SMOKE_PERSIST] : [];
  const where = isLocal ? ["--local", ...persist] : ["--remote"];
  const out = execFileSync(wranglerBin, ["d1", "execute", D1_NAME, ...where, "--json", "--command", query], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    cwd: isLocal ? process.cwd() : tmpdir(),
  });
  return JSON.parse(out)[0].results;
};
const count = (table, where, ...args) => {
  const filled = args.reduce((q, a) => q.replace("?", `'${String(a).replaceAll("'", "''")}'`), where);
  return sql(`select count(*) as n from "${table}" where ${filled}`)[0].n;
};

// Better Auth rate-limits auth routes per IP, and its counters live in D1 across
// groups. A random block per run plus a fresh address per call keeps cases independent.
const ipBlock = Math.floor(Math.random() * 250);
let ipSeq = 0;
const freshIp = () => `10.${ipBlock}.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`;

// noOrigin leaves out the Origin header a browser would send on a write.
const req = (path, { method = "GET", body, headers = {}, cookie, raw, noOrigin = false } = {}) =>
  fetch(base + path, {
    method,
    redirect: "manual",
    // A hung Worker fails the case instead of stalling the suite (#8).
    signal: AbortSignal.timeout(30_000),
    headers: {
      // Cloudflare's edge answers 403 to a client-sent cf-connecting-ip, so the
      // per-call address is only used against local wrangler dev.
      ...(isLocal && { "cf-connecting-ip": freshIp() }),
      ...(body !== undefined && !raw && { "content-type": "application/json" }),
      ...(method !== "GET" && !noOrigin && { origin: ORIGIN }),
      ...(cookie && { cookie }),
      ...headers,
    },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });

// fetch() drops caller-set Sec-Fetch-* headers (they are forbidden request
// headers), so a "navigation" sent through it is not one. undici.request sends
// headers as written, which is what a browser following a redirect does.
const navigate = async (path) => {
  const res = await request(base + path, {
    headers: {
      "sec-fetch-mode": "navigate",
      "sec-fetch-dest": "document",
      "sec-fetch-site": "cross-site",
      accept: "text/html,application/xhtml+xml",
      "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
    },
  });
  const body = await res.body.text();
  return { status: res.statusCode, worker: res.headers["x-worker"] ?? null, shell: body.includes('id="root"') };
};

const cookiesOf = (res) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .filter((c) => !c.endsWith("="))
    .join("; ");

const signUp = (email, token = PASS_TOKEN) =>
  req("/api/auth/sign-up/email", {
    method: "POST",
    body: { email, password: PASSWORD, name: email },
    headers: token ? { "x-captcha-response": token } : {},
  });

const signIn = (email, password = PASSWORD, token = PASS_TOKEN) =>
  req("/api/auth/sign-in/email", {
    method: "POST",
    body: { email, password },
    headers: token ? { "x-captcha-response": token } : {},
  });

const newUser = async (tag) => {
  const email = `${tag}-${runId}@example.test`;
  const res = await signUp(email);
  if (res.status !== 200) throw new Error(`setup sign-up for ${tag} got ${res.status}`);
  const cookie = cookiesOf(res);
  rememberTokens(cookie);
  const me = await (await req("/api/me", { cookie })).json();
  return { email, cookie, userId: me.userId };
};

const groups = {
  async base() {
    const root = await req("/");
    record("1", root.status === 200 && !root.headers.get("x-worker") && (await root.text()).includes('id="root"'),
      `${root.status}, x-worker=${root.headers.get("x-worker")}`);

    const html = await (await req("/")).text();
    const asset = html.match(/\/assets\/[^"]+\.js/)?.[0];
    const a = asset ? await req(asset) : null;
    record("2", a?.status === 200 && !a.headers.get("x-worker"), `${asset} -> ${a?.status}, x-worker=${a?.headers.get("x-worker")}`);

    const nav = await navigate("/api/auth/callback/google?code=x&state=y");
    record("3b", nav.worker === "1" && !nav.shell, `${nav.status}, x-worker=${nav.worker}, html-shell=${nav.shell}`);

    const e4 = `c4-${runId}@example.test`;
    const up4 = await signUp(e4, null);
    const in4 = await signIn(e4, PASSWORD, null);
    record("4", [400, 403].includes(up4.status) && [400, 403].includes(in4.status) && count("user", `email = ?`, e4) === 0,
      `sign-up ${up4.status}, sign-in ${in4.status}, user rows ${count("user", `email = ?`, e4)}`);

    const e6 = `c6-${runId}@example.test`;
    const up6 = await signUp(e6);
    const setCookie = up6.headers.getSetCookie().find((c) => c.includes("session_token")) ?? "";
    const attrs = setCookie.toLowerCase();
    const ok6 = up6.status === 200 && count("user", `email = ?`, e6) === 1 && attrs.includes("httponly") &&
      attrs.includes("secure") && attrs.includes("samesite=lax") && attrs.includes("path=/") && !attrs.includes("domain=");
    record("6", ok6, `${up6.status}, rows ${count("user", `email = ?`, e6)}, cookie attrs: ${setCookie.split(";").slice(1).map((s) => s.trim().split("=")[0]).join(",")}`);

    const e6b = `c6b-${runId}@example.test`;
    const pair = await Promise.all([signUp(e6b), signUp(e6b)]);
    const statuses = pair.map((r) => r.status).sort();
    record("6b", statuses[0] === 200 && statuses[1] >= 400 && statuses[1] < 500 && count("user", `email = ?`, e6b) === 1,
      `statuses ${statuses.join(",")}, user rows ${count("user", `email = ?`, e6b)}`);

    const u = await newUser("c7");
    const before = count("session", `"userId" = ?`, u.userId);
    const bad = await signIn(u.email, "wrong-password-xx");
    record("7", bad.status === 401 && count("session", `"userId" = ?`, u.userId) === before,
      `${bad.status}, sessions ${before} -> ${count("session", `"userId" = ?`, u.userId)}`);

    const good = await signIn(u.email);
    const newCookie = cookiesOf(good);
    record("8", good.status === 200 && count("session", `"userId" = ?`, u.userId) === before + 1 && newCookie && newCookie !== u.cookie,
      `${good.status}, sessions ${before} -> ${count("session", `"userId" = ?`, u.userId)}, token rotated=${newCookie !== u.cookie}`);

    const noCookie = await req("/api/me");
    const tampered = await req("/api/me", { cookie: u.cookie.replace(/=(.)/, (_, ch) => `=${ch === "a" ? "b" : "a"}`) });
    const valid = await req("/api/me", { cookie: u.cookie });
    const validBody = await valid.json();
    record("9", noCookie.status === 401 && tampered.status === 401 && valid.status === 200 && validBody.userId === u.userId,
      `${noCookie.status}, ${tampered.status}, ${valid.status}`);

    // With KV off, a signed-in check must have read D1 at least once.
    const timing = valid.headers.get("server-timing");
    record("16-local", /desc="[1-9]\d* queries"/.test(timing ?? ""), `server-timing: ${timing}`);
    // A signed cookie for fault-d1, which cannot sign in once D1 is down.
    if (stateFile("signed-cookie")) writeFileSync(stateFile("signed-cookie"), u.cookie, { mode: 0o600 });

    const ua = await newUser("c10a");
    const ub = await newUser("c10b");
    const created = await (await req("/api/notes", { method: "POST", body: { body: "secret" }, cookie: ua.cookie })).json();
    const steal = await req(`/api/notes/${created.id}`, { cookie: ub.cookie });
    const own = await req(`/api/notes/${created.id}`, { cookie: ua.cookie });
    record("10", steal.status === 404 && own.status === 200 && count("note", `id = ?`, created.id) === 1,
      `B ${steal.status}, A ${own.status}`);

    const u11 = await newUser("c11");
    const out = await req("/api/auth/sign-out", { method: "POST", body: {}, cookie: u11.cookie });
    const after = await req("/api/me", { cookie: u11.cookie });
    record("11", out.status === 200 && after.status === 401 && count("session", `"userId" = ?`, u11.userId) === 0,
      `sign-out ${out.status}, old cookie ${after.status}, session rows ${count("session", `"userId" = ?`, u11.userId)}`);

    const put = await req("/api/avatar", { method: "PUT", raw: PNG, headers: { "content-type": "image/png" }, cookie: ua.cookie });
    const steal13 = await req(`/api/avatar/${ua.userId}`, { cookie: ub.cookie });
    const own13 = await req(`/api/avatar/${ua.userId}`, { cookie: ua.cookie });
    record("13", put.status === 201 && steal13.status === 404 && own13.status === 200 && own13.headers.get("content-type") === "image/png",
      `put ${put.status}, B ${steal13.status}, A ${own13.status} ${own13.headers.get("content-type")}`);

    const big = new Uint8Array(1024 * 1024 + 1);
    big.set(PNG);
    const tooBig = await req("/api/avatar", { method: "PUT", raw: big, cookie: ub.cookie });
    const fakePng = await req("/api/avatar", { method: "PUT", raw: new TextEncoder().encode("<html><script>alert(1)</script>"), headers: { "content-type": "image/png" }, cookie: ub.cookie });
    // A chunked body carries no content-length; it must be refused before it is read.
    const chunked = await request(base + "/api/avatar", {
      method: "PUT",
      headers: { cookie: ub.cookie, origin: ORIGIN, ...(isLocal && { "cf-connecting-ip": freshIp() }) },
      body: (async function* () { yield PNG; })(),
    });
    await chunked.body.dump();
    const ubAvatar = await req(`/api/avatar/${ub.userId}`, { cookie: ub.cookie });
    record("13b", tooBig.status === 413 && fakePng.status === 415 && chunked.statusCode === 411 && ubAvatar.status === 404,
      `over-limit ${tooBig.status}, html-as-png ${fakePng.status}, chunked ${chunked.statusCode}, B object after all ${ubAvatar.status}`);

    const longNote = await req("/api/notes", { method: "POST", body: { body: "x".repeat(10_001) }, cookie: ub.cookie });
    record("13d", longNote.status === 413 && count("note", `"userId" = ?`, ub.userId) === 0, `note over 10,000 chars -> ${longNote.status}`);

    const evil = "https://evil.example";
    const u19 = await newUser("c19");
    const crossSignIn = await req("/api/auth/sign-in/email", { method: "POST", body: { email: u19.email, password: PASSWORD }, headers: { origin: evil, "x-captcha-response": PASS_TOKEN }, cookie: u19.cookie });
    record("19a", crossSignIn.status === 403, `${crossSignIn.status}`);

    const pre = await req("/api/notes", { method: "OPTIONS", headers: { origin: evil, "access-control-request-method": "POST" } });
    record("19b", !pre.headers.get("access-control-allow-origin"), `${pre.status}, allow-origin=${pre.headers.get("access-control-allow-origin")}`);

    const crossOut = await req("/api/auth/sign-out", { method: "POST", body: {}, headers: { origin: evil }, cookie: u19.cookie });
    const crossNote = await req("/api/notes", { method: "POST", body: { body: "x" }, headers: { origin: evil }, cookie: u19.cookie });
    const crossAvatar = await req("/api/avatar", { method: "PUT", raw: PNG, headers: { origin: evil }, cookie: u19.cookie });
    const stillIn = await req("/api/me", { cookie: u19.cookie });
    record("19c", crossOut.status === 403 && crossNote.status === 403 && crossAvatar.status === 403 && stillIn.status === 200 &&
      count("note", `"userId" = ?`, u19.userId) === 0,
      `sign-out ${crossOut.status}, note ${crossNote.status}, avatar ${crossAvatar.status}, still signed in ${stillIn.status}`);

    // A cookie-bearing write with neither Origin nor Referer is refused; a
    // same-site Referer in place of Origin is accepted.
    const bare = await req("/api/notes", { method: "POST", body: { body: "no origin" }, cookie: u19.cookie, noOrigin: true });
    const viaReferer = await req("/api/notes", { method: "POST", body: { body: "referer" }, cookie: u19.cookie, noOrigin: true, headers: { referer: `${ORIGIN}/` } });
    record("19d", bare.status === 403 && viaReferer.status === 201 && count("note", `"userId" = ?`, u19.userId) === 1,
      `no Origin or Referer ${bare.status}, same-site Referer ${viaReferer.status}`);

    // The local config opens /admin only for requests to the local server. The
    // same config answering a public hostname must keep /admin closed.
    const guard = await request(base + "/admin", { headers: { host: "app.example.com" } });
    await guard.body.dump();
    const localAdmin = await req("/admin");
    record("18-guard", guard.statusCode === 403 && localAdmin.status === 200,
      `/admin with a public Host ${guard.statusCode}, on 127.0.0.1 ${localAdmin.status}`);

    // S6: every outcome above left one structured event with a request id.
    await settle();
    const text = serverLogText();
    if (text === null) return record("S6", false, "SMOKE_SERVER_LOG not set; run through scripts/local-suite.sh");
    const events = logEvents(text);
    const has = (pred) => events.some((e) => typeof e.requestId === "string" && e.requestId.length > 0 && pred(e));
    const expected = {
      "auth.request 200": (e) => e.event === "auth.request" && e.status === 200,
      "auth.request MISSING_RESPONSE": (e) => e.event === "auth.request" && e.code === "MISSING_RESPONSE",
      "request.origin_rejected": (e) => e.event === "request.origin_rejected",
      "request.unauthenticated": (e) => e.event === "request.unauthenticated",
      "upload.rejected too_large": (e) => e.event === "upload.rejected" && e.reason === "too_large",
      "upload.rejected not_an_image": (e) => e.event === "upload.rejected" && e.reason === "not_an_image",
      "upload.rejected no_length": (e) => e.event === "upload.rejected" && e.reason === "no_length",
      "admin.access_denied": (e) => e.event === "admin.access_denied",
    };
    const missing = Object.entries(expected).filter(([, pred]) => !has(pred)).map(([name]) => name);
    record("S6", missing.length === 0, `${events.length} events; missing: ${missing.join(", ") || "none"}`);

    // S7: nothing that identifies a user or opens a session reaches the logs.
    const secret = readFileSync(".dev.vars", "utf8").match(/^BETTER_AUTH_SECRET=(.+)$/m)?.[1] ?? "";
    const forbidden = { email: "@example.test", password: PASSWORD, "session cookie": "session_token", "turnstile token": PASS_TOKEN, "auth secret": secret };
    const leaks = Object.entries(forbidden).filter(([, needle]) => needle && text.includes(needle)).map(([name]) => name);
    const tokenLeaks = [...seenTokens].filter((tok) => tok.length >= 16 && text.includes(tok)).length;
    record("S7", secret.length > 0 && seenTokens.size > 0 && leaks.length === 0 && tokenLeaks === 0,
      `leaks: ${leaks.join(", ") || "none"}; session token values checked ${seenTokens.size}, found in logs ${tokenLeaks}`);
  },

  // Deployed, no login needed. Turnstile here is the real widget, so only
  // missing and forged tokens can be sent from a script.
  async "deployed-anon"() {
    const root = await req("/");
    const html = await root.text();
    record("1", root.status === 200 && !root.headers.get("x-worker") && html.includes('id="root"'), `${root.status}, x-worker=${root.headers.get("x-worker")}`);

    const asset = html.match(/\/assets\/[^"]+\.js/)?.[0];
    const a = asset ? await req(asset) : null;
    record("2", a?.status === 200 && !a.headers.get("x-worker"), `${asset} -> ${a?.status}, x-worker=${a?.headers.get("x-worker")}`);

    const nav = await navigate("/api/auth/callback/google?code=x&state=y");
    record("3b", nav.worker === "1" && !nav.shell, `${nav.status}, x-worker=${nav.worker}, html-shell=${nav.shell}`);

    const e4 = `d4-${runId}@example.test`;
    const up4 = await signUp(e4, null);
    record("4", up4.status === 400 && count("user", `email = ?`, e4) === 0, `sign-up ${up4.status}, user rows ${count("user", `email = ?`, e4)}`);

    const e5 = `d5-${runId}@example.test`;
    const up5 = await signUp(e5, "forged-token");
    const in5 = await signIn(e5, PASSWORD, "forged-token");
    record("5", up5.status === 403 && in5.status === 403 && count("user", `email = ?`, e5) === 0, `sign-up ${up5.status}, sign-in ${in5.status}, user rows ${count("user", `email = ?`, e5)}`);

    const noCookie = await req("/api/me");
    const junk = await req("/api/me", { cookie: "__Secure-better-auth.session_token=junk.junk" });
    record("9-anon", noCookie.status === 401 && junk.status === 401, `${noCookie.status}, ${junk.status}`);

    const pre = await req("/api/notes", { method: "OPTIONS", headers: { origin: "https://evil.example", "access-control-request-method": "POST" } });
    record("19b", !pre.headers.get("access-control-allow-origin"), `${pre.status}, allow-origin=${pre.headers.get("access-control-allow-origin")}`);

    // With the Access app in place, an unauthenticated /admin goes to its login.
    const admin = await req("/admin");
    const loc = admin.headers.get("location") ?? "";
    record("18-no-login", admin.status === 302 && loc.includes(".cloudflareaccess.com/cdn-cgi/access/login/"),
      `/admin without an Access login -> ${admin.status} to ${new URL(loc || "about:blank").host}`);
  },

  async "no-worker-first"() {
    const nav = await navigate("/api/auth/callback/google?code=x&state=y");
    record("3a", nav.status === 200 && !nav.worker && nav.shell,
      `${nav.status}, x-worker=${nav.worker}, html-shell=${nav.shell} (expected: finding 2 reproduced)`);
  },

  async "ts-fail"() {
    const e = `c5-${runId}@example.test`;
    const up = await signUp(e, "forged-token");
    const inn = await signIn(e, PASSWORD, "forged-token");
    record("5", up.status === 403 && inn.status === 403 && count("user", `email = ?`, e) === 0,
      `sign-up ${up.status}, sign-in ${inn.status}, user rows ${count("user", `email = ?`, e)}`);
  },

  async "ts-spent"() {
    const e = `c5b-${runId}@example.test`;
    const up = await signUp(e);
    record("5b-local", up.status === 403 && count("user", `email = ?`, e) === 0,
      `siteverify said timeout-or-duplicate -> ${up.status}, user rows ${count("user", `email = ?`, e)}`);
  },

  async "ts-host"() {
    const e = `c5c-${runId}@example.test`;
    const up = await signUp(e);
    record("5c", up.status === 403 && count("user", `email = ?`, e) === 0,
      `token for example.com, allowed localhost -> ${up.status}, user rows ${count("user", `email = ?`, e)}`);
  },

  async kv() {
    const u = await newUser("c12a");
    const before = await req("/api/me", { cookie: u.cookie });
    const cached = before.status;
    const kvOps = kvOpsOf(before);
    await req("/api/auth/sign-out", { method: "POST", body: {}, cookie: u.cookie });
    const w = await acceptedWindow(u.cookie, 75);
    // kvOps proves the session check went through KV; without it this case
    // would pass with KV turned off.
    record("12a", cached === 200 && kvOps > 0 && !w.ever, `kv ops on the signed-in check ${kvOps}; ` + `old cookie ${w.ever ? `accepted until ${w.last}s` : "refused from the first poll"} after sign-out with KV secondary storage`);
  },

  async "cookie-cache"() {
    const u = await newUser("c12b");
    await req("/api/me", { cookie: u.cookie });
    await req("/api/auth/sign-out", { method: "POST", body: {}, cookie: u.cookie });
    const w = await acceptedWindow(u.cookie, 75);
    // Recorded, not judged: the page is corrected to whatever this measures.
    record("12b", null, `old cookie ${w.ever ? `accepted until ${w.last}s` : "refused from the first poll"} after sign-out with cookieCache maxAge 60`);
  },

  async "fault-siteverify"() {
    const e = `c22s-${runId}@example.test`;
    const up = await signUp(e);
    record("22-siteverify", up.status >= 500 && count("user", `email = ?`, e) === 0, `${up.status}, user rows ${count("user", `email = ?`, e)}`);
  },

  // Runs with the schema check off, so the 5xx can only come from the session
  // read or the sign-up writes. The cookie is a real signed one from the base
  // group, where it returned 200 (case 9).
  async "fault-d1"() {
    const e = `c22d-${runId}@example.test`;
    const up = await signUp(e);
    const file = stateFile("signed-cookie");
    if (!file) throw new Error("fault-d1 needs SMOKE_STATE_DIR and the base group run first (scripts/local-suite.sh base fault-d1)");
    const cookie = readFileSync(file, "utf8");
    const me = await req("/api/me", { cookie });
    record("22-d1", up.status >= 500 && me.status >= 500 && count("user", `email = ?`, e) === 0,
      `sign-up ${up.status}, /api/me with a valid signed cookie ${me.status}, user rows ${count("user", `email = ?`, e)}`);

    // S6 for failures: the outage shows up as an error event, not only a 500.
    await settle();
    const text = serverLogText() ?? "";
    const errors = logEvents(text).filter((ev) => ev.event === "error.unhandled" && ev.level === "error");
    record("S6-error", errors.length > 0, `${errors.length} error.unhandled events`);
  },

  async "fault-kv"() {
    const e = `c22k-${runId}@example.test`;
    const up = await signUp(e);
    const cookie = cookiesOf(up);
    const me = await req("/api/me", { cookie });
    const kvTried = kvOpsOf(me);
    const out = await req("/api/auth/sign-out", { method: "POST", body: {}, cookie });
    const after = await req("/api/me", { cookie });
    // With KV down, D1 is the authority: the app keeps working and a signed-out
    // cookie is refused. Sign-out's own status is recorded, not judged.
    record("22-kv", up.status === 200 && me.status === 200 && kvTried > 0 && after.status === 401,
      `sign-up ${up.status}, /api/me ${me.status} after ${kvTried} failed kv ops, sign-out ${out.status}, old cookie after sign-out ${after.status}`);
  },

  async "fault-kv-delete"() {
    const u = await newUser("c22kd");
    const kvOps = kvOpsOf(await req("/api/me", { cookie: u.cookie }));
    const out = await req("/api/auth/sign-out", { method: "POST", body: {}, cookie: u.cookie });
    const rows = count("session", `"userId" = ?`, u.userId);
    const w = await acceptedWindow(u.cookie, 90);
    // The D1 row must go; the stale KV copy must not outlive SESSION_CACHE_MAX_TTL (60 here).
    // The cookie must have been served from KV at least once after sign-out;
    // otherwise KV was not in the path and the cap was never tested.
    record("22-kv-delete", kvOps > 0 && out.status === 200 && rows === 0 && w.ever && w.last <= 62,
      `sign-out ${out.status}, D1 session rows ${rows}, stale cookie ${w.ever ? `accepted until ${w.last}s` : "never accepted"} (cap 60)`);
  },

  // Better Auth falls back to a public default secret; the Worker must refuse it.
  // #8: on a fresh server, a first request that does not use auth must not
  // leave Better Auth's schema check pending for the requests after it.
  async "first-admin"() {
    const admin = await req("/admin");
    const e = `f8-${runId}@example.test`;
    const up = await signUp(e).catch((err) => ({ status: `no answer (${err.name})` }));
    record("F8", up.status === 200 && count("user", `email = ?`, e) === 1, `first /admin ${admin.status}, then sign-up ${up.status}`);
  },

  async "no-secret"() {
    const me = await req("/api/me");
    const up = await signUp(`ns-${runId}@example.test`);
    await settle();
    const events = logEvents(serverLogText() ?? "").filter((ev) => ev.event === "config.invalid" && ev.setting === "BETTER_AUTH_SECRET");
    record("23", me.status === 503 && up.status === 503 && events.length > 0,
      `/api/me ${me.status}, sign-up ${up.status}, config.invalid events ${events.length}`);
  },

  async "fault-r2"() {
    const e = `c22r-${runId}@example.test`;
    const up = await signUp(e);
    const cookie = cookiesOf(up);
    const put = await req("/api/avatar", { method: "PUT", raw: PNG, cookie });
    record("22-r2", up.status === 200 && put.status >= 500, `avatar put ${put.status}`);
  },
};

// Polls /api/me with a signed-out cookie once a second. ever says whether it
// was accepted at all; last is the second of the last acceptance. Kept apart
// so "accepted on the first poll" cannot read as "refused from the start".
async function acceptedWindow(cookie, maxSeconds) {
  const started = Date.now();
  let ever = false;
  let last = 0;
  for (let s = 0; s <= maxSeconds; s++) {
    const status = (await req("/api/me", { cookie })).status;
    if (status === 200) {
      ever = true;
      last = Math.round((Date.now() - started) / 1000);
    }
    if (status !== 200 && s > 0 && last < s - 2) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return { ever, last };
}

const run = groups[group];
if (!run) throw new Error(`unknown group ${group}; known: ${Object.keys(groups).join(", ")}`);
await run();

const failed = results.filter((r) => r.ok === false);
const info = results.filter((r) => r.ok === null);
const judged = results.length - info.length;
console.log(`group ${group}: ${judged} cases, ${judged - failed.length} pass, ${failed.length} fail, ${info.length} info`);
if (judged === 0 && info.length === 0) process.exit(1);
if (failed.length > 0) process.exit(1);
