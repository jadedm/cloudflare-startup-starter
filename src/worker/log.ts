// One JSON object per line. Workers Logs indexes the fields, so events can be
// filtered by name in the dashboard, the query API, or an MCP client.
// Never put an email, password, cookie, token or secret in a field.

type Level = "info" | "warn" | "error";
type Field = string | number | boolean | null | undefined;

export type EventName =
  | "auth.request"
  | "request.origin_rejected"
  | "request.unauthenticated"
  | "upload.rejected"
  | "admin.access_denied"
  | "error.unhandled"
  | "cache.kv_failed"
  | "config.invalid"
  | "auth.not_ready";

const write: Record<Level, (line: string) => void> = {
  info: (line) => console.log(line),
  warn: (line) => console.warn(line),
  error: (line) => console.error(line),
};

// Server errors are errors, refusals are warnings, the rest is information.
export const levelForStatus = (status: number): Level => {
  if (status >= 500) return "error";
  if (status >= 400) return "warn";
  return "info";
};

export const logEvent = (level: Level, event: EventName, fields: Record<string, Field>): void => {
  write[level](JSON.stringify({ level, event, ...fields }));
};

// Which API resource a request was for, from a fixed list, so events can be
// told apart without logging the path and the ids in it.
const API_RESOURCES = new Set(["me", "notes", "avatar"]);
export const apiResourceOf = (path: string): string => {
  const first = path.split("/")[2] ?? "";
  return API_RESOURCES.has(first) ? first : "other";
};

// A fixed category for an error, never its message, which can carry a key or
// a value. D1 errors carry a D1_ prefix; anything else keeps its class name.
export const errorKindOf = (err: unknown): string => {
  if (!(err instanceof Error)) return "unknown";
  if (err.message.startsWith("D1_")) return "d1";
  if (err.message.startsWith("fault injected")) return "fault_injected";
  return err.name;
};

// Cloudflare's ray id, also in the response's cf-ray header, ties a log line
// to a request a user reports. Local dev has none, so a random id stands in.
export const requestIdOf = (req: Request): string => req.headers.get("cf-ray") ?? crypto.randomUUID();

// Better Auth answers failures with a JSON body carrying a code such as
// INVALID_EMAIL_OR_PASSWORD or VERIFICATION_FAILED (Turnstile). The code says
// why without saying who, so it is safe to log.
export const authErrorCode = async (res: Response): Promise<string | null> => {
  if (res.status < 400) return null;
  if (!res.headers.get("content-type")?.includes("application/json")) return null;
  const body = await res
    .clone()
    .json()
    .catch(() => null);
  const code = (body as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : null;
};
