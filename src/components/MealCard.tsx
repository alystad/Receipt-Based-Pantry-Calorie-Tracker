'use client';

import { useEffect, useRef, useState } from 'react';
import { foodIcon } from '@/lib/food-icons';
import { scoreColor, bandFor, labelFor } from '@/lib/health-rating';

export type SuggestionView = {
  id: string;
  title: string;
  cuisine: string | null;
  prep_minutes: number | null;
  calories: string | null;
  protein_g: string | null;
  carbs_g: string | null;
  fat_g: string | null;
  health_score: number | null;
  health_grade: string | null;
  pantry_coverage: number | null;
  image_url: string | null;
  image_status: string;
};

/**
 * One meal option.
 *
 * Dish photos are generated lazily: the card asks for one only when it
 * scrolls into view and only if it does not already have one, so meals the
 * user never looks at never cost an image call. Until a photo exists the card
 * shows a food-matched glyph rather than an empty grey box.
 *
 * The health score chip carries its meaning through the number plus the
 * Yuka-style colour band alone — no "Excellent"/"Good" word repeated on every
 * card. That word lives once, in the rubric explanation on the detail page,
 * which keeps the card's on-screen text to what actually varies per meal.
 */
export default function MealCard({
  suggestion,
  onOpen,
  imageEndpoint = '/api/suggestions',
}: {
  suggestion: SuggestionView;
  onOpen: (id: string) => void;
  /** Base path for the lazy image-resolve POST — suggested_meals rows use a different table/route. */
  imageEndpoint?: string;
}) {
  const [imageUrl, setImageUrl] = useState(suggestion.image_url);
  const ref = useRef<HTMLButtonElement>(null);
  const requested = useRef(false);

  useEffect(() => {
    if (imageUrl || requested.current) return;
    // 'failed' and 'generating' are both terminal for this render; only a
    // 'pending' card should trigger work.
    if (suggestion.image_status !== 'pending') return;

    const node = ref.current;
    if (!node) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting) || requested.current) return;
        requested.current = true;
        observer.disconnect();

        fetch(`${imageEndpoint}/${suggestion.id}/image`, { method: 'POST' })
          .then((r) => r.json())
          .then((data: { image_url?: string | null }) => {
            if (data.image_url) setImageUrl(data.image_url);
          })
          .catch(() => undefined);
      },
      { rootMargin: '200px' }
    );

    observer.observe(node);
    return () => observer.disconnect();
  }, [imageUrl, suggestion.id, suggestion.image_status, imageEndpoint]);

  const icon = foodIcon(suggestion.title, null);
  const score = suggestion.health_score ?? 50;
  const band = bandFor(score);
  const colors = scoreColor(band);
  const coverage = suggestion.pantry_coverage ?? 0;

  return (
    <button ref={ref} className="meal-card" onClick={() => onOpen(suggestion.id)}>
      <div className="meal-card-media food-tile" data-tone={icon.tone} style={{ borderRadius: 0 }}>
        {imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={imageUrl} alt="" loading="lazy" />
        ) : (
          <span aria-hidden>{icon.glyph}</span>
        )}

        <span
          className="score-chip"
          style={{ background: colors.bg, color: colors.fg }}
          title={`Health score: ${score}/100 — ${labelFor(score)}`}
        >
          {score}%
        </span>
      </div>

      <div className="meal-card-body">
        <span className="meal-card-title">{suggestion.title}</span>

        <span className="tiny muted">{Math.round(Number(suggestion.calories ?? 0))} kcal</span>

        <div className="meal-card-macros">
          <span>Protein {Math.round(Number(suggestion.protein_g ?? 0))}g</span>
          <span>Carbs {Math.round(Number(suggestion.carbs_g ?? 0))}g</span>
          <span>Fat {Math.round(Number(suggestion.fat_g ?? 0))}g</span>
        </div>

        <div style={{ display: 'flex', gap: 'var(--space-1)', flexWrap: 'wrap', marginTop: 4 }}>
          {suggestion.prep_minutes ? (
            <span className="pill">{suggestion.prep_minutes} min</span>
          ) : null}
          {coverage > 0 && (
            <span className="pill pill-accent">{Math.round(coverage * 100)}% in pantry</span>
          )}
        </div>
      </div>
    </button>
  );
}

