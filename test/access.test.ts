import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import { describe, expect, it } from "vitest";
import { isOwner, redirectAllowed } from "../src/access";

const config = {
  teamDomain: "https://team.example.cloudflareaccess.com",
  audience: "aud-123",
  ownerEmail: "Owner@Example.test",
};

async function keys() {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256" };
  return { privateKey, jwks: createLocalJWKSet({ keys: [jwk] }) };
}

async function token(privateKey: CryptoKey, claims: Record<string, unknown>, aud = config.audience, iss = config.teamDomain) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(iss)
    .setAudience(aud)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
}

const req = (jwt?: string) => new Request("https://mcp.example.test/authorize", { headers: jwt ? { "Cf-Access-Jwt-Assertion": jwt } : {} });

describe("isOwner", () => {
  it("accepts the owner, case-insensitively", async () => {
    const { privateKey, jwks } = await keys();
    expect(await isOwner(req(await token(privateKey, { email: "owner@example.test" })), config, jwks)).toBe(true);
  });

  it("rejects another email, wrong audience, wrong issuer, or no token", async () => {
    const { privateKey, jwks } = await keys();
    expect(await isOwner(req(await token(privateKey, { email: "someone@example.test" })), config, jwks)).toBe(false);
    expect(await isOwner(req(await token(privateKey, { email: "owner@example.test" }, "other-aud")), config, jwks)).toBe(false);
    expect(await isOwner(req(await token(privateKey, { email: "owner@example.test" }, config.audience, "https://evil.test")), config, jwks)).toBe(false);
    expect(await isOwner(req(), config, jwks)).toBe(false);
  });

  it("rejects a token signed by another key", async () => {
    const { jwks } = await keys();
    const other = await keys();
    expect(await isOwner(req(await token(other.privateKey, { email: "owner@example.test" })), config, jwks)).toBe(false);
  });
});

describe("redirectAllowed", () => {
  const hosts = ["claude.ai", "claude.com"];
  it("allows only https on listed hosts", () => {
    expect(redirectAllowed("https://claude.ai/api/mcp/auth_callback", hosts)).toBe(true);
    expect(redirectAllowed("https://CLAUDE.com/api/mcp/auth_callback", hosts)).toBe(true);
    expect(redirectAllowed("http://claude.ai/cb", hosts)).toBe(false);
    expect(redirectAllowed("https://claude.ai.evil.test/cb", hosts)).toBe(false);
    expect(redirectAllowed("https://evil.test/?x=claude.ai", hosts)).toBe(false);
    expect(redirectAllowed("not a url", hosts)).toBe(false);
  });
});
