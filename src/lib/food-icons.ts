/**
 * Food icon matching.
 *
 * The pantry grid needs a real image per item. We genuinely do not have
 * per-item photographs: receipts are text emails, and onboarding scans are
 * wide shots of a whole shelf with no per-item crops. Showing a shelf photo as
 * an item thumbnail would be actively misleading, so instead every item
 * resolves to a food-specific glyph matched on its name.
 *
 * Matching is longest-keyword-first so "almond milk" beats "milk" and
 * "sweet potato" beats "potato". Category is the second pass, and only an item
 * with no name match AND no category falls through to a generic mark.
 */

export type FoodIcon = {
  glyph: string;
  /** Background tint token, so a grid of items reads as varied but coherent. */
  tone: 'green' | 'red' | 'amber' | 'blue' | 'purple' | 'neutral';
};

const KEYWORD_ICONS: Record<string, FoodIcon> = {
  // --- produce: vegetables
  'sweet potato': { glyph: '🍠', tone: 'amber' },
  'bell pepper': { glyph: '🫑', tone: 'green' },
  'green bean': { glyph: '🫛', tone: 'green' },
  'brussels sprout': { glyph: '🥬', tone: 'green' },
  broccoli: { glyph: '🥦', tone: 'green' },
  spinach: { glyph: '🥬', tone: 'green' },
  kale: { glyph: '🥬', tone: 'green' },
  lettuce: { glyph: '🥬', tone: 'green' },
  cabbage: { glyph: '🥬', tone: 'green' },
  salad: { glyph: '🥗', tone: 'green' },
  carrot: { glyph: '🥕', tone: 'amber' },
  potato: { glyph: '🥔', tone: 'amber' },
  onion: { glyph: '🧅', tone: 'amber' },
  garlic: { glyph: '🧄', tone: 'neutral' },
  tomato: { glyph: '🍅', tone: 'red' },
  cucumber: { glyph: '🥒', tone: 'green' },
  zucchini: { glyph: '🥒', tone: 'green' },
  pepper: { glyph: '🌶️', tone: 'red' },
  mushroom: { glyph: '🍄', tone: 'neutral' },
  corn: { glyph: '🌽', tone: 'amber' },
  peas: { glyph: '🫛', tone: 'green' },
  avocado: { glyph: '🥑', tone: 'green' },
  eggplant: { glyph: '🍆', tone: 'purple' },
  celery: { glyph: '🥬', tone: 'green' },
  asparagus: { glyph: '🥬', tone: 'green' },
  cauliflower: { glyph: '🥦', tone: 'neutral' },
  ginger: { glyph: '🫚', tone: 'amber' },
  olive: { glyph: '🫒', tone: 'green' },

  // --- produce: fruit
  banana: { glyph: '🍌', tone: 'amber' },
  apple: { glyph: '🍎', tone: 'red' },
  orange: { glyph: '🍊', tone: 'amber' },
  lemon: { glyph: '🍋', tone: 'amber' },
  lime: { glyph: '🍋', tone: 'green' },
  strawberr: { glyph: '🍓', tone: 'red' },
  blueberr: { glyph: '🫐', tone: 'blue' },
  raspberr: { glyph: '🫐', tone: 'red' },
  grape: { glyph: '🍇', tone: 'purple' },
  watermelon: { glyph: '🍉', tone: 'red' },
  melon: { glyph: '🍈', tone: 'green' },
  pineapple: { glyph: '🍍', tone: 'amber' },
  mango: { glyph: '🥭', tone: 'amber' },
  peach: { glyph: '🍑', tone: 'amber' },
  pear: { glyph: '🍐', tone: 'green' },
  cherr: { glyph: '🍒', tone: 'red' },
  kiwi: { glyph: '🥝', tone: 'green' },
  coconut: { glyph: '🥥', tone: 'neutral' },

  // --- protein
  'chicken breast': { glyph: '🍗', tone: 'amber' },
  'ground beef': { glyph: '🥩', tone: 'red' },
  chicken: { glyph: '🍗', tone: 'amber' },
  turkey: { glyph: '🦃', tone: 'amber' },
  beef: { glyph: '🥩', tone: 'red' },
  steak: { glyph: '🥩', tone: 'red' },
  pork: { glyph: '🥓', tone: 'red' },
  bacon: { glyph: '🥓', tone: 'red' },
  sausage: { glyph: '🌭', tone: 'red' },
  ham: { glyph: '🍖', tone: 'red' },
  salmon: { glyph: '🐟', tone: 'blue' },
  tuna: { glyph: '🐟', tone: 'blue' },
  fish: { glyph: '🐟', tone: 'blue' },
  shrimp: { glyph: '🍤', tone: 'red' },
  egg: { glyph: '🥚', tone: 'amber' },
  tofu: { glyph: '🧊', tone: 'neutral' },

  // --- dairy
  'almond milk': { glyph: '🥛', tone: 'neutral' },
  'oat milk': { glyph: '🥛', tone: 'neutral' },
  'greek yogurt': { glyph: '🍦', tone: 'neutral' },
  yogurt: { glyph: '🍦', tone: 'neutral' },
  cheese: { glyph: '🧀', tone: 'amber' },
  butter: { glyph: '🧈', tone: 'amber' },
  cream: { glyph: '🥛', tone: 'neutral' },
  milk: { glyph: '🥛', tone: 'neutral' },

  // --- bakery / grains
  'peanut butter': { glyph: '🥜', tone: 'amber' },
  tortilla: { glyph: '🫓', tone: 'amber' },
  bagel: { glyph: '🥯', tone: 'amber' },
  croissant: { glyph: '🥐', tone: 'amber' },
  baguette: { glyph: '🥖', tone: 'amber' },
  bread: { glyph: '🍞', tone: 'amber' },
  rice: { glyph: '🍚', tone: 'neutral' },
  pasta: { glyph: '🍝', tone: 'amber' },
  spaghetti: { glyph: '🍝', tone: 'amber' },
  noodle: { glyph: '🍜', tone: 'amber' },
  oat: { glyph: '🥣', tone: 'amber' },
  cereal: { glyph: '🥣', tone: 'amber' },
  flour: { glyph: '🌾', tone: 'amber' },
  quinoa: { glyph: '🌾', tone: 'amber' },

  // --- pantry staples
  bean: { glyph: '🫘', tone: 'red' },
  lentil: { glyph: '🫘', tone: 'amber' },
  chickpea: { glyph: '🫘', tone: 'amber' },
  'olive oil': { glyph: '🫗', tone: 'green' },
  oil: { glyph: '🫗', tone: 'amber' },
  vinegar: { glyph: '🍶', tone: 'amber' },
  sugar: { glyph: '🍬', tone: 'neutral' },
  salt: { glyph: '🧂', tone: 'neutral' },
  honey: { glyph: '🍯', tone: 'amber' },
  sauce: { glyph: '🥫', tone: 'red' },
  salsa: { glyph: '🥫', tone: 'red' },
  soup: { glyph: '🥫', tone: 'amber' },
  canned: { glyph: '🥫', tone: 'neutral' },
  nut: { glyph: '🥜', tone: 'amber' },
  almond: { glyph: '🥜', tone: 'amber' },
  seed: { glyph: '🌰', tone: 'amber' },

  // --- drinks & snacks
  coffee: { glyph: '☕', tone: 'amber' },
  tea: { glyph: '🍵', tone: 'green' },
  juice: { glyph: '🧃', tone: 'amber' },
  water: { glyph: '💧', tone: 'blue' },
  soda: { glyph: '🥤', tone: 'red' },
  beer: { glyph: '🍺', tone: 'amber' },
  wine: { glyph: '🍷', tone: 'purple' },
  chocolate: { glyph: '🍫', tone: 'amber' },
  cookie: { glyph: '🍪', tone: 'amber' },
  chip: { glyph: '🍟', tone: 'amber' },
  cracker: { glyph: '🍘', tone: 'amber' },
  popcorn: { glyph: '🍿', tone: 'amber' },
  'ice cream': { glyph: '🍨', tone: 'neutral' },
};

