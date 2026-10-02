/**
 * Circular progress ring (server-safe — no client hooks).
 *
 * Drawn with stroke-dasharray on an SVG circle and rotated so progress starts
 * at 12 o'clock. Overshooting the goal keeps the ring visually full rather
 * than wrapping, and the caller decides how to signal the overage in text.
 */

type Props = {
  /** 0..1; values above 1 render as a full ring. */
  value: number;
  size?: number;
  strokeWidth?: number;
  color?: string;
  trackColor?: string;
  children?: React.ReactNode;
  label?: string;
};

export default function ProgressRing({
  value,
  size = 72,
  strokeWidth = 8,
  color = 'var(--accent)',
  trackColor = 'rgba(0,0,0,0.08)',
  children,
  label,
}: Props) {
  const clamped = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const dash = circumference * clamped;

  return (
    <div
      style={{ position: 'relative', width: size, height: size, flexShrink: 0 }}
      role={label ? 'img' : undefined}
      aria-label={label}
    >
      <svg width={size} height={size} aria-hidden>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={trackColor}
          strokeWidth={strokeWidth}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={`${dash} ${circumference - dash}`}
          // Start the sweep at the top instead of 3 o'clock.
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
          style={{
            transition: 'stroke-dasharray var(--duration-standard) var(--ease-standard)',
          }}
        />
      </svg>
      {children != null && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            lineHeight: 1.1,
          }}
        >
          {children}
        </div>
      )}
    </div>
  );
}

