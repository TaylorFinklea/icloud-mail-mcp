import { describe, expect, it } from "vitest";
import { ImapMailStore } from "../src/imap-store";
import { handleMcp } from "../src/mcp-http";
import { SCOPE_READ, type StoreRunner } from "../src/tools";
import { FakeImap, sampleFolders } from "./fake-imap";

const run: StoreRunner = (fn) => fn(new ImapMailStore(new FakeImap(sampleFolders())));

const post = (body: unknown) =>
  new Request("https://mcp.example.test/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
    body: JSON.stringify(body),
  });

describe("Streamable HTTP endpoint", () => {
  it("initializes, lists tools and calls one over plain HTTP", async () => {
    const init = await handleMcp(
      post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } }),
      run,
      [SCOPE_READ],
    );
    expect(init.status).toBe(200);
    expect(((await init.json()) as any).result.serverInfo.name).toBe("icloud-mail");

    const list = await handleMcp(post({ jsonrpc: "2.0", id: 2, method: "tools/list" }), run, [SCOPE_READ]);
    const names = ((await list.json()) as any).result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain("search_messages");
    expect(names).not.toContain("archive_messages");

    const call = await handleMcp(
      post({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "search_messages", arguments: { unread_only: true } } }),
      run,
      [SCOPE_READ],
    );
    const payload = JSON.parse(((await call.json()) as any).result.content[0].text);
    expect(payload.messages.map((m: { uid: number }) => m.uid)).toEqual([103, 101]);
  });
});
