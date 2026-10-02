import { query, queryOne } from './db';
import {
  fetchMessage,
  getNewPublixReceipts,
  matchStore,
  type GmailClient,
  type StoreMatcher,
} from './gmail';
import { advanceSyncCursor, touchPolledAt } from './gmail-sync-state';
import { parseReceiptEmail } from './ai/receipts';
import { backfillNutrition, ingestReceiptItems } from './pantry';

/**
 * Gmail -> pantry pipeline.
 *
 * Cheapness matters here: Gmail search is free, the LLM call is not. So the
 * fetch layer narrows to Publix receipts newer than the stored cursor, we skip
 * anything already ingested, and only then spend a parse.
 */

export type SyncResult = {
  scanned: number;
  parsed: number;
  skipped: number;
  failed: number;
  itemsAdded: number;
  errors: string[];
};

async function loadStores(): Promise<{
  matchers: StoreMatcher[];
  idBySlug: Map<string, string>;
}> {
  const rows = await query<{ id: string; slug: string; name: string; email_domains: string[] }>(
    `SELECT id, slug, name, email_domains FROM stores WHERE cardinality(email_domains) > 0`
  );
  return {
    matchers: rows.map((r) => ({ slug: r.slug, name: r.name, emailDomains: r.email_domains })),
    idBySlug: new Map(rows.map((r) => [r.slug, r.id])),
  };
}

export async function syncReceiptsForUser(
  userId: string,
  options: { maxMessages?: number; client?: GmailClient } = {}
): Promise<SyncResult> {
  const maxMessages = options.maxMessages ?? 15;

  const result: SyncResult = {
    scanned: 0, parsed: 0, skipped: 0, failed: 0, itemsAdded: 0, errors: [],
  };

  const { matchers, idBySlug } = await loadStores();

  // The time window comes from the stored cursor, not from a caller-supplied
  // day count, so a poll never re-scans mail it has already been through.
  let messages: { id: string; threadId: string }[];
  try {
    ({ messages } = await getNewPublixReceipts({
      userId,
      client: options.client,
      maxResults: maxMessages,
    }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await query(`UPDATE google_accounts SET sync_error = $2 WHERE user_id = $1`, [
      userId,
      message.slice(0, 500),
    ]);
    throw err;
  }

  result.scanned = messages.length;

  // Newest message we got all the way through, used to move the cursor.
  // Held in an object because it is only ever assigned from inside a closure.
  const highWater: { value: { id: string; receivedAt: Date } | null } = { value: null };
  const noteProcessed = (id: string, receivedAt: Date | null) => {
    if (!receivedAt) return;
    if (!highWater.value || receivedAt > highWater.value.receivedAt) {
      highWater.value = { id, receivedAt };
    }
  };

  // One round trip instead of one per message.
  const known = new Set(
    (
      await query<{ gmail_message_id: string }>(
        `SELECT gmail_message_id FROM receipts
          WHERE user_id = $1 AND gmail_message_id = ANY($2::text[])`,
        [userId, messages.map((m) => m.id)]
      )
    ).map((r) => r.gmail_message_id)
  );

  for (const message of messages) {
    if (known.has(message.id)) {
      result.skipped += 1;
      continue;
    }

    try {
      const email = await fetchMessage(userId, message.id);
      const store = matchStore(email.from, matchers);
      const storeId = store ? (idBySlug.get(store.slug) ?? null) : null;

      const receipt = await queryOne<{ id: string }>(
        `INSERT INTO receipts
           (user_id, store_id, gmail_message_id, gmail_thread_id, email_subject,
            email_from, email_received_at, raw_text, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending')
         ON CONFLICT (user_id, gmail_message_id) DO NOTHING
         RETURNING id`,
        [
          userId, storeId, email.id, email.threadId, email.subject,
          email.from, email.receivedAt, email.text,
        ]
      );

      // Lost a race with a concurrent sync.
      if (!receipt) {
        result.skipped += 1;
        continue;
      }

      const { receipt: parsed, model } = await parseReceiptEmail({
        text: email.text,
        subject: email.subject,
        from: email.from,
        storeHint: store?.name ?? null,
      });

      if (!parsed.is_grocery_receipt || parsed.items.length === 0) {
        await query(
          `UPDATE receipts SET status = 'skipped', model = $2 WHERE id = $1`,
          [receipt.id, model]
        );
        result.skipped += 1;
        // Still fully handled: the cursor should move past it so we never
        // pay to classify this message again.
        noteProcessed(message.id, email.receivedAt);
        continue;
      }

      const added = await ingestReceiptItems({
        userId,
        receiptId: receipt.id,
        storeId,
        parsed,
      });

      await query(
        `UPDATE receipts
            SET status = 'parsed', model = $2, purchased_at = COALESCE($3, email_received_at),
                subtotal_cents = $4, tax_cents = $5, total_cents = $6, parse_error = NULL
          WHERE id = $1`,
        [
          receipt.id,
          model,
          parsed.purchased_at ? new Date(parsed.purchased_at) : null,
          parsed.subtotal_cents,
          parsed.tax_cents,
          parsed.total_cents,
        ]
      );

      result.parsed += 1;
      result.itemsAdded += added;
      noteProcessed(message.id, email.receivedAt);
    } catch (err) {
      // One bad receipt should not abort the run.
      const detail = err instanceof Error ? err.message : String(err);
      result.failed += 1;
      result.errors.push(detail.slice(0, 200));
      await query(
        `UPDATE receipts SET status = 'failed', parse_error = $3
          WHERE user_id = $1 AND gmail_message_id = $2`,
        [userId, message.id, detail.slice(0, 500)]
      ).catch(() => undefined);
    }
  }

  // Only move the cursor when the whole batch came through cleanly. If any
  // message failed, holding the cursor lets the next poll retry it; the
  // gmail_message_id dedupe above stops the successes being redone.
  if (result.failed === 0 && highWater.value) {
    await advanceSyncCursor(userId, {
      lastInternalDate: highWater.value.receivedAt,
      lastMessageId: highWater.value.id,
    });
  } else {
    await touchPolledAt(userId);
  }

  if (result.itemsAdded > 0) {
    try {
      await backfillNutrition(userId);
    } catch (err) {
      console.error('[receipt-sync] nutrition backfill failed', err);
    }
  }

  await query(
    `UPDATE google_accounts
        SET last_synced_at = now(), sync_error = $2, updated_at = now()
      WHERE user_id = $1`,
    [userId, result.errors.length ? result.errors[0].slice(0, 500) : null]
  );

  return result;
}
