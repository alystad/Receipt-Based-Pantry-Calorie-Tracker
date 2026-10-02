import { query, queryOne } from './db';

/**
 * Gmail poll cursor.
 *
 * Kept in its own module so the fetch layer has a single, mockable seam for
 * "where did we get to last time", independent of OAuth credential storage.
 */

export type SyncCursor = {
  lastInternalDate: Date | null;
  lastMessageId: string | null;
};

export async function readSyncCursor(userId: string): Promise<SyncCursor> {
  const row = await queryOne<{ last_internal_date: Date | null; last_message_id: string | null }>(
    `SELECT last_internal_date, last_message_id FROM gmail_sync_state WHERE user_id = $1`,
    [userId]
  );

  return {
    lastInternalDate: row?.last_internal_date ?? null,
    lastMessageId: row?.last_message_id ?? null,
  };
}

/**
 * Moves the cursor forward. Never moves it backwards: a poll that returns only
 * older mail must not cause the next poll to re-scan ground already covered.
 */
export async function advanceSyncCursor(
  userId: string,
  cursor: { lastInternalDate: Date; lastMessageId: string }
): Promise<void> {
  await query(
    `INSERT INTO gmail_sync_state (user_id, last_internal_date, last_message_id, last_polled_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (user_id) DO UPDATE SET
       last_internal_date = GREATEST(
         EXCLUDED.last_internal_date,
         gmail_sync_state.last_internal_date
       ),
       last_message_id = CASE
         WHEN gmail_sync_state.last_internal_date IS NULL
           OR EXCLUDED.last_internal_date >= gmail_sync_state.last_internal_date
         THEN EXCLUDED.last_message_id
         ELSE gmail_sync_state.last_message_id
       END,
       last_polled_at = now(),
       updated_at     = now()`,
    [userId, cursor.lastInternalDate, cursor.lastMessageId]
  );
}

/** Records that a poll happened even when it found nothing worth ingesting. */
export async function touchPolledAt(userId: string): Promise<void> {
  await query(
    `INSERT INTO gmail_sync_state (user_id, last_polled_at)
     VALUES ($1, now())
     ON CONFLICT (user_id) DO UPDATE SET last_polled_at = now(), updated_at = now()`,
    [userId]
  );
}

/** Clears the cursor so the next poll re-scans the bootstrap window. */
export async function resetSyncCursor(userId: string): Promise<void> {
  await query(
    `UPDATE gmail_sync_state
        SET last_internal_date = NULL, last_message_id = NULL, updated_at = now()
      WHERE user_id = $1`,
    [userId]
  );
}
