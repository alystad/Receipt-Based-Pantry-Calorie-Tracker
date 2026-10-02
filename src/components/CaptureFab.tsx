'use client';

import { useRef, useState, type ChangeEvent } from 'react';
import { useRouter } from 'next/navigation';
import { downscaleImage } from './CameraCapture';
import type { CaptureResult } from '@/lib/capture';
import type { PhotoKind } from '@/lib/ai/classify';

/**
 * Floating "+" that opens the camera capture flow from any tab.
 *
 * One photo, two possible pipelines: the server classifies it as a receipt
 * or a meal and routes accordingly (see src/lib/capture.ts) — this component
 * doesn't decide which, it just shows what was decided and offers a manual
 * override when the classification looks wrong.
 *
 * The hidden file input is clicked directly from the button's own tap
 * handler, which is what lets iOS open the camera in one tap — routing to a
 * page first would cost a second tap, because mobile browsers only open the
 * camera from a direct user gesture.
 */
export default function CaptureFab() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  // Kept alongside the preview URL, not just the URL itself, so "log as meal
  // instead" can resubmit the exact same photo without asking for a retake.
  const photoRef = useRef<File | null>(null);

  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [result, setResult] = useState<CaptureResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastAttempted, setLastAttempted] = useState<PhotoKind | null>(null);

  async function submit(file: File, forceKind?: PhotoKind) {
    setBusy(true);
    setError(null);
    setResult(null);
    setLastAttempted(forceKind ?? null);

    try {
      const form = new FormData();
      form.append('photo', file);
      if (forceKind) form.append('forceKind', forceKind);

      const res = await fetch('/api/capture', { method: 'POST', body: form });
      const data = (await res.json()) as CaptureResult & { error?: string };

      if (!res.ok) throw new Error(data.error ?? 'Could not read that photo');

      setResult(data);
      setLastAttempted(data.classification.autoDetected);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read that photo');
    } finally {
      setBusy(false);
    }
  }

  async function handleChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (inputRef.current) inputRef.current.value = '';
    if (!file) return;

    const downscaled = await downscaleImage(file);
    photoRef.current = downscaled;
    setPreview(URL.createObjectURL(downscaled));
    await submit(downscaled);
  }

  /** "Not a receipt? Log as meal instead" and its mirror — reuses the same photo. */
  function retryAs(kind: PhotoKind) {
    if (!photoRef.current) return;
    void submit(photoRef.current, kind);
  }

  function dismiss() {
    setResult(null);
    setError(null);
    setPreview(null);
    setLastAttempted(null);
    photoRef.current = null;
  }

  const sheetOpen = busy || result != null || error != null;

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        capture="environment"
        onChange={handleChange}
        style={{ display: 'none' }}
      />

      <button
        type="button"
        className="fab-plus"
        onClick={() => inputRef.current?.click()}
        disabled={busy}
        aria-label="Capture a receipt or a meal photo"
      >
        {busy ? (
          <span className="spinner" />
        ) : (
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden>
            <path d="M12 5v14M5 12h14" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" />
          </svg>
        )}
      </button>

      {sheetOpen && (
        <div className="sheet-backdrop" onClick={() => !busy && dismiss()} role="presentation">
          <div
            className="sheet"
            role="dialog"
            aria-modal="true"
            aria-label="Capture result"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="sheet-grabber" />

            {preview && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                className="photo-preview"
                src={preview}
                alt="What you just photographed"
                style={{ marginBottom: 'var(--space-2)' }}
              />
            )}

            {busy && (
              <p className="row" style={{ justifyContent: 'center' }}>
                <span className="spinner" />
                {lastAttempted ? `Reading it as a ${lastAttempted}…` : 'Figuring out what this is…'}
              </p>
            )}

            {error && (
              <>
                <div className="banner">{error}</div>
                <p className="small muted" style={{ margin: '0 0 var(--space-2)' }}>
                  Wrong guess? Try the other pipeline instead of retaking the photo.
                </p>
                <div className="stack">
                  {lastAttempted !== 'meal' && (
                    <button className="btn btn-block" onClick={() => retryAs('meal')}>
                      Log as meal instead
                    </button>
                  )}
                  {lastAttempted !== 'receipt' && (
                    <button className="btn btn-block" onClick={() => retryAs('receipt')}>
                      Log as receipt instead
                    </button>
                  )}
                  <button className="btn btn-block" onClick={dismiss}>
                    Close
                  </button>
                </div>
              </>
            )}

            {result?.kind === 'meal' && (
              <MealResult
                result={result}
                onCorrect={() => retryAs('receipt')}
                onDone={dismiss}
              />
            )}

            {result?.kind === 'receipt' && (
              <ReceiptResult
                result={result}
                onCorrect={() => retryAs('meal')}
                onDone={dismiss}
              />
            )}
          </div>
        </div>
      )}
    </>
  );
}

