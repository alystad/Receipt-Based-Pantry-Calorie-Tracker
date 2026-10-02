import { completeJson, objectSchema, s } from './client';
import { env } from '../env';
import { categoryList, type StoreAisleMap } from '../aisle-map';

/**
 * Aisle classification: which of a store's real, named categories does a
 * grocery item belong to.
 *
 * The category field is a JSON-schema enum built from the store's own aisle
 * map (src/lib/aisle-map.ts), not a free-text field — the model can only
 * return one of the exact category names that map actually has a location
 * for, so a classification can never fail to resolve to an aisle or section
 * afterward. This is the same reason meal slots and health-rating processing
 * levels are enums elsewhere in this codebase: closed sets stay reliable,
 * free text drifts.
 */

export type AisleClassification = { name: string; category: string };

export async function classifyAisles(
  items: { name: string }[],
  map: StoreAisleMap
): Promise<{ classifications: AisleClassification[]; model: string }> {
  if (!items.length) return { classifications: [], model: '' };

  const categories = categoryList(map);

  const schema = objectSchema({
    items: {
      type: 'array',
      items: objectSchema({
        name: s.string,
        category: { type: 'string', enum: categories },
      }),
    },
  });

  const { data, model } = await completeJson<{ items: AisleClassification[] }>({
    model: env.textModel,
    system: `You classify grocery items into the exact department or aisle category
they belong to in a real supermarket.

Pick the SINGLE closest matching category from the allowed list below — you
may not invent a new one. If nothing is a great fit, pick the closest
reasonable match rather than a generic catch-all (e.g. a strange snack still
belongs under a real named category like "Candy" or "Potato chips", not
something you make up).

Allowed categories:
${categories.join(', ')}

Echo the item name back exactly as given.`,
    schemaName: 'aisle_classification',
    schema,
    maxTokens: 4000,
    user: items.map((i) => i.name).join('\n'),
  });

  return { classifications: data.items, model };
}
