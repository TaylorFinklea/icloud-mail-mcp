import PostalMime from "postal-mime";
import {
  MailError,
  type ArchiveResult,
  type FolderInfo,
  type MailStore,
  type MessageBody,
  type MessageSummary,
  type SearchCriteria,
} from "./store";

// The slice of ImapFlow this store uses. Typed structurally so tests can pass
// a fake without a network connection.
export interface ImapLike {
  capabilities: Map<string, boolean | number>;
  list(options?: { statusQuery?: { messages?: boolean; unseen?: boolean } }): Promise<ImapListEntry[]>;
  getMailboxLock(path: string, options?: { readOnly?: boolean }): Promise<{ release(): void }>;
  search(query: Record<string, unknown>, options?: { uid?: boolean }): Promise<number[] | false>;
  fetchAll(range: number[] | string, query: Record<string, unknown>, options?: { uid?: boolean }): Promise<ImapFetched[]>;
  fetchOne(seq: string, query: Record<string, unknown>, options?: { uid?: boolean }): Promise<ImapFetched | false>;
  messageMove(range: number[] | string, destination: string, options?: { uid?: boolean }): Promise<unknown>;
}

export interface ImapListEntry {
  path: string;
  name: string;
  specialUse?: string;
  flags?: Set<string>;
  status?: { messages?: number; unseen?: number };
}

interface ImapAddress {
  name?: string;
  address?: string;
}

export interface ImapFetched {
  uid: number;
  flags?: Set<string>;
  internalDate?: Date | string;
  size?: number;
  envelope?: {
    date?: Date | string;
    subject?: string;
    from?: ImapAddress[];
    to?: ImapAddress[];
    cc?: ImapAddress[];
    replyTo?: ImapAddress[];
    messageId?: string;
  };
  source?: Uint8Array;
}

export interface ImapStoreOptions {
  /** Raw bytes fetched per message before parsing. */
  maxSourceBytes: number;
  /** Characters of body text returned to the model. */
  maxTextChars: number;
  /** Most messages one archive call may move. */
  maxArchiveBatch: number;
}

export const DEFAULT_OPTIONS: ImapStoreOptions = {
  maxSourceBytes: 512 * 1024,
  maxTextChars: 20_000,
  maxArchiveBatch: 50,
};

const SUMMARY_QUERY = { uid: true, flags: true, envelope: true, internalDate: true, size: true };

export class ImapMailStore implements MailStore {
  constructor(
    private readonly client: ImapLike,
    private readonly options: ImapStoreOptions = DEFAULT_OPTIONS,
  ) {}

  async listFolders(): Promise<FolderInfo[]> {
    const entries = await this.client.list({ statusQuery: { messages: true, unseen: true } });
    return entries
      .filter((e) => !e.flags?.has("\\Noselect"))
      .map((e) => ({
        path: e.path,
        name: e.name,
        specialUse: e.specialUse,
        messages: e.status?.messages,
        unseen: e.status?.unseen,
      }));
  }

  async search(c: SearchCriteria): Promise<{ total: number; messages: MessageSummary[] }> {
    const query: Record<string, unknown> = {};
    if (c.since) query.since = c.since;
    if (c.before) query.before = c.before;
    if (c.from) query.from = c.from;
    if (c.subject) query.subject = c.subject;
    if (c.unreadOnly) query.seen = false;
    if (Object.keys(query).length === 0) query.all = true;

    // EXAMINE (read-only) so nothing we do can set \Seen.
    const lock = await this.client.getMailboxLock(c.folder, { readOnly: true });
    try {
      const found = await this.client.search(query, { uid: true });
      const uids = (found || []).slice().sort((a, b) => a - b);
      const newest = uids.slice(-c.limit);
      if (newest.length === 0) return { total: 0, messages: [] };
      const fetched = await this.client.fetchAll(newest, SUMMARY_QUERY, { uid: true });
      const messages = fetched.map((m) => toSummary(m, c.folder)).sort((a, b) => b.uid - a.uid);
      return { total: uids.length, messages };
    } finally {
      lock.release();
    }
  }

