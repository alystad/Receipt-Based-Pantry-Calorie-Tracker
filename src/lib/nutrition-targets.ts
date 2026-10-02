import type { Preferences } from './plans';

/**
 * Daily macro denominators for the dashboard rings.
 *
 * Only calories and protein have explicit preference columns filled in by most
 * users, so carbs and fat fall back to a standard 30/40/30 calorie split
 * (protein/carbs/fat). Each target reports whether it was set by the user or
 * derived, so the UI never presents a guess as a personal goal.
 */

export type MacroTarget = { grams: number; explicit: boolean };

export type DailyTargets = {
  calories: number;
  caloriesExplicit: boolean;
  protein: MacroTarget;
  carbs: MacroTarget;
  fat: MacroTarget;
};

const DEFAULT_CALORIES = 2000;
const PROTEIN_SHARE = 0.3;
const CARB_SHARE = 0.4;
const FAT_SHARE = 0.3;

const KCAL_PER_G = { protein: 4, carbs: 4, fat: 9 } as const;

export function dailyTargets(
  prefs: Pick<
    Preferences,
    'daily_calorie_target' | 'daily_protein_target_g'
  > & {
    daily_carbs_target_g?: number | null;
    daily_fat_target_g?: number | null;
  }
): DailyTargets {
  const calories = prefs.daily_calorie_target ?? DEFAULT_CALORIES;

  const derive = (share: number, kcalPerGram: number) =>
    Math.round((calories * share) / kcalPerGram);

  return {
    calories,
    caloriesExplicit: prefs.daily_calorie_target != null,
    protein: {
      grams: prefs.daily_protein_target_g ?? derive(PROTEIN_SHARE, KCAL_PER_G.protein),
      explicit: prefs.daily_protein_target_g != null,
    },
    carbs: {
      grams: prefs.daily_carbs_target_g ?? derive(CARB_SHARE, KCAL_PER_G.carbs),
      explicit: prefs.daily_carbs_target_g != null,
    },
    fat: {
      grams: prefs.daily_fat_target_g ?? derive(FAT_SHARE, KCAL_PER_G.fat),
      explicit: prefs.daily_fat_target_g != null,
    },
  };
}
