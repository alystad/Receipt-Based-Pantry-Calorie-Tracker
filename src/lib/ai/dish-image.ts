import { openai } from './client';
import { query, queryOne, transaction } from '../db';
import { dishKey } from '../dish-key';
import { findStockPhoto, stockPhotosEnabled } from './stock-photo';

/**
 * Dish photo sourcing, cached by normalized dish name rather than generated
 * fresh per suggestion.
 *
 * Order of operations, cheapest first:
 *   1. Exact cache hit (meal_images.dish_key) — free, no network call at all.
 *   2. Fuzzy cache hit (pg_trgm similarity on dish_key) — catches near-dupe
 *      names the normalizer alone doesn't collapse. Still free.
 *   3. Stock photo search (Unsplash) — a few cents of API budget at most,
 *      appropriate for common/generic dishes that have real photo coverage.
 *   4. AI generation (gpt-image-1, low quality, ~$0.01) — last resort, for
 *      genuinely novel or highly specific dishes stock search comes up empty
 *      on.
 *
 * Whichever tier resolves it, the result is written back to meal_images so
 * every later suggestion — this user's or anyone else's — for the same dish
 * hits tier 1 or 2 instead of paying again.
 *
 * A failure anywhere here is never fatal: image_status flips to 'failed' and
 * the card keeps its food-icon glyph. Fully skippable too — DISH_IMAGES=off
 * disables the whole pipeline with no loss of function.
 */

const AI_MODEL = 'gpt-image-1';
/** Trigram similarity threshold for the fuzzy cache tier — 0..1, higher is stricter. */
const FUZZY_THRESHOLD = 0.45;

export function dishImagesEnabled(): boolean {
  return (process.env.DISH_IMAGES ?? 'on').toLowerCase() !== 'off';
}

function buildPrompt(title: string, plating: string): string {
  return [
    `Appetising overhead food photograph of ${title}.`,
    plating,
    'Natural daylight, shallow depth of field, clean neutral background,',
    'styled like a modern recipe app thumbnail. No text, no hands, no cutlery',
    'brand marks, no watermarks.',
  ].join(' ');
}

type CacheHit = { imageUrl: string };

async function lookupCache(key: string): Promise<CacheHit | null> {
  const exact = await queryOne<{ image_url: string }>(
    `SELECT image_url FROM meal_images WHERE dish_key = $1`,
    [key]
  );
  if (exact) return { imageUrl: exact.image_url };

  // Fuzzy tier: e.g. a typo, singular/plural, or phrasing the stopword
  // stripper alone doesn't normalize away. similarity() needs pg_trgm,
  // enabled in db/schema.sql.
  const fuzzy = await queryOne<{ image_url: string; score: number }>(
    `SELECT image_url, similarity(dish_key, $1) AS score
       FROM meal_images
      WHERE similarity(dish_key, $1) > $2
      ORDER BY score DESC
      LIMIT 1`,
    [key, FUZZY_THRESHOLD]
  );
  return fuzzy ? { imageUrl: fuzzy.image_url } : null;
}

/** Serving path for AI-generated (internally-stored) images — see the route's own scoping note. */
function internalImageUrl(photoId: string): string {
  return `/api/meal-images/${photoId}`;
}

/**
 * Generates and stores the dish image for a suggestion. Returns the resolved
 * image URL, or null when images are disabled or every source failed.
 *
 * Safe to call concurrently: the status check claims the row first, so two
 * requests for the same card cannot both pay for a lookup or generation.
 */
/**
 * Both meal_suggestions (cuisine rows, build-your-own) and suggested_meals
 * (precomputed "Suggested for you") carry the same image_url/image_status
 * columns and the same lazy-resolve-on-scroll flow — this is a fixed,
 * code-controlled allowlist, not user input, so interpolating it into SQL is
 * safe.
 */
type SuggestionTable = 'meal_suggestions' | 'suggested_meals';

