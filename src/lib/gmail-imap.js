/**
 * Read-only, on-demand view of the operations mailbox (Gmail/Workspace) over
 * IMAP, for the admin email timeline. Nothing is stored — every call opens a
 * connection, searches "All Mail" for messages involving one person's email
 * (sent, received, and the BCC copies of portal sends), and returns the newest
 * few. Bodies are returned as plain text only (never raw HTML) so the admin UI
 * can't be hit by HTML/script in an inbound email.
 */
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { env } from "../config/env.js";
import { AppError } from "./errors.js";

export function mailboxConfigured() {
  return !!(env.GMAIL_IMAP_USER && env.GMAIL_IMAP_APP_PASSWORD);
}

const addr = (a) => (a ? { name: a.name || null, address: (a.address || "").toLowerCase() } : null);
const addrList = (v) => (v?.value ?? []).map(addr).filter(Boolean);

function snippetOf(text = "", n = 160) {
  const s = text.replace(/\s+/g, " ").trim();
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/**
 * Messages in the operations mailbox that involve `email` (in From/To/Cc),
 * newest first. Each item: { id, direction, from, to, cc, subject, date,
 * snippet, text }. `direction` is "outbound" when the operations account sent
 * it, else "inbound".
 */
export async function fetchMailboxFor(email, { limit = 30 } = {}) {
  if (!mailboxConfigured()) {
    throw new AppError("The operations mailbox is not configured", 503);
  }
  const target = String(email || "").trim().toLowerCase();
  if (!target) return [];
  const opsUser = env.GMAIL_IMAP_USER.toLowerCase();

  const client = new ImapFlow({
    host: env.GMAIL_IMAP_HOST,
    port: env.GMAIL_IMAP_PORT,
    secure: true,
    auth: { user: env.GMAIL_IMAP_USER, pass: env.GMAIL_IMAP_APP_PASSWORD },
    logger: false,
    socketTimeout: 20000,
    greetingTimeout: 10000,
  });

  try {
    await client.connect();
  } catch (e) {
    throw new AppError(`Could not reach the operations mailbox: ${e.message}`, 502);
  }

  try {
    // "All Mail" covers sent + received + BCC copies. Found by special-use so
    // it works regardless of the account's language.
    const boxes = await client.list();
    const allMail = boxes.find((b) => b.specialUse === "\\All")?.path || "[Gmail]/All Mail";
    await client.mailboxOpen(allMail, { readOnly: true });

    // Gmail search across the relevant headers for this person's address.
    const uids = await client.search(
      { gmailRaw: `from:${target} OR to:${target} OR cc:${target}` },
      { uid: true }
    );
    if (!uids || uids.length === 0) return [];

    const newest = uids.slice(-limit); // search returns ascending UIDs
    const out = [];
    for await (const msg of client.fetch(newest, { uid: true, source: true }, { uid: true })) {
      const parsed = await simpleParser(msg.source);
      const from = addrList(parsed.from);
      const text = parsed.text || "";
      out.push({
        id: String(msg.uid),
        direction: from[0]?.address === opsUser ? "outbound" : "inbound",
        from: from[0] || null,
        to: addrList(parsed.to),
        cc: addrList(parsed.cc),
        subject: parsed.subject || "(no subject)",
        date: parsed.date ? parsed.date.toISOString() : null,
        snippet: snippetOf(text),
        text: text || null,
      });
    }
    // Newest first.
    out.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
    return out;
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw new AppError(`Could not read the operations mailbox: ${e.message}`, 502);
  } finally {
    try { await client.logout(); } catch { /* ignore */ }
  }
}
