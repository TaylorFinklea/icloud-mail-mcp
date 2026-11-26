// A synthetic in-memory IMAP stand-in. No real mailbox data.
import type { ImapFetched, ImapLike, ImapListEntry } from "../src/imap-store";

export interface FakeMessage {
  uid: number;
  from: string;
  subject: string;
  date: string;
  seen?: boolean;
  source?: string;
}

export class FakeImap implements ImapLike {
  capabilities = new Map<string, boolean | number>([["IMAP4rev1", true], ["MOVE", true], ["UIDPLUS", true]]);
  locks: { path: string; readOnly: boolean; released: boolean }[] = [];
  searches: Record<string, unknown>[] = [];
  moves: { uids: number[]; from: string; to: string }[] = [];
  failMove = false;
  private current = "";

  constructor(
    public folders: Record<string, FakeMessage[]>,
    public listEntries: ImapListEntry[] = [
      { path: "INBOX", name: "INBOX", status: { messages: 3, unseen: 2 } },
      { path: "Archive", name: "Archive", specialUse: "\\Archive" },
      { path: "Sent Messages", name: "Sent Messages", specialUse: "\\Sent" },
      { path: "Parent", name: "Parent", flags: new Set(["\\Noselect"]) },
    ],
  ) {}

  async list() {
    return this.listEntries;
  }

  async getMailboxLock(path: string, options?: { readOnly?: boolean }) {
    if (!this.folders[path]) throw new Error(`no such mailbox ${path}`);
    this.current = path;
    const lock = { path, readOnly: options?.readOnly === true, released: false };
    this.locks.push(lock);
    return { release: () => void (lock.released = true) };
  }

  async search(query: Record<string, unknown>) {
    this.searches.push(query);
    return this.folders[this.current]
      .filter((m) => (query.seen === false ? !m.seen : true))
      .filter((m) => (typeof query.from === "string" ? m.from.includes(query.from) : true))
      .filter((m) => (query.since instanceof Date ? new Date(m.date) >= query.since : true))
      .map((m) => m.uid);
  }

  async fetchAll(range: number[] | string, query: Record<string, unknown>) {
    const uids = Array.isArray(range) ? range : [];
    return this.folders[this.current].filter((m) => uids.includes(m.uid)).map((m) => this.toFetched(m, query));
  }

  async fetchOne(seq: string, query: Record<string, unknown>) {
    const m = this.folders[this.current].find((x) => x.uid === Number(seq));
    return m ? this.toFetched(m, query) : false;
  }

  async messageMove(range: number[] | string, destination: string) {
    const uids = Array.isArray(range) ? range : [];
    this.moves.push({ uids, from: this.current, to: destination });
    // ImapFlow returns false, rather than throwing, when a move fails.
    if (this.failMove) return false;
    const moving = this.folders[this.current].filter((m) => uids.includes(m.uid));
    this.folders[this.current] = this.folders[this.current].filter((m) => !uids.includes(m.uid));
    this.folders[destination].push(...moving);
    return { path: this.current, destination };
  }

  private toFetched(m: FakeMessage, query: Record<string, unknown>): ImapFetched {
    const source = m.source ?? "";
    const bytes = new TextEncoder().encode(source);
    const want = query.source as { maxLength?: number } | undefined;
    return {
      uid: m.uid,
      flags: new Set(m.seen ? ["\\Seen"] : []),
      internalDate: new Date(m.date),
      size: bytes.length,
      envelope: {
        date: new Date(m.date),
        subject: m.subject,
        from: [{ name: m.from.split("@")[0], address: m.from }],
        to: [{ address: "me@example.test" }],
      },
      source: want ? bytes.slice(0, want.maxLength ?? bytes.length) : undefined,
    };
  }
}

export const MULTIPART = [
  "From: Pat Example <pat@example.test>",
  "To: me@example.test",
  "Subject: Quarterly plan",
  "Date: Tue, 17 Nov 2026 10:00:00 +0000",
  "Message-ID: <plan-1@example.test>",
  "MIME-Version: 1.0",
  'Content-Type: multipart/mixed; boundary="b1"',
  "",
  "--b1",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "Hello,\nThe plan is attached.\nPat",
  "--b1",
  'Content-Type: application/pdf; name="plan.pdf"',
  'Content-Disposition: attachment; filename="plan.pdf"',
  "Content-Transfer-Encoding: base64",
  "",
  "JVBERi0xLjQKJcfsj6IK",
  "--b1--",
  "",
].join("\r\n");

export const HTML_ONLY = [
  "From: news@example.test",
  "Subject: Newsletter",
  "MIME-Version: 1.0",
  "Content-Type: text/html; charset=utf-8",
  "",
  "<html><head><style>p{color:red}</style></head><body><p>Big&nbsp;news</p><p>Second &amp; last</p><script>alert(1)</script></body></html>",
  "",
].join("\r\n");

export function sampleFolders(): Record<string, FakeMessage[]> {
  return {
    INBOX: [
      { uid: 101, from: "pat@example.test", subject: "Quarterly plan", date: "2026-11-17T10:00:00Z", source: MULTIPART },
      { uid: 102, from: "news@example.test", subject: "Newsletter", date: "2026-11-18T08:00:00Z", seen: true, source: HTML_ONLY },
      { uid: 103, from: "pat@example.test", subject: "Lunch?", date: "2026-11-18T12:00:00Z" },
    ],
    Archive: [],
    "Sent Messages": [],
  };
}
