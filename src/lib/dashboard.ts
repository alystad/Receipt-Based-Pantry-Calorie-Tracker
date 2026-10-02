import { query } from './db';

/**
 * Home-tab reads: day totals, week strip, streak, recent activity.
 *
 * Day bucketing happens in JS rather than SQL. `date_trunc('day', now())` runs
 * in the database's timezone (UTC on hosted Postgres), so a meal logged at 8pm
 * Eastern would land on tomorrow's total. These queries pull a timestamp range
 * and bucket by local calendar date instead.
 *
 * Caveat worth knowing: "local" here is the Node process's timezone, which is
 * the user's machine in dev but UTC on Vercel. Fully correct handling needs the
 * user's IANA zone stored on their profile; that is not built yet.
 */

const DAY_MS = 86_400_000;

/** Local-calendar YYYY-MM-DD for a timestamp. */
export function localDayKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/** Sunday-anchored week containing `date`, as seven local midnights. */
export function weekDays(date = new Date()): Date[] {
  const start = startOfLocalDay(date);
  start.setDate(start.getDate() - start.getDay()); // getDay(): 0 = Sunday
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    return d;
  });
}

export type DayTotals = {
  calories: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  meals: number;
};

const EMPTY_TOTALS: DayTotals = { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0, meals: 0 };

type MealRow = {
  eaten_at: Date;
  calories: string | null;
  protein_g: string | null;
  carbs_g: string | null;
  fat_g: string | null;
};

async function mealsBetween(userId: string, from: Date, to: Date): Promise<MealRow[]> {
  return query<MealRow>(
    `SELECT eaten_at, calories, protein_g, carbs_g, fat_g
       FROM meal_logs
      WHERE user_id = $1 AND eaten_at >= $2 AND eaten_at < $3
      ORDER BY eaten_at`,
    [userId, from, to]
  );
}

function accumulate(rows: MealRow[]): Map<string, DayTotals> {
  const byDay = new Map<string, DayTotals>();
  for (const row of rows) {
    const key = localDayKey(new Date(row.eaten_at));
    const acc = byDay.get(key) ?? { ...EMPTY_TOTALS };
    acc.calories += Number(row.calories ?? 0);
    acc.protein_g += Number(row.protein_g ?? 0);
    acc.carbs_g += Number(row.carbs_g ?? 0);
    acc.fat_g += Number(row.fat_g ?? 0);
    acc.meals += 1;
    byDay.set(key, acc);
  }
  return byDay;
}

/** Totals for every day of the week containing `focus`, plus the focused day. */
export async function weekTotals(userId: string, focus = new Date()) {
  const days = weekDays(focus);
  const from = days[0];
  const to = new Date(days[6].getTime() + DAY_MS);

  const byDay = accumulate(await mealsBetween(userId, from, to));
  const focusKey = localDayKey(focus);

  return {
    days: days.map((date) => ({
      date,
      key: localDayKey(date),
      totals: byDay.get(localDayKey(date)) ?? { ...EMPTY_TOTALS },
    })),
    focused: byDay.get(focusKey) ?? { ...EMPTY_TOTALS },
    focusKey,
  };
}

/**
 * Consecutive days ending today (or yesterday) with at least one logged meal.
 *
 * Today not yet being logged does not break the streak — it is still in
 * progress — so counting starts from yesterday when today is empty. That
 * matches how streaks behave in every app people have used before.
 */
export async function currentStreak(userId: string, now = new Date()): Promise<number> {
  const lookback = 400;
  const from = new Date(startOfLocalDay(now).getTime() - lookback * DAY_MS);
  const to = new Date(startOfLocalDay(now).getTime() + DAY_MS);

  const logged = new Set(
    (await mealsBetween(userId, from, to)).map((r) => localDayKey(new Date(r.eaten_at)))
  );
  if (!logged.size) return 0;

  const cursor = startOfLocalDay(now);
  if (!logged.has(localDayKey(cursor))) cursor.setDate(cursor.getDate() - 1);

  let streak = 0;
  while (logged.has(localDayKey(cursor)) && streak <= lookback) {
    streak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

export type ActivityEntry = {
  kind: 'meal' | 'receipt';
  id: string;
  title: string;
  at: Date;
  calories: number | null;
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
  photo_id: string | null;
  item_count: number | null;
};

/**
 * "Recently uploaded": the two things a user actually uploads — meal photos
 * and grocery receipts — in one reverse-chronological feed.
 */
export async function recentActivity(userId: string, limit = 8): Promise<ActivityEntry[]> {
  const rows = await query<{
    kind: 'meal' | 'receipt';
    id: string;
    title: string | null;
    at: Date | null;
    calories: string | null;
    protein_g: string | null;
    carbs_g: string | null;
    fat_g: string | null;
    photo_id: string | null;
    item_count: string | null;
  }>(
    `(
       SELECT 'meal'::text AS kind, m.id, m.title, m.eaten_at AS at,
              m.calories, m.protein_g, m.carbs_g, m.fat_g, m.photo_id,
              NULL::bigint AS item_count
         FROM meal_logs m
        WHERE m.user_id = $1
     )
     UNION ALL
     (
       SELECT 'receipt'::text AS kind, r.id,
              COALESCE(s.name, 'Grocery receipt') AS title,
              COALESCE(r.purchased_at, r.email_received_at) AS at,
              NULL, NULL, NULL, NULL, NULL::uuid,
              COUNT(ri.id) AS item_count
         FROM receipts r
         LEFT JOIN stores s ON s.id = r.store_id
         LEFT JOIN receipt_items ri ON ri.receipt_id = r.id
        WHERE r.user_id = $1 AND r.status = 'parsed'
        GROUP BY r.id, s.name
     )
     ORDER BY at DESC NULLS LAST
     LIMIT $2`,
    [userId, limit]
  );

  return rows
    .filter((r) => r.at != null)
    .map((r) => ({
      kind: r.kind,
      id: r.id,
      title: r.title ?? (r.kind === 'meal' ? 'Meal' : 'Grocery receipt'),
      at: new Date(r.at as unknown as string),
      calories: r.calories == null ? null : Number(r.calories),
      protein_g: r.protein_g == null ? null : Number(r.protein_g),
      carbs_g: r.carbs_g == null ? null : Number(r.carbs_g),
      fat_g: r.fat_g == null ? null : Number(r.fat_g),
      photo_id: r.photo_id,
      item_count: r.item_count == null ? null : Number(r.item_count),
    }));
}
