import { Hono } from "hono";
import type { Env } from "./env";
import { assertFaultAllowed, isolateBindings, timingStore, type Bindings, type D1Timing } from "./bindings";
import { authFor, forgetAuth, googleOn, passwordLoginOn, type Auth } from "./auth";
import { accessAllows } from "./access";
import { apiResourceOf, authErrorCode, errorKindOf, levelForStatus, logEvent, requestIdOf } from "./log";

type Vars = {
  requestId: string;
  timing: D1Timing;
  b: Bindings;
  auth: Auth;
  userId: string;
};

const AVATAR_MAX_BYTES = 1024 * 1024;
const NOTE_MAX_CHARS = 10_000;
// JSON overhead on top of the note itself; a body past this is refused unread.
const NOTE_MAX_BODY_BYTES = 64 * 1024;

type ImageType = "image/png" | "image/jpeg" | "image/webp";

const startsWith = (bytes: Uint8Array, sig: number[], offset = 0) =>
  sig.every((v, i) => bytes[offset + i] === v);

// The stored type comes from the bytes, never from the client's header, so an
// HTML file named .png is refused rather than served back as text/html.
const sniffImage = (bytes: Uint8Array): ImageType | null => {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47])) return "image/png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) {
    return "image/webp";
  }
  return null;
};

const isStateChanging = (method: string) => !["GET", "HEAD", "OPTIONS"].includes(method);

const app = new Hono<{ Bindings: Env; Variables: Vars }>();

const AUTH_READY_MS = 5_000;

// True once Better Auth's setup and schema check have settled, either way;
// false if they have not within AUTH_READY_MS.
const authReady = (auth: Auth): Promise<boolean> => {
  const settled = auth.$context
    .then((ctx) => ctx.checkSchema?.())
    .then(() => true, () => true);
  const timeout = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), AUTH_READY_MS));
  return Promise.race([settled, timeout]);
};

// Better Auth falls back to a public default secret when none is set, so a
// deploy that skipped the secret would sign sessions with a known key. Refuse
// to serve instead.
const BETTER_AUTH_DEFAULT_SECRET = "better-auth-secret-12345678901234567890";
const AUTH_SECRET_MIN_LENGTH = 32;
const authSecretUsable = (secret: string | undefined): boolean =>
  typeof secret === "string" && secret.length >= AUTH_SECRET_MIN_LENGTH && secret !== BETTER_AUTH_DEFAULT_SECRET;

app.use("*", async (c, next) => {
  if (!authSecretUsable(c.env.BETTER_AUTH_SECRET)) {
    logEvent("error", "config.invalid", { requestId: requestIdOf(c.req.raw), setting: "BETTER_AUTH_SECRET" });
    return c.json({ error: "server not configured" }, 503);
  }
  assertFaultAllowed(c.env, c.req.raw);
  const timing: D1Timing = { queries: 0, d1Ms: 0, statements: [], kvOps: 0, kvMs: 0 };
  const b = isolateBindings(c.env);
  c.set("requestId", requestIdOf(c.req.raw));
  c.set("timing", timing);
  c.set("b", b);
  c.set("auth", authFor(c.env, b));
  // Building the instance starts Better Auth's schema check, a D1 query, without
  // waiting for it, and the instance is shared by every request this isolate
  // serves. Workers drops I/O left pending when the request that started it
  // ends, so if the first request never used auth (/admin, /api/auth-methods),
  // every later auth request waited on that query forever (#8). Waiting here
  // settles it inside the request that started it. Errors are left for the
  // auth routes, which rethrow them on their own call. The wait is capped: if
  // the check still never settles (that request was cancelled, or D1 hangs),
  // the instance is dropped so the next request starts over instead of every
  // request on the isolate waiting on it.
  if (!(await authReady(c.get("auth")))) {
    forgetAuth(c.env);
    logEvent("error", "auth.not_ready", { requestId: c.get("requestId"), waitedMs: AUTH_READY_MS });
    return c.json({ error: "temporarily unavailable" }, 503);
  }
  await timingStore.run(timing, next);
  // Lets a test tell a Worker response from a direct asset response. Copied
  // first because a Response returned by a handler can have immutable headers.
  c.res = new Response(c.res.body, c.res);
  c.res.headers.set("x-worker", "1");
});

// Which sign-in methods this deploy offers, so the client shows only those.
// Public, and registered before the session check below.
app.get("/api/auth-methods", (c) => {
  const methods = { password: passwordLoginOn(c.env), google: googleOn(c.env) };
  if (!methods.password && !methods.google) {
    logEvent("error", "config.invalid", { requestId: c.get("requestId"), setting: "sign-in method" });
  }
  return c.json(methods);
});

app.on(["GET", "POST"], "/api/auth/*", async (c) => {
  const res = await c.get("auth").handler(c.req.raw);
  const route = new URL(c.req.url).pathname.replace(/^\/api\/auth/, "");
  const code = await authErrorCode(res);
  logEvent(levelForStatus(res.status), "auth.request", { requestId: c.get("requestId"), method: c.req.method, route, status: res.status, code });
  return res;
});

// Where a write came from: Origin, or the origin of Referer when a client
// sends no Origin. Null when neither is present or Referer is not a URL.
const requestSource = (req: Request): string | null => {
  const origin = req.headers.get("origin");
  if (origin) return origin;
  const referer = req.headers.get("referer");
  if (!referer || !URL.canParse(referer)) return null;
  return new URL(referer).origin;
};

