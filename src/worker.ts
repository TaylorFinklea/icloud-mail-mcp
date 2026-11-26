import {
  OAuthProvider,
  AuthorizationError,
  CimdFetchError,
  insufficientScope,
  type OAuthResourceContext,
} from "@cloudflare/workers-oauth-provider";
import { isOwner, redirectAllowed } from "./access";
import { consentPage } from "./consent";
import { imapRunner } from "./imap-client";
import { handleMcp } from "./mcp-http";
import { SCOPE_ARCHIVE, SCOPE_READ } from "./tools";

export interface Env {
  OAUTH_KV: KVNamespace;
  /** Your Apple ID email, as iCloud Mail signs in (var). */
  ICLOUD_USER: string;
  /** Apple app-specific password (secret, set with wrangler secret put). */
  ICLOUD_APP_PASSWORD: string;
  /** Public origin of this Worker, e.g. https://mail-mcp.example.com (var). */
  PUBLIC_ORIGIN: string;
  /** e.g. https://yourteam.cloudflareaccess.com (var). */
  ACCESS_TEAM_DOMAIN: string;
  /** AUD tag of the Access application protecting /authorize (var). */
  ACCESS_AUD: string;
  /** The one email Access may let through (var). */
  OWNER_EMAIL: string;
  /** Comma-separated redirect hosts allowed to receive codes (var). */
  ALLOWED_REDIRECT_HOSTS: string;
}

const OWNER_ID = "owner";

const mcpHandler = {
  async fetch(request: Request, env: Env, ctx: OAuthResourceContext<{ userId: string }>): Promise<Response> {
    if (ctx.props?.userId !== OWNER_ID) return new Response("Forbidden", { status: 403 });
    if (!ctx.auth.scope.includes(SCOPE_READ)) return insufficientScope(ctx.auth, [SCOPE_READ]);

    return handleMcp(request, imapRunner(env), ctx.auth.scope);
  },
};

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const text = (body: string, status: number) =>
  new Response(escapeHtml(body), { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });

const defaultHandler = {
  async fetch(request: Request, env: Env & { OAUTH_PROVIDER: any }): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/") return text("iCloud Mail MCP connector. Add /mcp to Claude as a custom connector.", 200);
    if (url.pathname !== "/authorize") return text("Not found", 404);

    const access = {
      teamDomain: env.ACCESS_TEAM_DOMAIN,
      audience: env.ACCESS_AUD,
      ownerEmail: env.OWNER_EMAIL,
    };
    if (!(await isOwner(request, access))) return text("Only the owner can authorize this connector.", 403);

    const oauth = env.OAUTH_PROVIDER;
    const allowedHosts = env.ALLOWED_REDIRECT_HOSTS.split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
    try {
      if (request.method === "GET") {
        const authRequest = await oauth.parseAuthRequest(request);
        if (!redirectAllowed(authRequest.redirectUri, allowedHosts)) {
          return text("This connector only signs in to Claude.", 400);
        }
        const details = await oauth.describeConsent(authRequest);
        const consent = await oauth.beginConsent(authRequest);
        consent.headers.set("Content-Type", "text/html; charset=utf-8");
        // form-action also governs the redirect after the POST, so the
        // allowed redirect hosts must be listed or the browser drops it.
        const formTargets = ["'self'", ...allowedHosts.map((h) => `https://${h}`)].join(" ");
        consent.headers.set("Content-Security-Policy", `default-src 'none'; style-src 'unsafe-inline'; form-action ${formTargets}; frame-ancestors 'none'`);
        return new Response(consentPage(details, consent.handle), { headers: consent.headers });
      }

      if (request.method === "POST") {
        const form = await request.formData();
        const handle = String(form.get("handle") ?? "");
        if (form.get("decision") !== "approve") {
          const denied = await oauth.denyConsent(request, handle);
          return new Response(null, { status: 302, headers: denied.headers });
        }
        const picked = form.getAll("scope").map(String);
        const scope = [SCOPE_READ, ...(picked.includes(SCOPE_ARCHIVE) ? [SCOPE_ARCHIVE] : [])];
        const approved = await oauth.approveConsent(request, handle, { scope });
        if (!redirectAllowed(approved.request.redirectUri, allowedHosts)) {
          return text("This connector only signs in to Claude.", 400);
        }
        const { redirectTo } = await oauth.completeAuthorization({
          request: approved.request,
          userId: OWNER_ID,
          metadata: {},
          scope,
          props: { userId: OWNER_ID },
        });
        approved.headers.set("Location", redirectTo);
        return new Response(null, { status: 302, headers: approved.headers });
      }
      return text("Method not allowed", 405);
    } catch (error) {
      if (error instanceof AuthorizationError && error.redirectTo) return Response.redirect(error.redirectTo, 302);
      if (error instanceof AuthorizationError) return text(error.description, 400);
      if (error instanceof CimdFetchError) return text("This app could not be verified.", 400);
      throw error;
    }
  },
};

// resourceMetadata needs the public origin, which only exists at request
// time, so the provider is built on first request and reused.
let provider: OAuthProvider<Env> | undefined;

function getProvider(env: Env): OAuthProvider<Env> {
  provider ??= new OAuthProvider<Env>({
    apiRoute: "/mcp",
    apiHandler: mcpHandler as any,
    defaultHandler: defaultHandler as any,
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/token",
    clientRegistrationEndpoint: "/register",
    scopesSupported: [SCOPE_READ, SCOPE_ARCHIVE, "offline_access"],
    requiredScopes: [SCOPE_READ],
    resourceMetadata: {
      resource: `${env.PUBLIC_ORIGIN}/mcp`,
      authorization_servers: [env.PUBLIC_ORIGIN],
    },
    clientIdMetadataDocumentEnabled: true,
    accessTokenTTL: 60 * 60,
  });
  return provider;
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return getProvider(env).fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
