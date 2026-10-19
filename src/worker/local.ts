import type { Env } from "./env";

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost"]);

// The local shortcuts (open /admin, fault injection) need both the local
// config and a request to the local dev server. Deploying the committed local
// config by mistake therefore leaves /admin closed, because the request then
// arrives on a public hostname.
export const isLocalRequest = (env: Env, req: Request): boolean =>
  env.APP_ENV === "local" && LOCAL_HOSTS.has(new URL(req.url).hostname);