const CATEGORY_ICONS: Record<string, FoodIcon> = {
  produce: { glyph: '🥬', tone: 'green' },
  meat: { glyph: '🥩', tone: 'red' },
  seafood: { glyph: '🐟', tone: 'blue' },
  dairy: { glyph: '🥛', tone: 'neutral' },
  bakery: { glyph: '🍞', tone: 'amber' },
  frozen: { glyph: '🧊', tone: 'blue' },
  pantry: { glyph: '🥫', tone: 'amber' },
  beverage: { glyph: '🧃', tone: 'blue' },
  snacks: { glyph: '🍿', tone: 'amber' },
  household: { glyph: '🧽', tone: 'neutral' },
};

// Longest keys first so multi-word names win over their single-word substrings.
const SORTED_KEYWORDS = Object.keys(KEYWORD_ICONS).sort((a, b) => b.length - a.length);

export function foodIcon(name: string, category?: string | null): FoodIcon {
  const haystack = name.toLowerCase();

  for (const keyword of SORTED_KEYWORDS) {
    if (haystack.includes(keyword)) return KEYWORD_ICONS[keyword];
  }

  if (category) {
    const byCategory = CATEGORY_ICONS[category.toLowerCase()];
    if (byCategory) return byCategory;
  }

  return { glyph: '🍽️', tone: 'neutral' };
}

/** True when we fell all the way through to the generic mark. */
export function isGenericIcon(icon: FoodIcon): boolean {
  return icon.glyph === '🍽️';
}
