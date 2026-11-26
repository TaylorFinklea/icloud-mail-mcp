// The mail operations the connector allows. Nothing here can send, delete,
// or change flags. Archive is the only write, and it is a MOVE.

export interface FolderInfo {
  path: string;
  name: string;
  specialUse?: string;
  messages?: number;
  unseen?: number;
}

export interface SearchCriteria {
  folder: string;
  since?: Date;
  before?: Date;
  from?: string;
  subject?: string;
  unreadOnly?: boolean;
  limit: number;
}

export interface MessageSummary {
  uid: number;
  folder: string;
  date?: string;
  from?: string;
  to?: string;
  subject?: string;
  unread: boolean;
  flagged: boolean;
  size?: number;
}

export interface MessageBody extends MessageSummary {
  cc?: string;
  replyTo?: string;
  messageId?: string;
  attachments: { filename?: string; mimeType: string; size?: number }[];
  text: string;
  truncated: boolean;
}

export interface ArchiveResult {
  moved: number[];
  archiveFolder: string;
}

export interface MailStore {
  listFolders(): Promise<FolderInfo[]>;
  search(criteria: SearchCriteria): Promise<{ total: number; messages: MessageSummary[] }>;
  read(folder: string, uid: number): Promise<MessageBody | null>;
  archive(folder: string, uids: number[]): Promise<ArchiveResult>;
}

export class MailError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MailError";
  }
}
