import { getAccessToken } from './google';
import { readSyncCursor, type SyncCursor } from './gmail-sync-state';

/**
 * Minimal Gmail REST client.
 *
 * Every read goes through messages.list with a `q` search query. We never
 * enumerate the inbox: the OAuth grant is read-only and broad, so narrowing
 * happens server-side at Gmail, and only messages matching the receipt filters
 * are ever fetched in full.
 */

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';

export type StoreMatcher = { slug: string; name: string; emailDomains: string[] };

// ---------------------------------------------------------------------------
// Receipt filters
// ---------------------------------------------------------------------------
// !! PLACEHOLDERS — BOTH CONSTANTS NEED UPDATING ONCE WE CAPTURE A REAL PUBLIX
// !! E-RECEIPT.
//
// `PUBLIX_FROM` is currently the whole publix.com domain, which also catches
// marketing, order-status and survey mail. Tighten it to the exact sending
// address (something like receipts@publix.com or a no-reply subdomain) as soon
// as we have seen one, so we stop paying to parse ads.
//
// `PUBLIX_SUBJECT` is a guess at the subject line. Replace it with the real
// wording once known; if the real subject turns out to be unstable, drop the
// subject clause entirely and rely on the tightened sender instead.
//
// These are the only two knobs that decide what gets fetched, so keep them
// here rather than inlining them into the query builder.
export const PUBLIX_FROM = 'publix.com';
export const PUBLIX_SUBJECT = 'receipt';

/** Upper bound on messages examined per poll, so one run cannot run away. */
export const DEFAULT_MAX_RESULTS = 25;

/**
 * How far back the very first poll for a user reaches. Without it a new
 * connection would have no lower bound, i.e. the whole mailbox.
 */
export const BOOTSTRAP_WINDOW_DAYS = 90;

/**
 * Overlap re-examined on each poll. Gmail's internalDate has second precision
 * and delivery is not strictly ordered, so querying strictly after the cursor
 * can skip a message that landed in the same second. Re-listing a few minutes
 * of mail is free — receipts are deduped by gmail_message_id before any
 * parsing spend.
 */
export const POLL_OVERLAP_MINUTES = 10;

/**
 * Builds the Gmail search query for Publix receipts.
 *
 * Pure and exported so it can be asserted on directly in tests without a
 * Gmail client at all.
 */
export function buildPublixReceiptQuery(cursor: SyncCursor): string {
  const clauses = [
    `from:${PUBLIX_FROM}`,
    `subject:${PUBLIX_SUBJECT}`,
    // Receipts do not arrive in spam/trash, and reading them from there would
    // be surprising.
    '-in:spam',
    '-in:trash',
  ];

  if (cursor.lastInternalDate) {
    // Gmail accepts epoch seconds for after:. Re-examine a short overlap so a
    // message delivered in the same second as the cursor is not skipped.
    const after = new Date(
      cursor.lastInternalDate.getTime() - POLL_OVERLAP_MINUTES * 60_000
    );
    clauses.push(`after:${Math.floor(after.getTime() / 1000)}`);
  } else {
    // First poll for this user: bounded window, never the full mailbox.
    clauses.push(`newer_than:${BOOTSTRAP_WINDOW_DAYS}d`);
  }

  return clauses.join(' ');
}

export type GmailMessageRef = { id: string; threadId: string };

/**
 * The seam for tests: swap in a fake with two methods instead of stubbing
 * fetch or the OAuth layer.
 */
export type GmailClient = {
  listMessageIds(q: string, maxResults: number): Promise<GmailMessageRef[]>;
  fetchMessage(messageId: string): Promise<ParsedEmail>;
};

export function createGmailClient(userId: string): GmailClient {
  return {
    listMessageIds: (q, maxResults) => listMessageIds(userId, q, maxResults),
    fetchMessage: (messageId) => fetchMessage(userId, messageId),
  };
}

export type NewReceiptsResult = {
  /** The exact query sent to Gmail; surfaced for logging and assertions. */
  query: string;
  messages: GmailMessageRef[];
  cursor: SyncCursor;
};

/**
 * Returns the Publix receipt messages that have arrived since the stored
 * cursor. Fetch layer only — it lists message ids and does not read bodies,
 * ingest, or parse anything.
 *
 * `client` and `cursor` are injectable so this can be unit tested against a
 * mocked Gmail client with no database and no network.
 */
