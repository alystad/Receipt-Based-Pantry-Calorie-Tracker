import type { PoolClient } from 'pg';
import { query, transaction } from './db';
import { matchKey, toCanonical, type CanonicalUnit, type NutritionPer100 } from './units';
import { estimateNutrition } from './ai/vision';
import { triggerSuggestedMealsRegen } from './suggestions';

/**
 * Pantry domain logic.
 *
 * Everything that changes a quantity goes through `applyDelta`, which writes a
 * ledger row and updates the cached rollup in the same statement pair. Nothing
 * else in the app should UPDATE pantry_items.quantity directly.
 */

export type LedgerReason =
  | 'purchase'
  | 'consumption'
  | 'onboarding_scan'
  | 'correction'
  | 'waste'
  | 'restock';

export type PantryItemRow = {
  id: string;
  user_id: string;
  name: string;
  match_key: string;
  brand: string | null;
  category: string | null;
  quantity: string;
  unit: CanonicalUnit;
  display_unit: string | null;
  package_size: string | null;
  confidence: number;
  nutrition: NutritionPer100 | null;
  last_seen_at: Date;
};

type EnsureParams = {
  userId: string;
  name: string;
  brand?: string | null;
  category?: string | null;
  unit: CanonicalUnit;
  displayUnit?: string | null;
  packageSize?: number | null;
  source: 'receipt' | 'photo_scan' | 'manual' | 'meal_inference';
  confidence?: number;
  storeId?: string | null;
  lastPriceCents?: number | null;
};

/**
 * Finds or creates the pantry row for a product. Later sightings sharpen the
 * record: a receipt (high confidence, real brand and price) overwrites the
 * guesses left behind by an onboarding photo scan.
 */
export async function ensurePantryItem(
  client: PoolClient,
  params: EnsureParams
): Promise<{ id: string; unit: CanonicalUnit; package_size: number | null }> {
  const key = matchKey(params.name, params.brand);
  const confidence = params.confidence ?? 0.5;

  const { rows } = await client.query<{
    id: string;
    unit: CanonicalUnit;
    package_size: string | null;
  }>(
    `INSERT INTO pantry_items
       (user_id, name, match_key, brand, category, unit, display_unit,
        package_size, source, confidence, store_id, last_price_cents)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (user_id, match_key) DO UPDATE SET
       -- Only let a more confident sighting rewrite the descriptive fields.
       name             = CASE WHEN EXCLUDED.confidence >= pantry_items.confidence
                               THEN EXCLUDED.name ELSE pantry_items.name END,
       brand            = COALESCE(EXCLUDED.brand, pantry_items.brand),
       category         = COALESCE(EXCLUDED.category, pantry_items.category),
       display_unit     = COALESCE(EXCLUDED.display_unit, pantry_items.display_unit),
       package_size     = COALESCE(EXCLUDED.package_size, pantry_items.package_size),
       store_id         = COALESCE(EXCLUDED.store_id, pantry_items.store_id),
       last_price_cents = COALESCE(EXCLUDED.last_price_cents, pantry_items.last_price_cents),
       confidence       = GREATEST(EXCLUDED.confidence, pantry_items.confidence),
       last_seen_at     = now(),
       depleted_at      = NULL,
       updated_at       = now()
     RETURNING id, unit, package_size`,
    [
      params.userId,
      params.name.trim().toLowerCase(),
      key,
      params.brand ?? null,
      params.category ?? null,
      params.unit,
      params.displayUnit ?? null,
      params.packageSize ?? null,
      params.source,
      Math.max(0, Math.min(1, confidence)),
      params.storeId ?? null,
      params.lastPriceCents ?? null,
    ]
  );

  const row = rows[0];
  return {
    id: row.id,
    unit: row.unit,
    package_size: row.package_size == null ? null : Number(row.package_size),
  };
}