export async function ensureDishImage(params: {
  suggestionId: string;
  userId: string;
  table?: SuggestionTable;
}): Promise<string | null> {
  if (!dishImagesEnabled()) return null;
  const table = params.table ?? 'meal_suggestions';

  // Claim the row: only the request that flips 'pending' -> 'generating'
  // proceeds, so a double-tap or two mounted cards cannot double-spend.
  const claimed = await queryOne<{
    id: string;
    title: string;
    description: string | null;
  }>(
    `UPDATE ${table}
        SET image_status = 'generating'
      WHERE id = $1 AND user_id = $2 AND image_status = 'pending'
      RETURNING id, title, description`,
    [params.suggestionId, params.userId]
  );

  if (!claimed) {
    // Someone else is generating, or it is already done/failed.
    const existing = await queryOne<{ image_url: string | null }>(
      `SELECT image_url FROM ${table} WHERE id = $1 AND user_id = $2`,
      [params.suggestionId, params.userId]
    );
    return existing?.image_url ?? null;
  }

  const key = dishKey(claimed.title);

  try {
    // Tiers 1-2: cache.
    const cached = await lookupCache(key);
    if (cached) {
      await query(
        `UPDATE ${table} SET image_url = $2, image_status = 'ready' WHERE id = $1`,
        [params.suggestionId, cached.imageUrl]
      );
      return cached.imageUrl;
    }

    // Tier 3: stock photo, appropriate for common/generic dishes only —
    // Unsplash search relevance is the "is this generic" signal (see file
    // header). A miss here just means try AI next, not an error.
    if (stockPhotosEnabled()) {
      const stock = await findStockPhoto(claimed.title);
      if (stock) {
        await cacheAndApply({
          table,
          suggestionId: params.suggestionId,
          dishKey: key,
          dishName: claimed.title,
          imageUrl: stock.url,
          source: 'stock',
          attribution: stock.attribution,
        });
        return stock.url;
      }
    }

    // Tier 4: AI generation — the only tier that costs real money per call,
    // reserved for dishes novel/specific enough that neither cache nor stock
    // search resolved them.
    const response = await openai().images.generate({
      model: AI_MODEL,
      prompt: buildPrompt(claimed.title, claimed.description ?? ''),
      size: '1024x1024',
      quality: 'low',
      n: 1,
    });

    const b64 = response.data?.[0]?.b64_json;
    if (!b64) throw new Error('Image response contained no data');

    const bytes = Buffer.from(b64, 'base64');

    const photo = await queryOne<{ id: string }>(
      `INSERT INTO photos (user_id, kind, mime_type, bytes, byte_size)
       VALUES ($1, 'dish_render', 'image/png', $2, $3)
       RETURNING id`,
      [params.userId, bytes, bytes.byteLength]
    );
    if (!photo) throw new Error('Failed to store dish image');

    const imageUrl = internalImageUrl(photo.id);
    await cacheAndApply({
      table,
      suggestionId: params.suggestionId,
      dishKey: key,
      dishName: claimed.title,
      imageUrl,
      source: 'ai_generated',
      attribution: null,
    });

    return imageUrl;
  } catch (err) {
    console.error('[dish-image] sourcing failed', err);
    await query(
      `UPDATE ${table} SET image_status = 'failed' WHERE id = $1`,
      [params.suggestionId]
    ).catch(() => undefined);
    return null;
  }
}

/**
 * Writes the resolved image into the shared cache and onto this suggestion,
 * in one transaction. ON CONFLICT DO NOTHING handles the race where two
 * requests source the same brand-new dish at once — the loser's image still
 * serves this suggestion fine, it just doesn't also get cached under a key
 * that already has a row.
 */
async function cacheAndApply(params: {
  table: SuggestionTable;
  suggestionId: string;
  dishKey: string;
  dishName: string;
  imageUrl: string;
  source: 'ai_generated' | 'stock';
  attribution: string | null;
}): Promise<void> {
  await transaction(async (client) => {
    await client.query(
      `INSERT INTO meal_images (dish_key, dish_name, image_url, image_source, attribution)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (dish_key) DO NOTHING`,
      [params.dishKey, params.dishName, params.imageUrl, params.source, params.attribution]
    );
    await client.query(
      `UPDATE ${params.table} SET image_url = $2, image_status = 'ready' WHERE id = $1`,
      [params.suggestionId, params.imageUrl]
    );
  });
}
