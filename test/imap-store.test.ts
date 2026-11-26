import { describe, expect, it } from "vitest";
import { DEFAULT_OPTIONS, ImapMailStore, htmlToText } from "../src/imap-store";
import { MailError } from "../src/store";
import { FakeImap, sampleFolders } from "./fake-imap";

const setup = (opts = DEFAULT_OPTIONS) => {
  const imap = new FakeImap(sampleFolders());
  return { imap, store: new ImapMailStore(imap, opts) };
};

describe("listFolders", () => {
  it("skips non-selectable folders and keeps counts", async () => {
    const { store } = setup();
    const folders = await store.listFolders();
    expect(folders.map((f) => f.path)).toEqual(["INBOX", "Archive", "Sent Messages"]);
    expect(folders[0]).toMatchObject({ messages: 3, unseen: 2 });
  });
});

describe("search", () => {
  it("returns newest first, honours limit, opens read-only and releases the lock", async () => {
    const { imap, store } = setup();
    const res = await store.search({ folder: "INBOX", limit: 2 });
    expect(res.total).toBe(3);
    expect(res.messages.map((m) => m.uid)).toEqual([103, 102]);
    expect(imap.locks).toEqual([{ path: "INBOX", readOnly: true, released: true }]);
    expect(imap.searches[0]).toEqual({ all: true });
  });

  it("maps unread and sender filters", async () => {
    const { imap, store } = setup();
    const res = await store.search({ folder: "INBOX", unreadOnly: true, from: "pat@", limit: 20 });
    expect(imap.searches[0]).toEqual({ seen: false, from: "pat@" });
    expect(res.messages.map((m) => m.uid)).toEqual([103, 101]);
    expect(res.messages.every((m) => m.unread)).toBe(true);
    expect(res.messages[0].from).toBe("pat <pat@example.test>");
  });

  it("returns nothing cleanly when no match", async () => {
    const { store } = setup();
    const res = await store.search({ folder: "INBOX", since: new Date("2030-01-01"), limit: 20 });
    expect(res).toEqual({ total: 0, messages: [] });
  });

  it("releases the lock when the server errors", async () => {
    const { imap, store } = setup();
    imap.search = async () => {
      throw new Error("boom");
    };
    await expect(store.search({ folder: "INBOX", limit: 5 })).rejects.toThrow("boom");
    expect(imap.locks[0].released).toBe(true);
  });
});

describe("read", () => {
  it("parses plain text, lists attachments, and stays read-only", async () => {
    const { imap, store } = setup();
    const msg = await store.read("INBOX", 101);
    expect(msg?.text).toBe("Hello,\nThe plan is attached.\nPat");
    expect(msg?.attachments).toEqual([{ filename: "plan.pdf", mimeType: "application/pdf", size: expect.any(Number) }]);
    expect(msg?.truncated).toBe(false);
    expect(msg?.unread).toBe(true);
    expect(imap.locks[0]).toMatchObject({ readOnly: true, released: true });
  });

  it("falls back to HTML converted to text", async () => {
    const { store } = setup();
    const msg = await store.read("INBOX", 102);
    expect(msg?.text).toBe("Big news\nSecond & last");
  });

  it("caps body text and marks it truncated", async () => {
    const { store } = setup({ ...DEFAULT_OPTIONS, maxTextChars: 10 });
    const msg = await store.read("INBOX", 101);
    expect(msg?.text).toHaveLength(10);
    expect(msg?.truncated).toBe(true);
  });

  it("caps raw source bytes", async () => {
    const { store } = setup({ ...DEFAULT_OPTIONS, maxSourceBytes: 200 });
    const msg = await store.read("INBOX", 101);
    expect(msg?.truncated).toBe(true);
  });

  it("returns null for a missing uid", async () => {
    const { store } = setup();
    expect(await store.read("INBOX", 999)).toBeNull();
  });
});

describe("archive", () => {
  it("moves only existing uids to the special-use Archive folder", async () => {
    const { imap, store } = setup();
    const res = await store.archive("INBOX", [101, 103, 103, 999]);
    expect(res).toEqual({ moved: [101, 103], archiveFolder: "Archive" });
    expect(imap.moves).toEqual([{ uids: [101, 103], from: "INBOX", to: "Archive" }]);
    expect(imap.folders.INBOX.map((m) => m.uid)).toEqual([102]);
    expect(imap.locks.at(-1)).toMatchObject({ readOnly: false, released: true });
  });

  it("finds a folder named Archive without special-use", async () => {
    const imap = new FakeImap(sampleFolders(), [
      { path: "INBOX", name: "INBOX" },
      { path: "Archive", name: "Archive" },
    ]);
    const res = await new ImapMailStore(imap).archive("INBOX", [101]);
    expect(res.archiveFolder).toBe("Archive");
  });

  it("refuses without MOVE or UIDPLUS so it never falls back to a plain EXPUNGE", async () => {
    const { imap, store } = setup();
    imap.capabilities.delete("MOVE");
    imap.capabilities.delete("UIDPLUS");
    await expect(store.archive("INBOX", [101])).rejects.toThrow(/neither IMAP MOVE nor UIDPLUS.*IMAP4rev1/);
    expect(imap.moves).toEqual([]);
  });

  it("archives with UIDPLUS when MOVE is missing", async () => {
    const { imap, store } = setup();
    imap.capabilities.delete("MOVE");
    const res = await store.archive("INBOX", [101]);
    expect(res).toEqual({ moved: [101], archiveFolder: "Archive" });
    expect(imap.moves).toEqual([{ uids: [101], from: "INBOX", to: "Archive" }]);
  });

  it("reports an error instead of success when the server fails the move", async () => {
    const { imap, store } = setup();
    imap.capabilities.delete("MOVE");
    imap.failMove = true;
    await expect(store.archive("INBOX", [101])).rejects.toThrow(/did not complete the move to Archive/);
    expect(imap.locks.every((l) => l.released)).toBe(true);
  });

  it("refuses big batches, empty input and archive-to-archive", async () => {
    const { store } = setup();
    await expect(store.archive("INBOX", [])).rejects.toThrow(MailError);
    await expect(store.archive("INBOX", Array.from({ length: 51 }, (_, i) => i + 1))).rejects.toThrow(/at most 50/);
    await expect(store.archive("Archive", [1])).rejects.toThrow(/already in the archive/);
  });

  it("errors when there is no Archive folder", async () => {
    const imap = new FakeImap(sampleFolders(), [{ path: "INBOX", name: "INBOX" }]);
    await expect(new ImapMailStore(imap).archive("INBOX", [101])).rejects.toThrow(/No Archive folder/);
    expect(imap.moves).toEqual([]);
  });
});

describe("htmlToText", () => {
  it("drops scripts and styles and decodes entities", () => {
    expect(htmlToText("<style>x</style><b>a</b>&lt;b&gt;<br>c<script>bad()</script>")).toBe("a <b>\nc");
  });
});
