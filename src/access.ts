import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

export interface AccessConfig {
  /** e.g. https://yourteam.cloudflareaccess.com */
  teamDomain: string;
  /** The Access application's AUD tag. */
  audience: string;
  /** The only email allowed through. */
  ownerEmail: string;
}

const jwksCache = new Map<string, JWTVerifyGetKey>();

function remoteJwks(teamDomain: string): JWTVerifyGetKey {
  let jwks = jwksCache.get(teamDomain);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL("/cdn-cgi/access/certs", teamDomain));
    jwksCache.set(teamDomain, jwks);
  }
  return jwks;
}

/**
 * Checks the Cloudflare Access token on a request and returns true only for
 * the owner. Access must protect the /authorize path; this is the second
 * check in case that policy is ever loosened or bypassed.
 */
export async function isOwner(
  request: Request,
  config: AccessConfig,
  getKey: JWTVerifyGetKey = remoteJwks(config.teamDomain),
): Promise<boolean> {
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) return false;
  try {
    const { payload } = await jwtVerify(token, getKey, {
      issuer: config.teamDomain.replace(/\/$/, ""),
      audience: config.audience,
    });
    const email = typeof payload.email === "string" ? payload.email.toLowerCase() : "";
    return email !== "" && email === config.ownerEmail.trim().toLowerCase();
  } catch {
    return false;
  }
}

/** Only these redirect hosts may receive an authorization code. */
export function redirectAllowed(redirectUri: string, allowedHosts: readonly string[]): boolean {
  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    return false;
  }
  return url.protocol === "https:" && allowedHosts.includes(url.hostname.toLowerCase());
}
