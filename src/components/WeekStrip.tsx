'use client';

import { useRouter } from 'next/navigation';

const DAY_NAMES = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

type Day = {
  date: Date | string;
  key: string;
  totals: { calories: number; meals: number };
};

/**
 * Sun–Sat day selector.
 *
 * Today is outlined, the day you are viewing is filled, days with a logged
 * meal get a solid edge, and empty/future days stay dotted and dimmed — so the
 * strip doubles as an at-a-glance record of which days you actually logged.
 */
export default function WeekStrip({
  days,
  selectedKey,
}: {
  days: Day[];
  selectedKey: string;
}) {
  const router = useRouter();
  const todayKey = localKey(new Date());

  return (
    <div className="week-strip" role="group" aria-label="Week">
      {days.map((day, index) => {
        const date = day.date instanceof Date ? day.date : new Date(day.date);
        const isToday = day.key === todayKey;
        const isSelected = day.key === selectedKey;
        const isFuture = day.key > todayKey;
        const logged = day.totals.meals > 0;

        return (
          <button
            key={day.key}
            className="week-day"
            onClick={() => router.push(`/dashboard?day=${day.key}`)}
            aria-current={isSelected ? 'date' : undefined}
            aria-label={`${date.toDateString()}${
              logged ? `, ${day.totals.meals} meals logged` : ', nothing logged'
            }`}
          >
            <span className="week-day-name">{DAY_NAMES[index]}</span>
            <span
              className="week-day-dot"
              data-today={isToday}
              data-selected={isSelected}
              data-logged={logged}
              data-future={isFuture}
            >
              {date.getDate()}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function localKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