export async function getNewPublixReceipts(params: {
  userId: string;
  client?: GmailClient;
  cursor?: SyncCursor;
  maxResults?: number;
}): Promise<NewReceiptsResult> {
  const cursor = params.cursor ?? (await readSyncCursor(params.userId));
  const client = params.client ?? createGmailClient(params.userId);
  const query = buildPublixReceiptQuery(cursor);

  const messages = await client.listMessageIds(
    query,
    params.maxResults ?? DEFAULT_MAX_RESULTS
  );

  return { query, messages, cursor };
}

type ListResponse = {
  messages?: GmailMessageRef[];
  nextPageToken?: string;
};

export async function listMessageIds(
  userId: string,
  q: string,
  maxResults = DEFAULT_MAX_RESULTS
): Promise<GmailMessageRef[]> {
  const token = await getAccessToken(userId);
  const url = new URL(`${GMAIL_API}/messages`);
  // `q` is mandatory here by design — there is no code path that lists
  // messages without a filter.
  url.searchParams.set('q', q);
  url.searchParams.set('maxResults', String(maxResults));

  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    throw new Error(`Gmail list failed (${res.status}): ${await res.text()}`);
  }
  const data = (await res.json()) as ListResponse;
  return data.messages ?? [];
}

type MessagePart = {
  mimeType?: string;
  filename?: string;
  headers?: { name: string; value: string }[];
  body?: { data?: string; size?: number };
  parts?: MessagePart[];
};

type GmailMessage = {
  id: string;
  threadId: string;
  internalDate?: string;
  snippet?: string;
  payload?: MessagePart;
};

export type ParsedEmail = {
  id: string;
  threadId: string;
  subject: string;
  from: string;
  receivedAt: Date | null;
  text: string;
};

export async function fetchMessage(userId: string, messageId: string): Promise<ParsedEmail> {
  const token = await getAccessToken(userId);
  const res = await fetch(`${GMAIL_API}/messages/${messageId}?format=full`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`Gmail get failed (${res.status}): ${await res.text()}`);
  }

  const message = (await res.json()) as GmailMessage;
  const headers = message.payload?.headers ?? [];
  const header = (name: string) =>
    headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';

  return {
    id: message.id,
    threadId: message.threadId,
    subject: header('subject'),
    from: header('from'),
    receivedAt: message.internalDate ? new Date(Number(message.internalDate)) : null,
    text: extractText(message.payload) || message.snippet || '',
  };
}

function decodeBase64Url(data: string): string {
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

/**
 * Walks the MIME tree and returns readable text, preferring text/plain and
 * falling back to a crude HTML strip. Publix sends HTML-only receipts, so the
 * fallback is the common path in practice.
 */
export function extractText(part?: MessagePart): string {
  if (!part) return '';

  const collected: { plain: string[]; html: string[] } = { plain: [], html: [] };

  const walk = (node: MessagePart) => {
    // Skip attachments; receipt bodies are inline.
    if (node.filename) return;

    if (node.body?.data) {
      const decoded = decodeBase64Url(node.body.data);
      if (node.mimeType === 'text/plain') collected.plain.push(decoded);
      else if (node.mimeType === 'text/html') collected.html.push(decoded);
    }
    node.parts?.forEach(walk);
  };
  walk(part);

  if (collected.plain.length) return normalizeWhitespace(collected.plain.join('\n'));
  if (collected.html.length) return htmlToText(collected.html.join('\n'));
  return '';
}

export function htmlToText(html: string): string {
  const text = html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    // Table cells and rows carry the line-item structure the parser needs.
    .replace(/<\/(td|th)>/gi, '\t')
    .replace(/<\/(tr|div|p|h[1-6]|li)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"');

  return normalizeWhitespace(text);
}

function normalizeWhitespace(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter((line) => line.length > 0)
    .join('\n')
    .slice(0, 24_000); // Keep the parser prompt bounded.
}

/** Picks the store whose sender domain appears in the From header. */
export function matchStore(from: string, stores: StoreMatcher[]): StoreMatcher | null {
  const lower = from.toLowerCase();
  return stores.find((s) => s.emailDomains.some((d) => d && lower.includes(d))) ?? null;
}