function ClassificationBanner({
  label,
  kind,
  corrected,
  onCorrect,
  correctLabel,
}: {
  label: string;
  kind: PhotoKind;
  corrected: boolean;
  onCorrect: () => void;
  correctLabel: string;
}) {
  return (
    <>
      <div className="banner banner-ok" style={{ marginBottom: 'var(--space-2)' }}>
        {kind === 'receipt' ? 'Receipt detected' : 'Meal detected'} — {label}
      </div>
      {!corrected && (
        <button
          className="btn btn-sm"
          style={{ marginBottom: 'var(--space-2)' }}
          onClick={onCorrect}
        >
          {correctLabel}
        </button>
      )}
    </>
  );
}

function MealResult({
  result,
  onCorrect,
  onDone,
}: {
  result: Extract<CaptureResult, { kind: 'meal' }>;
  onCorrect: () => void;
  onDone: () => void;
}) {
  const { meal } = result;

  return (
    <>
      <ClassificationBanner
        label={`logged ~${Math.round(meal.calories)} kcal`}
        kind="meal"
        corrected={result.classification.corrected}
        onCorrect={onCorrect}
        correctLabel="Not a meal? Log as receipt instead"
      />

      <h2 style={{ margin: '0 0 var(--space-1)' }}>{meal.title}</h2>
      <p className="tiny muted" style={{ textTransform: 'capitalize' }}>
        {meal.slot}
        {meal.confidence < 0.6 ? ' · low confidence' : ''}
      </p>

      <div className="card">
        <div className="macros">
          <Macro value={Math.round(meal.calories)} label="kcal" />
          <Macro value={`${Math.round(meal.protein_g)}g`} label="protein" />
          <Macro value={`${Math.round(meal.carbs_g)}g`} label="carbs" />
          <Macro value={`${Math.round(meal.fat_g)}g`} label="fat" />
        </div>
      </div>

      {meal.deductions.length > 0 && (
        <div className="card">
          <h3 style={{ marginBottom: 'var(--space-1)' }}>Removed from your pantry</h3>
          {meal.deductions.map((d, i) => (
            <div className="item" key={`${d.item}-${i}`}>
              <span style={{ textTransform: 'capitalize' }}>{d.item}</span>
              <span className="small muted">
                −{d.amount} {d.unit}
                {d.approximate ? ' (approx)' : ''}
              </span>
            </div>
          ))}
        </div>
      )}

      <button className="btn btn-primary btn-block" onClick={onDone}>
        Done
      </button>
    </>
  );
}

function ReceiptResult({
  result,
  onCorrect,
  onDone,
}: {
  result: Extract<CaptureResult, { kind: 'receipt' }>;
  onCorrect: () => void;
  onDone: () => void;
}) {
  const { receipt } = result;

  return (
    <>
      <ClassificationBanner
        label={`added ${receipt.itemsAdded} item${receipt.itemsAdded === 1 ? '' : 's'} to pantry`}
        kind="receipt"
        corrected={result.classification.corrected}
        onCorrect={onCorrect}
        correctLabel="Not a receipt? Log as meal instead"
      />

      <div className="card">
        <div className="row">
          <div>
            <h3 style={{ marginBottom: 0 }}>{receipt.storeName ?? 'Receipt'}</h3>
            <span className="tiny muted">
              {receipt.itemsAdded} item{receipt.itemsAdded === 1 ? '' : 's'} added to your pantry
            </span>
          </div>
          {receipt.totalCents != null && (
            <span className="small muted" style={{ whiteSpace: 'nowrap' }}>
              ${(receipt.totalCents / 100).toFixed(2)}
            </span>
          )}
        </div>
      </div>

      <button className="btn btn-primary btn-block" onClick={onDone}>
        Done
      </button>
    </>
  );
}

function Macro({ value, label }: { value: string | number; label: string }) {
  return (
    <div>
      <div className="macro-value">{value}</div>
      <div className="macro-label">{label}</div>
    </div>
  );
}

