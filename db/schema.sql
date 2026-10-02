-- =============================================================================
-- Pantry MVP schema
-- =============================================================================
-- Design notes:
--   * Quantities live in a ledger (pantry_transactions). pantry_items.quantity
--     is a cached rollup so the dashboard reads one row per item, but the
--     ledger is the source of truth and can always rebuild it. This is what
--     makes passive deduction from meal photos safe: a bad vision guess is one
--     reversible ledger row, not a destructive overwrite.
--   * Every quantity is stored in a canonical unit (g / ml / count) alongside
--     the display unit the user actually saw on the receipt.
--   * Nutrition is stored per 100 canonical units so pantry-derived macros and
--     model-estimated macros scale identically.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "citext";

-- ---------------------------------------------------------------- enum types
DO $$ BEGIN
  CREATE TYPE canonical_unit AS ENUM ('g', 'ml', 'count');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE pantry_source AS ENUM ('receipt', 'photo_scan', 'manual', 'meal_inference');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE ledger_reason AS ENUM (
    'purchase', 'consumption', 'onboarding_scan', 'correction', 'waste', 'restock'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE parse_status AS ENUM ('pending', 'parsed', 'failed', 'skipped');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE photo_kind AS ENUM ('meal', 'pantry_scan');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE meal_slot AS ENUM ('breakfast', 'lunch', 'dinner', 'snack');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE nutrition_source AS ENUM ('pantry_product', 'model_estimate');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- -------------------------------------------------------------------- users
CREATE TABLE IF NOT EXISTS users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         citext NOT NULL UNIQUE,
  name          text,
  picture_url   text,
  onboarded_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Gmail OAuth credentials. The refresh token is the long-lived secret; access
-- tokens are refreshed on demand by src/lib/google.ts.
CREATE TABLE IF NOT EXISTS google_accounts (
  user_id           uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  google_sub        text NOT NULL UNIQUE,
  access_token      text,
  refresh_token     text,
  token_expires_at  timestamptz,
  scopes            text[] NOT NULL DEFAULT '{}',
  last_synced_at    timestamptz,
  sync_error        text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- The Gmail poll cursor, kept separate from the OAuth credentials above: it is
-- rewritten on every poll, and clearing it (to force a re-scan) must not touch
-- the tokens. Supersedes the unused google_accounts.last_history_id column.
CREATE TABLE IF NOT EXISTS gmail_sync_state (
  user_id            uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  -- Gmail internalDate of the newest message we have fully processed. The next
  -- poll asks Gmail for mail after this instant, so old receipts are never
  -- re-fetched.
  last_internal_date timestamptz,
  -- Kept for debugging: which message set the timestamp above.
  last_message_id    text,
  last_polled_at     timestamptz,
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- Dropped in favour of gmail_sync_state; harmless on a fresh database.
ALTER TABLE google_accounts DROP COLUMN IF EXISTS last_history_id;

-- ------------------------------------------------------------------- stores
-- Item naming, package sizing and availability differ per store, so a grocery
-- list is always rendered against exactly one store.
CREATE TABLE IF NOT EXISTS stores (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug          text NOT NULL UNIQUE,
  name          text NOT NULL,
  -- Sender domains that identify this store's e-receipts.
  email_domains text[] NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now()
);

INSERT INTO stores (slug, name, email_domains) VALUES
  ('publix',  'Publix',         ARRAY['publix.com']),
  ('kroger',  'Kroger',         ARRAY['kroger.com']),
  ('walmart', 'Walmart',        ARRAY['walmart.com']),
  ('target',  'Target',         ARRAY['target.com', 'targetnews.com']),
  ('other',   'Other / manual', ARRAY[]::text[])
ON CONFLICT (slug) DO NOTHING;

CREATE TABLE IF NOT EXISTS user_preferences (
  user_id                uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  cuisines               text[] NOT NULL DEFAULT '{}',  -- e.g. {italian,french}
  equipment              text[] NOT NULL DEFAULT '{}',  -- e.g. {microwave,air_fryer}
  dietary_notes          text[] NOT NULL DEFAULT '{}',
  meals_per_day          int NOT NULL DEFAULT 3 CHECK (meals_per_day BETWEEN 1 AND 6),
  servings_per_meal      int NOT NULL DEFAULT 1 CHECK (servings_per_meal BETWEEN 1 AND 12),
  max_cook_minutes       int NOT NULL DEFAULT 30,
  daily_calorie_target   int,
  daily_protein_target_g int,
  -- Explicit override. When NULL the store is inferred from receipt history.
  preferred_store_id     uuid REFERENCES stores(id) ON DELETE SET NULL,
  updated_at             timestamptz NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------------- photos
-- Photos live in Postgres as bytea. Object storage is the obvious home, but
-- every free tier for it expires; a downscaled JPEG is ~80-150KB and a free
-- Neon tier holds thousands. Swap this table for object keys when that changes.
CREATE TABLE IF NOT EXISTS photos (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        photo_kind NOT NULL,
  mime_type   text NOT NULL DEFAULT 'image/jpeg',
  bytes       bytea NOT NULL,
  byte_size   int NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS photos_user_kind_idx ON photos (user_id, kind, created_at DESC);

-- ----------------------------------------------------------------- receipts
CREATE TABLE IF NOT EXISTS receipts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  store_id          uuid REFERENCES stores(id) ON DELETE SET NULL,
  gmail_message_id  text NOT NULL,
  gmail_thread_id   text,
  email_subject     text,
  email_from        text,
  email_received_at timestamptz,
  purchased_at      timestamptz,
  subtotal_cents    int,
  tax_cents         int,
  total_cents       int,
  -- Plain-text rendering of the email body handed to the parser.
  raw_text          text,
  status            parse_status NOT NULL DEFAULT 'pending',
  parse_error       text,
  model             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, gmail_message_id)
);
CREATE INDEX IF NOT EXISTS receipts_user_idx ON receipts (user_id, purchased_at DESC NULLS LAST);

CREATE TABLE IF NOT EXISTS receipt_items (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_id        uuid NOT NULL REFERENCES receipts(id) ON DELETE CASCADE,
  -- Exactly as printed, e.g. "PUB GRN BNS 12OZ". Kept so lines can be re-parsed
  -- later without another Gmail round trip.
  raw_description   text NOT NULL,
  normalized_name   text NOT NULL,
  brand             text,
  category          text,
  quantity          numeric(12,3) NOT NULL DEFAULT 1,
  display_unit      text,
  package_size      numeric(12,3),
  package_unit      canonical_unit,
  unit_price_cents  int,
  total_price_cents int,
  confidence        real CHECK (confidence BETWEEN 0 AND 1),
  pantry_item_id    uuid,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS receipt_items_receipt_idx ON receipt_items (receipt_id);

-- ------------------------------------------------------------- pantry items
CREATE TABLE IF NOT EXISTS pantry_items (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name              text NOT NULL,
  -- Lowercased, de-branded matching key. Merges receipt lines, scan results
  -- and meal-photo matches into a single row per real-world product.
  match_key         text NOT NULL,
  brand             text,
  category          text,
  quantity          numeric(12,3) NOT NULL DEFAULT 0,
  unit              canonical_unit NOT NULL DEFAULT 'count',
  display_unit      text,
  package_size      numeric(12,3),
  source            pantry_source NOT NULL,
  confidence        real NOT NULL DEFAULT 0.5 CHECK (confidence BETWEEN 0 AND 1),
  store_id          uuid REFERENCES stores(id) ON DELETE SET NULL,
  last_price_cents  int,
  -- Per 100 canonical units:
  -- {calories, protein_g, carbs_g, fat_g, fiber_g, sodium_mg}
  nutrition         jsonb,
  nutrition_source  nutrition_source,
  first_seen_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at      timestamptz NOT NULL DEFAULT now(),
  depleted_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, match_key)
);
CREATE INDEX IF NOT EXISTS pantry_items_user_active_idx
  ON pantry_items (user_id, category, name) WHERE depleted_at IS NULL;

ALTER TABLE receipt_items DROP CONSTRAINT IF EXISTS receipt_items_pantry_item_id_fkey;
ALTER TABLE receipt_items
  ADD CONSTRAINT receipt_items_pantry_item_id_fkey
  FOREIGN KEY (pantry_item_id) REFERENCES pantry_items(id) ON DELETE SET NULL;

-- The append-only ledger. delta is in the item's canonical unit: positive for
-- purchases and restocks, negative for consumption and waste.
CREATE TABLE IF NOT EXISTS pantry_transactions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pantry_item_id  uuid NOT NULL REFERENCES pantry_items(id) ON DELETE CASCADE,
  delta           numeric(12,3) NOT NULL,
  unit            canonical_unit NOT NULL,
  reason          ledger_reason NOT NULL,
  -- Loose polymorphic pointer: 'receipt' | 'meal_log' | 'pantry_scan' | 'user'
  source_type     text,
  source_id       uuid,
  note            text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pantry_tx_item_idx ON pantry_transactions (pantry_item_id, created_at DESC);
CREATE INDEX IF NOT EXISTS pantry_tx_source_idx ON pantry_transactions (source_type, source_id);

-- ------------------------------------------------------------- pantry scans
CREATE TABLE IF NOT EXISTS pantry_scans (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  photo_id      uuid REFERENCES photos(id) ON DELETE SET NULL,
  status        parse_status NOT NULL DEFAULT 'pending',
  model         text,
  items_found   int NOT NULL DEFAULT 0,
  raw_response  jsonb,
  error         text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pantry_scans_user_idx ON pantry_scans (user_id, created_at DESC);

-- ---------------------------------------------------------------- meal logs
CREATE TABLE IF NOT EXISTS meal_logs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  photo_id      uuid REFERENCES photos(id) ON DELETE SET NULL,
  eaten_at      timestamptz NOT NULL DEFAULT now(),
  slot          meal_slot,
  title         text,
  description   text,
  calories      numeric(10,2),
  protein_g     numeric(10,2),
  carbs_g       numeric(10,2),
  fat_g         numeric(10,2),
  fiber_g       numeric(10,2),
  sodium_mg     numeric(10,2),
  confidence    real CHECK (confidence BETWEEN 0 AND 1),
  model         text,
  analysis      jsonb,
  -- Set once ledger deductions for this meal are written, so a retry can never
  -- double-deduct the pantry.
  deducted_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS meal_logs_user_idx ON meal_logs (user_id, eaten_at DESC);

CREATE TABLE IF NOT EXISTS meal_log_items (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  meal_log_id            uuid NOT NULL REFERENCES meal_logs(id) ON DELETE CASCADE,
  name                   text NOT NULL,
  quantity               numeric(12,3),
  display_unit           text,
  -- Canonical amount consumed. Drives both macros and pantry deduction.
  canonical_amount       numeric(12,3),
  canonical_unit         canonical_unit,
  calories               numeric(10,2),
  protein_g              numeric(10,2),
  carbs_g                numeric(10,2),
  fat_g                  numeric(10,2),
  matched_pantry_item_id uuid REFERENCES pantry_items(id) ON DELETE SET NULL,
  match_confidence       real CHECK (match_confidence BETWEEN 0 AND 1),
  nutrition_source       nutrition_source NOT NULL DEFAULT 'model_estimate',
  created_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS meal_log_items_meal_idx ON meal_log_items (meal_log_id);

-- --------------------------------------------------------------- meal plans
CREATE TABLE IF NOT EXISTS meal_plans (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  week_start_date date NOT NULL,
  cuisines        text[] NOT NULL DEFAULT '{}',
  equipment       text[] NOT NULL DEFAULT '{}',
  status          parse_status NOT NULL DEFAULT 'pending',
  model           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, week_start_date)
);

CREATE TABLE IF NOT EXISTS meal_plan_recipes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  meal_plan_id  uuid NOT NULL REFERENCES meal_plans(id) ON DELETE CASCADE,
  day_index     int NOT NULL CHECK (day_index BETWEEN 0 AND 6),
  slot          meal_slot NOT NULL,
  title         text NOT NULL,
  cuisine       text,
  equipment     text[] NOT NULL DEFAULT '{}',
  servings      int NOT NULL DEFAULT 1,
  total_minutes int,
  instructions  text[] NOT NULL DEFAULT '{}',
  nutrition     jsonb,
  notes         text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS meal_plan_recipes_plan_idx
  ON meal_plan_recipes (meal_plan_id, day_index, slot);

CREATE TABLE IF NOT EXISTS meal_plan_ingredients (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipe_id              uuid NOT NULL REFERENCES meal_plan_recipes(id) ON DELETE CASCADE,
  name                   text NOT NULL,
  match_key              text NOT NULL,
  quantity               numeric(12,3),
  display_unit           text,
  canonical_amount       numeric(12,3),
  canonical_unit         canonical_unit,
  -- Set by the planner when the pantry already covers this ingredient.
  covered_by_pantry      boolean NOT NULL DEFAULT false,
  matched_pantry_item_id uuid REFERENCES pantry_items(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS meal_plan_ingredients_recipe_idx ON meal_plan_ingredients (recipe_id);

-- ------------------------------------------------------------- grocery list
CREATE TABLE IF NOT EXISTS grocery_lists (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  meal_plan_id  uuid REFERENCES meal_plans(id) ON DELETE CASCADE,
  store_id      uuid REFERENCES stores(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS grocery_lists_user_idx ON grocery_lists (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS grocery_list_items (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  grocery_list_id       uuid NOT NULL REFERENCES grocery_lists(id) ON DELETE CASCADE,
  name                  text NOT NULL,
  match_key             text NOT NULL,
  category              text,
  quantity              numeric(12,3),
  display_unit          text,
  -- Store-specific phrasing, e.g. "Publix Green Beans, 12 oz bag".
  suggested_package     text,
  estimated_price_cents int,
  -- Recipe titles that need this item, for "why is this on my list?".
  needed_for            text[] NOT NULL DEFAULT '{}',
  checked               boolean NOT NULL DEFAULT false,
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS grocery_list_items_list_idx ON grocery_list_items (grocery_list_id);

-- ------------------------------------------------------- meal suggestions
-- Generated meal ideas: either time-of-day suggestions built from the pantry,
-- or custom meals generated against user-supplied constraints. Cached rather
-- than regenerated per page load, because each row costs an OpenAI call.
CREATE TABLE IF NOT EXISTS meal_suggestions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- 'time_of_day' = the "Suggested for you now" rail.
  -- 'custom'      = generated from constraints in "Build your own".
  source           text NOT NULL DEFAULT 'time_of_day',
  slot             meal_slot,
  title            text NOT NULL,
  description      text,
  cuisine          text,
  prep_minutes     int,
  servings         int NOT NULL DEFAULT 1,
  calories         numeric(10,2),
  protein_g        numeric(10,2),
  carbs_g          numeric(10,2),
  fat_g            numeric(10,2),
  fiber_g          numeric(10,2),
  sugar_added_g    numeric(10,2),
  sat_fat_g        numeric(10,2),
  sodium_mg        numeric(10,2),
  serving_grams    numeric(10,2),
  -- NOVA-style 1 (whole foods) to 4 (ultra-processed); an input to the score.
  processing_level int CHECK (processing_level BETWEEN 1 AND 4),
  -- Computed in src/lib/health-rating.ts, not asked of the model, so the
  -- rubric stays consistent across every meal.
  health_score     int CHECK (health_score BETWEEN 0 AND 100),
  health_grade     text,
  health_reasons   jsonb,
  instructions     text[] NOT NULL DEFAULT '{}',
  -- 0..1 share of ingredients already on the shelf.
  pantry_coverage  real,
  photo_id         uuid REFERENCES photos(id) ON DELETE SET NULL,
  -- 'pending' | 'ready' | 'failed' — dish images render asynchronously.
  image_status     text NOT NULL DEFAULT 'pending',
  constraints      jsonb,
  model            text,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS meal_suggestions_user_idx
  ON meal_suggestions (user_id, source, created_at DESC);

CREATE TABLE IF NOT EXISTS meal_suggestion_ingredients (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  suggestion_id          uuid NOT NULL REFERENCES meal_suggestions(id) ON DELETE CASCADE,
  name                   text NOT NULL,
  match_key              text NOT NULL,
  quantity               numeric(12,3),
  display_unit           text,
  canonical_amount       numeric(12,3),
  canonical_unit         canonical_unit,
  from_pantry            boolean NOT NULL DEFAULT false,
  matched_pantry_item_id uuid REFERENCES pantry_items(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS meal_suggestion_ingredients_idx
  ON meal_suggestion_ingredients (suggestion_id);

-- NOTE: photo_kind gains 'dish_render' (generated dish images) and 'receipt'
-- (photographed receipts, see src/lib/capture.ts) values. Both ALTER TYPE
-- statements run from scripts/migrate.mjs, because PostgreSQL refuses
-- ALTER TYPE ... ADD VALUE from inside a DO block.

-- Carb/fat targets to sit beside the existing calorie and protein targets, so
-- all three macro rings on the home dashboard have a real denominator.
ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS daily_carbs_target_g int;
ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS daily_fat_target_g   int;

-- Optional hard expiry. When NULL the profile pantry grid falls back to a
-- category shelf-life estimate (see src/lib/freshness.ts) and labels it as an
-- estimate rather than claiming a known date.
ALTER TABLE pantry_items ADD COLUMN IF NOT EXISTS expires_at date;

-- Trigram similarity powers the fuzzy fallback in meal_images lookups below
-- (exact dish_key match first, then similarity() for near-duplicate names
-- that normalization alone doesn't collapse). Standard Postgres contrib
-- extension — available on Neon, Supabase, and RDS without special access.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- --------------------------------------------------------------- meal images
-- Dish-photo cache, keyed by a normalized dish name rather than by meal or
-- user: the whole point is that "grilled chicken and rice" only ever gets
-- photographed or generated once, no matter how many suggestions — for how
-- many different users — ask for it. See src/lib/dish-key.ts for the
-- normalizer and src/lib/ai/meal-images.ts for the lookup-then-source flow.
CREATE TABLE IF NOT EXISTS meal_images (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Normalized, order-independent match key (see dishKey()). Unique: one
  -- cached image per distinct dish, ON CONFLICT DO NOTHING resolves the race
  -- when two requests source the same brand-new dish concurrently.
  dish_key      text NOT NULL,
  -- Display name as first seen, for debugging/admin visibility only — never
  -- shown in the product UI, which always uses the suggestion's own title.
  dish_name     text NOT NULL,
  image_url     text NOT NULL,
  image_source  text NOT NULL CHECK (image_source IN ('ai_generated', 'stock')),
  -- Required by Unsplash's API terms whenever a hotlinked photo is displayed;
  -- null for ai_generated rows, where there is no photographer to credit.
  attribution   text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS meal_images_dish_key_idx ON meal_images (dish_key);
CREATE INDEX IF NOT EXISTS meal_images_trgm_idx ON meal_images USING gin (dish_key gin_trgm_ops);

-- The URL a suggestion's card should render, once resolved by the cache
-- lookup — set for cache hits (stock or a different user's prior AI render)
-- and for this request's own fresh generation alike, so the frontend never
-- needs to branch between "my photo_id" and "someone else's cached URL".
ALTER TABLE meal_suggestions ADD COLUMN IF NOT EXISTS image_url text;

-- Real store-aisle location, resolved against src/lib/aisle-map.ts by
-- src/lib/ai/aisle-classify.ts. aisle_number is null for perimeter
-- departments (Produce, Meat, ...); aisle_category is always set once
-- classified and holds either the specific numbered-aisle category ("Cereal")
-- or the perimeter section name itself ("Produce") — see resolveAisle().
-- Distinct from the pre-existing `category` column, which holds a coarser,
-- store-agnostic bucket (produce/meat/dairy/...) used before this system
-- existed; left alone rather than repurposed, since GroceryList.tsx's new
-- grouping reads aisle_number/aisle_category instead.
ALTER TABLE grocery_list_items ADD COLUMN IF NOT EXISTS aisle_number int;
ALTER TABLE grocery_list_items ADD COLUMN IF NOT EXISTS aisle_category text;

-- ----------------------------------------------------------- suggested_meals
-- Precomputed "Suggested for you" results — event-driven (see
-- regenerateSuggestedMeals in src/lib/suggestions.ts), regenerated only when
-- the pantry actually changes (receipt parsed, camera capture, manual edit),
-- never generated live when the Meals tab opens. Self-sufficient rows (not a
-- thin pointer into meal_suggestions) covering all four slots at once on
-- every run, so opening the tab at any time of day is always a plain read.
CREATE TABLE IF NOT EXISTS suggested_meals (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slot             meal_slot NOT NULL,
  title            text NOT NULL,
  description      text,
  cuisine          text,
  prep_minutes     int,
  servings         int NOT NULL DEFAULT 1,
  calories         numeric(10,2),
  protein_g        numeric(10,2),
  carbs_g          numeric(10,2),
  fat_g            numeric(10,2),
  fiber_g          numeric(10,2),
  sugar_added_g    numeric(10,2),
  sat_fat_g        numeric(10,2),
  sodium_mg        numeric(10,2),
  serving_grams    numeric(10,2),
  processing_level int CHECK (processing_level BETWEEN 1 AND 4),
  health_score     int CHECK (health_score BETWEEN 0 AND 100),
  health_grade     text,
  health_reasons   jsonb,
  instructions     text[] NOT NULL DEFAULT '{}',
  pantry_coverage  real,
  -- Model's own note on what's missing/assumed when the pantry can't fully
  -- cover the dish (e.g. "no seasoning logged — season to taste"), rather
  -- than silently assuming an ingredient is on hand. Null when nothing to note.
  missing_note     text,
  image_url        text,
  image_status     text NOT NULL DEFAULT 'pending',
  model            text,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS suggested_meals_user_slot_idx
  ON suggested_meals (user_id, slot, created_at DESC);

CREATE TABLE IF NOT EXISTS suggested_meal_ingredients (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  suggestion_id          uuid NOT NULL REFERENCES suggested_meals(id) ON DELETE CASCADE,
  name                   text NOT NULL,
  match_key              text NOT NULL,
  quantity               numeric(12,3),
  display_unit           text,
  canonical_amount       numeric(12,3),
  canonical_unit         canonical_unit,
  from_pantry            boolean NOT NULL DEFAULT false,
  matched_pantry_item_id uuid REFERENCES pantry_items(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS suggested_meal_ingredients_idx
  ON suggested_meal_ingredients (suggestion_id);

-- One row per user, claimed atomically so a burst of pantry-changing actions
-- (e.g. syncing several receipts back-to-back) triggers one regeneration
-- run rather than N concurrent ones — mirrors the image_status claim
-- pattern already used for meal_images generation.
CREATE TABLE IF NOT EXISTS suggested_meals_regen (
  user_id      uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  -- 'idle' | 'running'
  status       text NOT NULL DEFAULT 'idle',
  claimed_at   timestamptz,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- Input-keyed cache for "Build your own" — cache_key is a hash of the
-- normalized pantry snapshot plus constraints (see cacheKeyForCustomMeals in
-- src/lib/suggestions.ts), so asking for the same thing twice against an
-- unchanged pantry hits cache instead of paying for another model call.
-- Self-invalidating by construction: any pantry or constraint change
-- produces a different key, so stale entries simply become unreachable
-- rather than needing an explicit invalidation pass.
CREATE TABLE IF NOT EXISTS custom_meal_cache (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  cache_key      text NOT NULL,
  suggestion_ids uuid[] NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, cache_key)
);

-- -------------------------------------------------------------------- views
-- One row per active pantry item plus a freshness signal for the dashboard.
-- Dropped and recreated rather than CREATE OR REPLACE: the SELECT uses p.*, so
-- any new pantry_items column shifts the view's column list, which REPLACE
-- refuses ("cannot change name of view column").
DROP VIEW IF EXISTS pantry_overview;
CREATE VIEW pantry_overview AS
SELECT
  p.*,
  s.name AS store_name,
  (p.quantity <= 0) AS is_empty,
  EXTRACT(DAY FROM now() - p.last_seen_at)::int AS days_since_seen
FROM pantry_items p
LEFT JOIN stores s ON s.id = p.store_id
WHERE p.depleted_at IS NULL;