// Better Auth checks Origin on its own routes; these are ours. A write that
// carries a cookie must name this app as its source, through Origin or
// Referer, or it is refused before any work is done. Writes without a cookie
// fall through to the session check and get 401 there.
app.use("/api/*", async (c, next) => {
  if (!isStateChanging(c.req.method)) return next();
  if (!c.req.header("cookie")) return next();
  if (requestSource(c.req.raw) === new URL(c.env.BETTER_AUTH_URL).origin) return next();
  logEvent("warn", "request.origin_rejected", { requestId: c.get("requestId"), method: c.req.method, resource: apiResourceOf(c.req.path) });
  return c.json({ error: "origin not allowed" }, 403);
});

app.use("/api/*", async (c, next) => {
  const started = Date.now();
  const session = await c.get("auth").api.getSession({ headers: c.req.raw.headers });
  // Measurement headers, off unless DEBUG_TIMING is "on": they show how long
  // the session check took and which D1 statements it ran.
  if (c.env.DEBUG_TIMING === "on") {
    const timing = c.get("timing");
    c.header(
      "Server-Timing",
      `session;dur=${Date.now() - started}, d1;dur=${timing.d1Ms.toFixed(3)};desc="${timing.queries} queries", kv;dur=${
        timing.kvMs
      };desc="${timing.kvOps} ops", colo;desc="${(c.req.raw.cf?.colo as string | undefined) ?? "local"}"`,
    );
    c.header("x-d1-statements", timing.statements.join(" | "));
  }
  if (!session) {
    logEvent("info", "request.unauthenticated", { requestId: c.get("requestId"), method: c.req.method, resource: apiResourceOf(c.req.path) });
    return c.json({ error: "unauthorized" }, 401);
  }
  c.set("userId", session.user.id);
  await next();
});

app.get("/api/me", (c) => c.json({ userId: c.get("userId") }));

app.post("/api/notes", async (c) => {
  const declared = Number(c.req.header("content-length"));
  if (!Number.isInteger(declared) || declared <= 0) return c.json({ error: "content-length required" }, 411);
  if (declared > NOTE_MAX_BODY_BYTES) return c.json({ error: "too large" }, 413);
  const body = await c.req.json<{ body?: unknown }>().catch(() => ({ body: undefined }));
  if (typeof body.body !== "string" || !body.body) return c.json({ error: "body required" }, 400);
  if (body.body.length > NOTE_MAX_CHARS) return c.json({ error: "too large" }, 413);
  const id = crypto.randomUUID();
  await c
    .get("b")
    .db.prepare(`insert into "note" ("id", "userId", "body", "createdAt") values (?, ?, ?, ?)`)
    .bind(id, c.get("userId"), body.body, new Date().toISOString())
    .run();
  return c.json({ id }, 201);
});

app.get("/api/notes/:id", async (c) => {
  const { results } = await c
    .get("b")
    .db.prepare(`select "id", "body", "createdAt" from "note" where "id" = ? and "userId" = ?`)
    .bind(c.req.param("id"), c.get("userId"))
    .all();
  const note = results[0];
  if (!note) return c.json({ error: "not found" }, 404);
  return c.json(note);
});

type UploadRejection = "no_length" | "too_large" | "not_an_image";
const uploadStatus: Record<UploadRejection, 411 | 413 | 415> = { no_length: 411, too_large: 413, not_an_image: 415 };
const uploadMessage: Record<UploadRejection, string> = {
  no_length: "content-length required",
  too_large: "too large",
  not_an_image: "not a png, jpeg or webp image",
};

// An upload must declare its length, so a chunked body cannot be read into
// memory past the limit before the size check runs.
app.put("/api/avatar", async (c) => {
  const reject = (reason: UploadRejection) => {
    logEvent("warn", "upload.rejected", { requestId: c.get("requestId"), reason });
    return c.json({ error: uploadMessage[reason] }, uploadStatus[reason]);
  };
  const declared = Number(c.req.header("content-length"));
  if (!Number.isInteger(declared) || declared <= 0) return reject("no_length");
  if (declared > AVATAR_MAX_BYTES) return reject("too_large");

  const bytes = new Uint8Array(await c.req.arrayBuffer());
  if (bytes.byteLength > AVATAR_MAX_BYTES) return reject("too_large");

  const contentType = sniffImage(bytes);
  if (!contentType) return reject("not_an_image");

  const key = `avatars/${c.get("userId")}`;
  await c.get("b").uploads.put(key, bytes, { httpMetadata: { contentType } });
  return c.json({ key }, 201);
});

app.get("/api/avatar/:userId", async (c) => {
  if (c.req.param("userId") !== c.get("userId")) return c.json({ error: "not found" }, 404);
  const object = await c.get("b").uploads.get(`avatars/${c.get("userId")}`);
  if (!object) return c.json({ error: "not found" }, 404);
  return new Response(object.body, {
    headers: {
      "content-type": object.httpMetadata?.contentType ?? "application/octet-stream",
      "x-content-type-options": "nosniff",
      "content-disposition": "inline",
    },
  });
});

app.all("/api/*", (c) => c.json({ error: "not found" }, 404));

app.on(["GET", "HEAD"], ["/admin", "/admin/*"], async (c) => {
  if (!(await accessAllows(c.req.raw, c.env))) {
    logEvent("warn", "admin.access_denied", { requestId: c.get("requestId"), route: c.req.routePath });
    return c.text("forbidden", 403);
  }
  return c.html("<!doctype html><title>Admin</title><h1>Admin</h1>");
});

app.onError((err, c) => {
  // A fixed error category, never the message: a message can carry a key or a value.
  logEvent("error", "error.unhandled", { requestId: c.get("requestId"), method: c.req.method, resource: apiResourceOf(c.req.path), error: errorKindOf(err) });
  return c.json({ error: "internal error" }, 500);
});

export default app;
