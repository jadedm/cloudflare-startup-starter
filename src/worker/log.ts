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
  | "cache.kv_failed";

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