  async read(folder: string, uid: number): Promise<MessageBody | null> {
    const lock = await this.client.getMailboxLock(folder, { readOnly: true });
    try {
      // BODY.PEEK via ImapFlow's source fetch, capped in size.
      const msg = await this.client.fetchOne(
        String(uid),
        { ...SUMMARY_QUERY, source: { start: 0, maxLength: this.options.maxSourceBytes } },
        { uid: true },
      );
      if (!msg) return null;
      const summary = toSummary(msg, folder);
      const sourceTruncated = (msg.size ?? 0) > this.options.maxSourceBytes;

      let text = "";
      let attachments: MessageBody["attachments"] = [];
      if (msg.source && msg.source.length > 0) {
        const parsed = await PostalMime.parse(msg.source);
        text = parsed.text?.trim() || htmlToText(parsed.html ?? "");
        attachments = (parsed.attachments ?? []).map((a) => ({
          filename: a.filename ?? undefined,
          mimeType: a.mimeType,
          size: typeof a.content === "string" ? a.content.length : a.content?.byteLength,
        }));
      }
      const textTruncated = text.length > this.options.maxTextChars;
      if (textTruncated) text = text.slice(0, this.options.maxTextChars);

      return {
        ...summary,
        cc: formatAddresses(msg.envelope?.cc),
        replyTo: formatAddresses(msg.envelope?.replyTo),
        messageId: msg.envelope?.messageId,
        attachments,
        text,
        truncated: sourceTruncated || textTruncated,
      };
    } finally {
      lock.release();
    }
  }

  async archive(folder: string, uids: number[]): Promise<ArchiveResult> {
    const unique = [...new Set(uids)];
    if (unique.length === 0) throw new MailError("No messages given to archive.");
    if (unique.length > this.options.maxArchiveBatch) {
      throw new MailError(`Archive at most ${this.options.maxArchiveBatch} messages per call.`);
    }
    // Without MOVE, ImapFlow falls back to COPY + \Deleted + EXPUNGE. With
    // UIDPLUS and uid: true that is UID EXPUNGE of only these UIDs; without it,
    // a plain EXPUNGE could remove other messages already marked \Deleted.
    const caps = this.client.capabilities;
    if (!caps.has("MOVE") && !caps.has("UIDPLUS")) {
      throw new MailError(
        `This server supports neither IMAP MOVE nor UIDPLUS, so archiving is disabled (server offers: ${[...caps.keys()].join(" ")}).`,
      );
    }

    const archiveFolder = await this.findArchiveFolder();
    if (archiveFolder === folder) throw new MailError("Those messages are already in the archive folder.");

    const lock = await this.client.getMailboxLock(folder);
    try {
      // Only move UIDs that really exist in this folder.
      const present = await this.client.fetchAll(unique, { uid: true }, { uid: true });
      const moved = present.map((m) => m.uid).sort((a, b) => a - b);
      // ImapFlow reports a failed move (including a failed COPY, \Deleted or
      // UID EXPUNGE step of the fallback) by returning false, not by throwing.
      if (moved.length > 0 && !(await this.client.messageMove(moved, archiveFolder, { uid: true }))) {
        throw new MailError(
          `The server did not complete the move to ${archiveFolder}. Some messages may still be in ${folder}, or in both folders; check before retrying.`,
        );
      }
      return { moved, archiveFolder };
    } finally {
      lock.release();
    }
  }

  private async findArchiveFolder(): Promise<string> {
    const entries = await this.client.list();
    const bySpecialUse = entries.find((e) => e.specialUse === "\\Archive");
    if (bySpecialUse) return bySpecialUse.path;
    const byName = entries.find((e) => e.path.toLowerCase() === "archive");
    if (byName) return byName.path;
    throw new MailError("No Archive folder found. Create one named Archive in iCloud Mail first.");
  }
}

function toSummary(m: ImapFetched, folder: string): MessageSummary {
  const flags = m.flags ?? new Set<string>();
  return {
    uid: m.uid,
    folder,
    date: toIso(m.envelope?.date ?? m.internalDate),
    from: formatAddresses(m.envelope?.from),
    to: formatAddresses(m.envelope?.to),
    subject: m.envelope?.subject,
    unread: !flags.has("\\Seen"),
    flagged: flags.has("\\Flagged"),
    size: m.size,
  };
}

function toIso(d: Date | string | undefined): string | undefined {
  if (!d) return undefined;
  const date = d instanceof Date ? d : new Date(d);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

export function formatAddresses(list: ImapAddress[] | undefined): string | undefined {
  if (!list || list.length === 0) return undefined;
  return list
    .map((a) => (a.name ? `${a.name} <${a.address ?? ""}>` : a.address ?? ""))
    .filter(Boolean)
    .join(", ");
}

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}
