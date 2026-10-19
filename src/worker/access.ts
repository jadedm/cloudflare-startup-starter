import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Env } from "./env";
import { isLocalRequest } from "./local";

// One key set per team domain per isolate, so its cache of Access signing
// keys survives between requests.
const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

const keySetFor = (issuer: string) => {
  const cached = keySets.get(issuer);
  if (cached) return cached;
  const created = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
  keySets.set(issuer, created);
  return created;
};

// Access only guards the hostname it is attached to. The same Worker can be
// reachable on workers.dev, so the Worker checks the Access token itself.
export const accessAllows = async (req: Request, env: Env): Promise<boolean> => {
  if (isLocalRequest(env, req)) return true;
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return false;

  const token = req.headers.get("cf-access-jwt-assertion");
  if (!token) return false;

  const issuer = `https://${env.ACCESS_TEAM_DOMAIN}`;
  return jwtVerify(token, keySetFor(issuer), { issuer, audience: env.ACCESS_AUD }).then(
    () => true,
    () => false,
  );
};
