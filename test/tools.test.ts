import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { ImapMailStore } from "../src/imap-store";
import { MailError, type MailStore } from "../src/store";
import { buildServer, SCOPE_ARCHIVE, SCOPE_READ, type StoreRunner } from "../src/tools";
import { FakeImap, sampleFolders } from "./fake-imap";

async function connect(scopes: string[], runner?: StoreRunner) {
  const imap = new FakeImap(sampleFolders());
  const run: StoreRunner = runner ?? ((fn) => fn(new ImapMailStore(imap)));
  const server = buildServer(run, scopes);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return { client, imap };
}

const textOf = (res: any) => res.content[0].text as string;

describe("tool list", () => {
  it("hides archive without the archive scope", async () => {
    const { client } = await connect([SCOPE_READ]);
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(["list_folders", "read_message", "search_messages"]);
  });

  it("offers archive with the archive scope, and nothing that sends or deletes", async () => {
    const { client } = await connect([SCOPE_READ, SCOPE_ARCHIVE]);
    const tools = (await client.listTools()).tools;
    expect(tools.map((t) => t.name).sort()).toEqual(["archive_messages", "list_folders", "read_message", "search_messages"]);
    expect(tools.find((t) => t.name === "read_message")?.annotations?.readOnlyHint).toBe(true);
    expect(tools.some((t) => /send|delete|flag/.test(t.name))).toBe(false);
  });
});

describe("tool calls", () => {
  it("searches with date filters and defaults to INBOX", async () => {
    const { client, imap } = await connect([SCOPE_READ]);
    const res = await client.callTool({ name: "search_messages", arguments: { since: "2026-11-18" } });
    const body = JSON.parse(textOf(res));
    expect(body.messages.map((m: any) => m.uid)).toEqual([103, 102]);
    expect(imap.searches[0]).toEqual({ since: new Date("2026-11-18T00:00:00Z") });
  });

  it("rejects malformed dates before touching the mailbox", async () => {
    const { client, imap } = await connect([SCOPE_READ]);
    const res: any = await client.callTool({ name: "search_messages", arguments: { since: "next tuesday" } });
    expect(res.isError).toBe(true);
    expect(imap.searches).toEqual([]);
  });

  it("reads a message", async () => {
    const { client } = await connect([SCOPE_READ]);
    const res = await client.callTool({ name: "read_message", arguments: { uid: 101 } });
    expect(JSON.parse(textOf(res)).subject).toBe("Quarterly plan");
  });

  it("reports a missing message as a tool error", async () => {
    const { client } = await connect([SCOPE_READ]);
    const res: any = await client.callTool({ name: "read_message", arguments: { uid: 404 } });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/No message with uid 404/);
  });

  it("archives", async () => {
    const { client, imap } = await connect([SCOPE_READ, SCOPE_ARCHIVE]);
    const res = await client.callTool({ name: "archive_messages", arguments: { uids: [102] } });
    expect(JSON.parse(textOf(res))).toEqual({ moved: [102], archiveFolder: "Archive" });
    expect(imap.folders.Archive.map((m) => m.uid)).toEqual([102]);
  });

  it("maps sign-in failures to a plain message with no server detail", async () => {
    const failing: StoreRunner = async () => {
      throw Object.assign(new Error("AUTHENTICATIONFAILED secret detail"), { authenticationFailed: true });
    };
    const { client } = await connect([SCOPE_READ], failing);
    const res: any = await client.callTool({ name: "list_folders", arguments: {} });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toBe("iCloud refused the sign-in. The app-specific password may have been revoked.");
  });

  it("passes MailError messages through", async () => {
    const store = { listFolders: async () => { throw new MailError("nope"); } } as unknown as MailStore;
    const { client } = await connect([SCOPE_READ], (fn) => fn(store));
    const res: any = await client.callTool({ name: "list_folders", arguments: {} });
    expect(textOf(res)).toBe("nope");
  });
});