/**
 * Converts an amount into the unit the pantry row is tracked in.
 *
 * The awkward case is a mass consumed from a count-tracked item ("ate 120g of
 * a 12oz bag"). With a known package size that is a clean fraction; without
 * one the honest approximation is one package, which the ledger note records
 * so a correction is possible later.
 */
export function convertToItemUnit(
  amount: number,
  from: CanonicalUnit,
  item: { unit: CanonicalUnit; package_size: number | null }
): { amount: number; approximate: boolean } {
  if (from === item.unit) return { amount, approximate: false };

  // g and ml are treated as interchangeable (density ~1). Fine for yogurt and
  // broth, wrong for oil; acceptable at MVP precision.
  if ((from === 'g' && item.unit === 'ml') || (from === 'ml' && item.unit === 'g')) {
    return { amount, approximate: true };
  }

  if (item.unit === 'count') {
    if (item.package_size && item.package_size > 0) {
      return { amount: amount / item.package_size, approximate: false };
    }
    return { amount: 1, approximate: true };
  }

  // count -> mass/volume
  if (item.package_size && item.package_size > 0) {
    return { amount: amount * item.package_size, approximate: false };
  }
  return { amount, approximate: true };
}

type DeltaParams = {
  client: PoolClient;
  userId: string;
  pantryItemId: string;
  delta: number;
  unit: CanonicalUnit;
  reason: LedgerReason;
  sourceType?: string | null;
  sourceId?: string | null;
  note?: string | null;
};

/** Writes one ledger row and refreshes the cached quantity. */
export async function applyDelta(params: DeltaParams): Promise<void> {
  const { client, delta } = params;
  if (!Number.isFinite(delta) || delta === 0) return;

  await client.query(
    `INSERT INTO pantry_transactions
       (user_id, pantry_item_id, delta, unit, reason, source_type, source_id, note)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      params.userId,
      params.pantryItemId,
      delta,
      params.unit,
      params.reason,
      params.sourceType ?? null,
      params.sourceId ?? null,
      params.note ?? null,
    ]
  );

  // Clamped at zero: a vision model over-estimating a portion should empty the
  // shelf, never drive it negative and poison the grocery list.
  await client.query(
    `UPDATE pantry_items
        SET quantity     = GREATEST(0, quantity + $2),
            last_seen_at = CASE WHEN $2 > 0 THEN now() ELSE last_seen_at END,
            updated_at   = now()
      WHERE id = $1`,
    [params.pantryItemId, delta]
  );
}

/** Rebuilds cached quantities from the ledger. Use after a bad import. */
export async function rebuildQuantities(userId: string): Promise<void> {
  await query(
    `UPDATE pantry_items p
        SET quantity = GREATEST(0, COALESCE(t.total, 0)), updated_at = now()
       FROM (SELECT pantry_item_id, SUM(delta) AS total
               FROM pantry_transactions WHERE user_id = $1
              GROUP BY pantry_item_id) t
      WHERE p.id = t.pantry_item_id AND p.user_id = $1`,
    [userId]
  );
}

// --- Receipt ingestion -----------------------------------------------------

import type { ParsedReceipt } from './ai/receipts';

/** Writes parsed receipt lines and credits the pantry. Idempotent per receipt. */
export async function ingestReceiptItems(params: {
  userId: string;
  receiptId: string;
  storeId: string | null;
  parsed: ParsedReceipt;
}): Promise<number> {
  const { userId, receiptId, storeId, parsed } = params;

  return transaction(async (client) => {
    // Re-running a parse replaces the previous lines rather than duplicating.
    await client.query(
      `DELETE FROM pantry_transactions WHERE source_type = 'receipt' AND source_id = $1`,
      [receiptId]
    );
    await client.query(`DELETE FROM receipt_items WHERE receipt_id = $1`, [receiptId]);

    let count = 0;

    for (const item of parsed.items) {
      // One package expressed canonically, e.g. "12 oz" -> 340.19 g. Stored in
      // canonical form so a later consumption can be divided against it.
      const packageCanonical =
        item.package_size && item.package_unit
          ? toCanonical(item.package_size, item.package_unit)
          : null;

      // A known package size gives the true amount purchased; otherwise the
      // line quantity itself is the amount (e.g. 1.32 lb of chicken).
      const canonical = packageCanonical
        ? { amount: packageCanonical.amount * item.quantity, unit: packageCanonical.unit }
        : toCanonical(item.quantity, item.unit);

      const pantryItem = await ensurePantryItem(client, {
        userId,
        name: item.normalized_name,
        brand: item.brand,
        category: item.category,
        unit: canonical.unit,
        displayUnit: item.unit,
        packageSize: packageCanonical?.amount ?? null,
        source: 'receipt',
        // Receipts are the ground truth in this system.
        confidence: Math.max(item.confidence, 0.8),
        storeId,
        lastPriceCents: item.unit_price_cents ?? item.total_price_cents,
      });

      await client.query(
        `INSERT INTO receipt_items
           (receipt_id, raw_description, normalized_name, brand, category, quantity,
            display_unit, package_size, package_unit, unit_price_cents,
            total_price_cents, confidence, pantry_item_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          receiptId,
          item.raw_description,
          item.normalized_name,
          item.brand,
          item.category,
          item.quantity,
          item.unit,
          packageCanonical?.amount ?? null,
          packageCanonical?.unit ?? null,
          item.unit_price_cents,
          item.total_price_cents,
          Math.max(0, Math.min(1, item.confidence)),
          pantryItem.id,
        ]
      );

      const converted = convertToItemUnit(canonical.amount, canonical.unit, pantryItem);
      await applyDelta({
        client,
        userId,
        pantryItemId: pantryItem.id,
        delta: converted.amount,
        unit: pantryItem.unit,
        reason: 'purchase',
        sourceType: 'receipt',
        sourceId: receiptId,
        note: item.raw_description,
      });

      count += 1;
    }

    return count;
  }).then((count) => {
    // Fires only after the transaction actually commits — pantry changes
    // that roll back must not trigger a regeneration off data that never
    // stuck.
    if (count > 0) triggerSuggestedMealsRegen(userId);
    return count;
  });
}

