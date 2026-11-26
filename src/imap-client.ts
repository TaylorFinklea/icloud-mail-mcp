import { connect } from "cloudflare:sockets";
import { ImapFlow, createSocketsTransport } from "imapflow";
import { ImapMailStore, type ImapLike } from "./imap-store";
import type { StoreRunner } from "./tools";

export interface ImapEnv {
  ICLOUD_USER: string;
  ICLOUD_APP_PASSWORD: string;
}

/**
 * One IMAP session per tool call: connect over implicit TLS, run, log out.
 * The socket cannot outlive the request on Workers, so nothing is pooled.
 */
export function imapRunner(env: ImapEnv): StoreRunner {
  return async (fn) => {
    const client = new ImapFlow({
      host: "imap.mail.me.com",
      port: 993,
      secure: true,
      auth: { user: env.ICLOUD_USER, pass: env.ICLOUD_APP_PASSWORD },
      // workers-types marks allowHalfOpen required; ImapFlow passes it optional.
      transport: createSocketsTransport(connect as unknown as Parameters<typeof createSocketsTransport>[0]),
      logger: false,
      disableAutoIdle: true,
    });
    await client.connect();
    try {
      return await fn(new ImapMailStore(client as unknown as ImapLike));
    } finally {
      await client.logout().catch(() => client.close());
    }
  };
}
