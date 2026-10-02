/**
 * Free stock photo sourcing (Unsplash), tried before paying for an AI render.
 *
 * Unsplash's own search relevance is the heuristic for "is this a common,
 * generic dish": a plain-English dish title ("grilled chicken and rice")
 * reliably finds a good match in Unsplash's large food catalog, while a
 * genuinely novel or highly specific AI-invented name ("Gochujang-Glazed
 * Salmon Tostada Stack") usually doesn't. So the rule is simply: try the
 * search; a result means "common enough to have stock coverage", no result
 * (or no key configured) falls through to AI generation.
 */

import { env } from '../env';

const UNSPLASH_API = 'https://api.unsplash.com/search/photos';

export type StockPhoto = {
  url: string;
  attribution: string;
};

export function stockPhotosEnabled(): boolean {
  return Boolean(env.unsplashAccessKey);
}

/**
 * Searches Unsplash for one food photo matching the dish title. Returns null
 * on no match, missing config, or any API failure — this is a cost-saving
 * optimization, never a hard dependency, so it fails silently in favour of
 * the AI-generation fallback.
 */
export async function findStockPhoto(title: string): Promise<StockPhoto | null> {
  const key = env.unsplashAccessKey;
  if (!key) return null;

  const url = new URL(UNSPLASH_API);
  url.searchParams.set('query', `${title} food dish plated`);
  url.searchParams.set('per_page', '1');
  url.searchParams.set('orientation', 'squarish');
  url.searchParams.set('content_filter', 'high');

  try {
    const res = await fetch(url, {
      headers: { Authorization: `Client-ID ${key}` },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return null;

    const data = (await res.json()) as {
      results?: {
        urls?: { small?: string; regular?: string };
        user?: { name?: string };
        links?: { html?: string };
      }[];
    };

    const hit = data.results?.[0];
    // "small" (400px wide) rather than "regular" (1080px): every display
    // context here is a 264px card tile or, at most, a ~560px detail-page
    // hero — 1080px source pixels were pure wasted bandwidth on every load,
    // and since this URL gets cached forever in meal_images, that waste was
    // being paid by every future viewer of the same dish, not just the first.
    const imageUrl = hit?.urls?.small ?? hit?.urls?.regular;
    if (!hit || !imageUrl) return null;

    // Required by Unsplash's API guidelines whenever a photo is displayed.
    const photographer = hit.user?.name ?? 'Unsplash';
    const profileUrl = hit.links?.html ?? 'https://unsplash.com';
    return { url: imageUrl, attribution: `Photo by ${photographer} on Unsplash (${profileUrl})` };
  } catch (err) {
    console.error('[stock-photo] Unsplash lookup failed', err);
    return null;
  }
}