// --- Nutrition backfill ----------------------------------------------------

/**
 * Fills in per-100 nutrition for products that lack it. Called after receipt
 * ingestion and after an onboarding scan, capped so one huge shop cannot turn
 * into an unbounded API bill.
 */
export async function backfillNutrition(userId: string, limit = 25): Promise<number> {
  const pending = await query<{ match_key: string; name: string; brand: string | null }>(
    `SELECT match_key, name, brand
       FROM pantry_items
      WHERE user_id = $1 AND nutrition IS NULL AND depleted_at IS NULL
      ORDER BY last_seen_at DESC
      LIMIT $2`,
    [userId, limit]
  );

  if (!pending.length) return 0;

  const { items } = await estimateNutrition(pending);
  let updated = 0;

  for (const entry of items) {
    const nutrition = {
      calories: entry.calories,
      protein_g: entry.protein_g,
      carbs_g: entry.carbs_g,
      fat_g: entry.fat_g,
      fiber_g: entry.fiber_g,
      sodium_mg: entry.sodium_mg,
    };
    const rows = await query(
      `UPDATE pantry_items
          SET nutrition = $3::jsonb, nutrition_source = 'pantry_product', updated_at = now()
        WHERE user_id = $1 AND match_key = $2 AND nutrition IS NULL
        RETURNING id`,
      [userId, entry.match_key, JSON.stringify(nutrition)]
    );
    updated += rows.length;
  }

  return updated;
}

/** Shortlist handed to the vision model so it can match a meal to real products. */
export async function pantryCandidates(userId: string, limit = 120) {
  return query<{ match_key: string; name: string; brand: string | null }>(
    `SELECT match_key, name, brand
       FROM pantry_items
      WHERE user_id = $1 AND depleted_at IS NULL AND quantity > 0
      ORDER BY last_seen_at DESC
      LIMIT $2`,
    [userId, limit]
  );
}
