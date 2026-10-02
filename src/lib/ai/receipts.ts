import { completeJson, objectSchema, s } from './client';
import { env } from '../env';

/**
 * Receipt parsing.
 *
 * Grocery receipts are the reason this app can claim precise macros: the line
 * items are the actual products the user bought, abbreviations and all. The
 * model's job is expansion and structuring, never invention.
 */

export type ParsedReceiptItem = {
  raw_description: string;
  normalized_name: string;
  brand: string | null;
  category: string | null;
  quantity: number;
  unit: string | null;
  package_size: number | null;
  package_unit: string | null;
  unit_price_cents: number | null;
  total_price_cents: number | null;
  confidence: number;
};

export type ParsedReceipt = {
  is_grocery_receipt: boolean;
  store_name: string | null;
  purchased_at: string | null;
  subtotal_cents: number | null;
  tax_cents: number | null;
  total_cents: number | null;
  items: ParsedReceiptItem[];
};

const itemSchema = objectSchema({
  raw_description: s.string,
  normalized_name: s.string,
  brand: s.nullableString,
  category: s.nullableString,
  quantity: s.number,
  unit: s.nullableString,
  package_size: s.nullableNumber,
  package_unit: s.nullableString,
  unit_price_cents: s.nullableNumber,
  total_price_cents: s.nullableNumber,
  confidence: s.number,
});

const receiptSchema = objectSchema({
  is_grocery_receipt: s.boolean,
  store_name: s.nullableString,
  purchased_at: s.nullableString,
  subtotal_cents: s.nullableNumber,
  tax_cents: s.nullableNumber,
  total_cents: s.nullableNumber,
  items: { type: 'array', items: itemSchema },
});

const SYSTEM = `You extract structured grocery purchases from receipt emails.

Rules:
- Only report line items that are food, drink, or household consumables. Skip
  bag fees, deposits, coupons, loyalty discounts, gift cards, and fuel points.
- raw_description: copy the line EXACTLY as printed, including abbreviations.
- normalized_name: the plain-English product name a shopper would say out loud,
  e.g. "PUB GRN BNS 12OZ" becomes "green beans". Lowercase, no brand, no size.
- brand: the brand if identifiable, otherwise null. Store brands count
  (e.g. "Publix", "Great Value").
- quantity: how many packages were bought (usually 1, or 3 for "3 @ 1.99").
- unit: the sold-by unit as printed ("lb", "oz", "each", "bag"), else null.
- package_size + package_unit: the size of ONE package, e.g. 12 + "oz" for a
  12 oz bag. Use null when the receipt does not state a size.
- Prices are integer cents. A weighted item ("1.32 lb @ 2.99/lb") has
  quantity 1.32, unit "lb", unit_price_cents 299.
- category: one of produce, meat, seafood, dairy, bakery, frozen, pantry,
  beverage, snacks, household, other.
- confidence: 0-1, how sure you are of the normalized name. Cryptic
  abbreviations you had to guess should be below 0.6.
- purchased_at: ISO 8601 timestamp of the transaction if present, else null.
- If the email is not a grocery receipt (shipping notice, ad, survey), set
  is_grocery_receipt false and return an empty items array.

Never invent items that are not in the text.`;

export async function parseReceiptEmail(params: {
  text: string;
  subject: string;
  from: string;
  storeHint?: string | null;
}): Promise<{ receipt: ParsedReceipt; model: string }> {
  const { data, model } = await completeJson<ParsedReceipt>({
    model: env.textModel,
    system: SYSTEM,
    schemaName: 'grocery_receipt',
    schema: receiptSchema,
    maxTokens: 6000,
    user: [
      params.storeHint ? `Store (from sender domain): ${params.storeHint}` : '',
      `Subject: ${params.subject}`,
      `From: ${params.from}`,
      '',
      'Email body:',
      params.text,
    ]
      .filter(Boolean)
      .join('\n'),
  });

  return { receipt: data, model };
}

const PHOTO_SYSTEM = `You extract structured grocery purchases from a PHOTOGRAPH of a
paper receipt — do the OCR and the structuring in one pass.

Rules:
- Only report line items that are food, drink, or household consumables. Skip
  bag fees, deposits, coupons, loyalty discounts, gift cards, and fuel points.
- raw_description: transcribe the line as printed, including abbreviations —
  best effort if the photo is angled, creased, or partly lit by flash.
- normalized_name: the plain-English product name a shopper would say out loud,
  e.g. "PUB GRN BNS 12OZ" becomes "green beans". Lowercase, no brand, no size.
- brand: the brand if identifiable, otherwise null. Store brands count
  (e.g. "Publix", "Great Value").
- quantity: how many packages were bought (usually 1, or 3 for "3 @ 1.99").
- unit: the sold-by unit as printed ("lb", "oz", "each", "bag"), else null.
- package_size + package_unit: the size of ONE package, e.g. 12 + "oz" for a
  12 oz bag. Use null when the receipt does not state a size.
- Prices are integer cents. A weighted item ("1.32 lb @ 2.99/lb") has
  quantity 1.32, unit "lb", unit_price_cents 299.
- category: one of produce, meat, seafood, dairy, bakery, frozen, pantry,
  beverage, snacks, household, other.
- confidence: 0-1, how sure you are of the normalized name — lower it for any
  line that was hard to read in the photo, not just cryptic abbreviations.
- store_name: read from the header/logo at the top of the receipt.
- purchased_at: the date/time printed on the receipt, as ISO 8601, else null.
- If the photo is not actually a grocery/store receipt, set
  is_grocery_receipt false and return an empty items array.

Never invent items that are not legible in the photo.`;

/**
 * Same output shape as parseReceiptEmail() — a photographed receipt feeds
 * the identical ingestReceiptItems() pantry-population path in
 * src/lib/pantry.ts as a Gmail e-receipt, so pantry items land consistently
 * no matter which source they came from.
 */
export async function parseReceiptPhoto(
  dataUrl: string
): Promise<{ receipt: ParsedReceipt; model: string }> {
  const { data, model } = await completeJson<ParsedReceipt>({
    model: env.visionModel,
    system: PHOTO_SYSTEM,
    schemaName: 'grocery_receipt_photo',
    schema: receiptSchema,
    maxTokens: 6000,
    images: [{ dataUrl, detail: 'high' }],
    user: 'Extract every grocery line item from this receipt photo.',
  });

  return { receipt: data, model };
}
