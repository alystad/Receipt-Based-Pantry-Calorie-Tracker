import { query, queryOne, transaction } from './db';
import { savePhoto, toDataUrl } from './photos';
import { classifyCapturedPhoto, type PhotoKind } from './ai/classify';
import { parseReceiptPhoto } from './ai/receipts';
import { ingestReceiptItems, backfillNutrition } from './pantry';
import { logMealFromPhoto, type LoggedMeal } from './meals';

/**
 * One camera button, two pipelines.
 *
 * The floating "+" no longer commits to "this is a meal" the moment a photo
 * is taken — it classifies first (src/lib/ai/classify.ts), then routes to
 * whichever existing pipeline actually applies:
 *
 *   receipt -> parseReceiptPhoto() -> ingestReceiptItems() — the exact same
 *              pantry-population path a Gmail e-receipt goes through, so
 *              pantry items land identically regardless of source.
 *   meal    -> logMealFromPhoto() — completely unchanged from the direct
 *              camera-capture flow that existed before this file.
 *
 * This module is the routing layer only. Neither pipeline's own logic, nor
 * the Postgres tables either one writes to, changed to build this.
 */

const CONFIDENCE_THRESHOLD = 0.55;

export type CaptureResult =
  | {
      kind: 'meal';
      classification: { autoDetected: PhotoKind; confidence: number; corrected: boolean };
      meal: LoggedMeal;
    }
  | {
      kind: 'receipt';
      classification: { autoDetected: PhotoKind; confidence: number; corrected: boolean };
      receipt: { itemsAdded: number; storeName: string | null; totalCents: number | null };
    };

export async function processCapturedPhoto(params: {
  userId: string;
  bytes: Buffer;
  mimeType?: string;
  note?: string | null;
  /** Set when the user overrides a wrong auto-classification — see CaptureFab.tsx. */
  forceKind?: PhotoKind;
}): Promise<CaptureResult> {
  const { userId, bytes, mimeType } = params;
  const dataUrl = toDataUrl(bytes, mimeType);

  let autoDetected: PhotoKind;
  let confidence: number;

  if (params.forceKind) {
    // The user already told us what it is — no point paying for a
    // classification call we're about to override anyway.
    autoDetected = params.forceKind;
    confidence = 1;
  } else {
    const { classification } = await classifyCapturedPhoto(dataUrl);
    autoDetected = classification.kind;
    confidence = classification.confidence;
  }

  // Low-confidence "receipt" calls default to the meal pipeline rather than
  // the receipt one: a wrongly-triggered receipt parse silently returns zero
  // items (unhelpful), while the meal pipeline already has its own graceful
  // "not food" rejection (NotFoodError) that surfaces a clear message either
  // way. A wrongly-triggered *meal* read on an actual receipt is comparably
  // harmless to bias toward, so only "receipt" gets the confidence gate.
  //
  // A user-supplied forceKind always wins outright — it exists specifically
  // to override whatever auto-detection decided, so it must never be
  // re-second-guessed by that same confidence gate.
  const kind: PhotoKind =
    params.forceKind ??
    (autoDetected === 'receipt' && confidence >= CONFIDENCE_THRESHOLD ? 'receipt' : 'meal');

  const classificationInfo = { autoDetected, confidence, corrected: Boolean(params.forceKind) };

  if (kind === 'receipt') {
    const receipt = await ingestReceiptPhoto({ userId, bytes, mimeType, dataUrl });
    return { kind: 'receipt', classification: classificationInfo, receipt };
  }

  const meal = await logMealFromPhoto({ userId, bytes, mimeType, note: params.note });
  return { kind: 'meal', classification: classificationInfo, meal };
}

async function ingestReceiptPhoto(params: {
  userId: string;
  bytes: Buffer;
  mimeType?: string;
  dataUrl: string;
}): Promise<{ itemsAdded: number; storeName: string | null; totalCents: number | null }> {
  const { userId } = params;

  const { receipt: parsed, model } = await parseReceiptPhoto(params.dataUrl);

  if (!parsed.is_grocery_receipt || parsed.items.length === 0) {
    throw new NotAReceiptError();
  }

  const photoId = await savePhoto({ userId, kind: 'receipt', bytes: params.bytes, mimeType: params.mimeType });

  // Best-effort match against a known store by name — the photo has no
  // sender domain to key off like the Gmail path does, just whatever the
  // model read off the receipt header.
  const storeId = parsed.store_name
    ? (
        await queryOne<{ id: string }>(
          `SELECT id FROM stores WHERE name ILIKE $1 LIMIT 1`,
          [parsed.store_name]
        )
      )?.id ?? null
    : null;

  // photos.id doubles as a synthetic, always-unique "message id" — the
  // receipts table's uniqueness constraint was built for Gmail's
  // (user, gmail_message_id) pairing, and a photo has no email equivalent.
  // Renaming that column for one new source felt like a bigger, riskier
  // change than giving it a synthetic value in exactly this one spot.
  const sourceRef = `photo:${photoId}`;

  const receiptId = await transaction(async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO receipts
         (user_id, store_id, gmail_message_id, email_subject, purchased_at,
          subtotal_cents, tax_cents, total_cents, status, model)
       VALUES ($1,$2,$3,'Receipt photo',$4,$5,$6,$7,'pending',$8)
       RETURNING id`,
      [
        userId,
        storeId,
        sourceRef,
        parsed.purchased_at ? new Date(parsed.purchased_at) : null,
        parsed.subtotal_cents,
        parsed.tax_cents,
        parsed.total_cents,
        model,
      ]
    );
    return rows[0].id;
  });

  const itemsAdded = await ingestReceiptItems({ userId, receiptId, storeId, parsed });

  await query(`UPDATE receipts SET status = 'parsed' WHERE id = $1`, [receiptId]);

  if (itemsAdded > 0) {
    await backfillNutrition(userId).catch((err) => {
      console.error('[capture] nutrition backfill failed', err);
    });
  }

  const storeName = storeId
    ? ((await queryOne<{ name: string }>(`SELECT name FROM stores WHERE id = $1`, [storeId]))?.name ?? null)
    : parsed.store_name;

  return { itemsAdded, storeName, totalCents: parsed.total_cents };
}

export class NotAReceiptError extends Error {
  constructor() {
    super('That did not look like a grocery receipt');
    this.name = 'NotAReceiptError';
  }
}
