import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";
import { ImapMailStore } from "../src/imap-store";
import { handleMcp } from "../src/mcp-http";
import { SCOPE_READ, type StoreRunner } from "../src/tools";
import { FakeImap, sampleFolders } from "./fake-imap";

const run: StoreRunner = (fn) => fn(new ImapMailStore(new FakeImap(sampleFolders())));

describe("2026-07-28 clients", () => {
  it("negotiates the modern protocol and calls a tool", async () => {
    const versions: string[] = [];
    const transport = new StreamableHTTPClientTransport(new URL("https://mcp.example.test/mcp"), {
      fetch: async (input, init) => {
        const request = new Request(input, init);
        versions.push(request.headers.get("mcp-protocol-version") ?? "-");
        return handleMcp(request, run, [SCOPE_READ]);
      },
    });
    const client = new Client({ name: "t", version: "0" }, { versionNegotiation: { mode: "auto" } });
    await client.connect(transport);

    const res: any = await client.callTool({ name: "search_messages", arguments: { unread_only: true } });
    expect(JSON.parse(res.content[0].text).messages.map((m: { uid: number }) => m.uid)).toEqual([103, 101]);
    expect(versions).toContain("2026-07-28");
    expect(client.getServerCapabilities()?.tools?.listChanged).toBe(false);
    await client.close();
  });
});
