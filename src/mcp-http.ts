import { createMcpHandler, isLegacyRequest, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { buildServer, type StoreRunner } from "./tools";

/**
 * Stateless MCP over HTTP with a fresh server per request. 2026-07-28
 * requests go to the SDK's modern handler; 2025-era requests keep the
 * stateless JSON-response transport this connector has always used (the
 * SDK's built-in legacy fallback would answer them as SSE streams instead).
 */
export async function handleMcp(request: Request, run: StoreRunner, scopes: readonly string[]): Promise<Response> {
  const factory = () => buildServer(run, scopes);
  let response: Response;
  if (await isLegacyRequest(request)) {
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await factory().connect(transport);
    response = await transport.handleRequest(request);
  } else {
    response = await createMcpHandler(factory, { legacy: "reject" }).fetch(request);
  }
  if (response.status >= 400) {
    // Transport-level rejections are JSON-RPC errors with no mail content;
    // log them so `wrangler tail` shows why a request was refused.
    const body = await response.clone().text();
    console.warn(`mcp ${response.status}`, request.headers.get("mcp-protocol-version") ?? "-", body.slice(0, 300));
  }
  return response;
}
