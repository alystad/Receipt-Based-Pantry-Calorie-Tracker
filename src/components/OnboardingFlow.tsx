'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import CameraCapture from './CameraCapture';

type ScannedItem = { name: string; brand: string | null; quantity: number; unit: string; confidence: number };
type ScanResponse = { itemsAdded: number; notes: string; items: ScannedItem[]; error?: string };

const CUISINES = ['italian', 'french', 'mexican', 'japanese', 'indian', 'thai', 'american', 'mediterranean'];
const EQUIPMENT = [
  { id: 'microwave', label: 'Microwave' },
  { id: 'air_fryer', label: 'Air fryer' },
  { id: 'stovetop', label: 'Stovetop' },
  { id: 'oven', label: 'Oven' },
  { id: 'instant_pot', label: 'Instant Pot' },
  { id: 'blender', label: 'Blender' },
  { id: 'no_cook', label: 'No cooking' },
];

export default function OnboardingFlow({ gmailConnected }: { gmailConnected: boolean }) {
  const router = useRouter();
  const [step, setStep] = useState<1 | 2>(1);
  const [photos, setPhotos] = useState<File[]>([]);
  const [previews, setPreviews] = useState<string[]>([]);
  const [scanning, setScanning] = useState(false);
  const [result, setResult] = useState<ScanResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [cuisines, setCuisines] = useState<string[]>([]);
  const [equipment, setEquipment] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  function addPhotos(files: File[]) {
    const next = [...photos, ...files].slice(0, 6);
    setPhotos(next);
    setPreviews(next.map((f) => URL.createObjectURL(f)));
    setResult(null);
  }

  async function runScan() {
    if (!photos.length) return;
    setScanning(true);
    setError(null);

    try {
      const form = new FormData();
      photos.forEach((photo) => form.append('photos', photo));

      const res = await fetch('/api/onboarding/scan', { method: 'POST', body: form });
      const data = (await res.json()) as ScanResponse;

      if (!res.ok) throw new Error(data.error ?? 'Scan failed');
      setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Scan failed');
    } finally {
      setScanning(false);
    }
  }

  async function savePreferences() {
    setSaving(true);
    try {
      await fetch('/api/preferences', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cuisines, equipment }),
      });
      router.push('/dashboard');
      router.refresh();
    } finally {
      setSaving(false);
    }
  }

  const toggle = (list: string[], set: (v: string[]) => void, value: string) =>
    set(list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);

  if (step === 2) {
    return (
      <>
        <h1>How do you cook?</h1>
        <p className="sub">
          Equipment is a hard constraint on your meal plan — if you pick microwave
          only, every recipe will work in a microwave.
        </p>

        <div className="card">
          <h3 style={{ marginBottom: 'var(--space-1)' }}>Equipment you can use</h3>
          <div className="chips">
            {EQUIPMENT.map((item) => (
              <button
                key={item.id}
                type="button"
                className="chip"
                aria-pressed={equipment.includes(item.id)}
                onClick={() => toggle(equipment, setEquipment, item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>

        <div className="card">
          <h3 style={{ marginBottom: 'var(--space-1)' }}>Cuisines you like</h3>
          <div className="chips">
            {CUISINES.map((cuisine) => (
              <button
                key={cuisine}
                type="button"
                className="chip"
                aria-pressed={cuisines.includes(cuisine)}
                onClick={() => toggle(cuisines, setCuisines, cuisine)}
                style={{ textTransform: 'capitalize' }}
              >
                {cuisine}
              </button>
            ))}
          </div>
        </div>

        <button
          className="btn btn-primary btn-block"
          onClick={savePreferences}
          disabled={saving}
        >
          {saving ? <span className="spinner" /> : null}
          {saving ? 'Saving…' : 'Finish setup'}
        </button>
      </>
    );
  }

  return (
    <>
      <h1>Let&rsquo;s fill your pantry</h1>
      <p className="sub">
        Take a few wide shots — pantry shelves, fridge, freezer, cabinets. Open
        the doors and step back. We will identify what we can see; receipts and
        meal photos correct the rest over time.
      </p>

      {!gmailConnected && (
        <div className="banner">
          Gmail is not connected, so receipts will not sync.{' '}
          <a href="/api/auth/google" style={{ textDecoration: 'underline' }}>
            Connect it
          </a>
          .
        </div>
      )}

      {previews.length > 0 && (
        <div className="card">
          <div className="thumb-grid">
            {previews.map((src, i) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img key={src} className="thumb" src={src} alt={`Shelf photo ${i + 1}`} />
            ))}
          </div>
          <p className="tiny muted" style={{ margin: 'var(--space-1) 0 0' }}>
            {photos.length} of 6 photos
          </p>
        </div>
      )}

      <div className="stack">
        <CameraCapture
          onCapture={addPhotos}
          label={photos.length ? 'Add another photo' : 'Take a photo'}
          multiple
          disabled={photos.length >= 6 || scanning}
          variant={photos.length ? 'secondary' : 'primary'}
        />

        {photos.length > 0 && !result && (
          <button className="btn btn-primary btn-block" onClick={runScan} disabled={scanning}>
            {scanning ? <span className="spinner" /> : null}
            {scanning ? 'Identifying items…' : `Scan ${photos.length} photo${photos.length > 1 ? 's' : ''}`}
          </button>
        )}
      </div>

      {error && <div className="banner" style={{ marginTop: 'var(--space-2)' }}>{error}</div>}

      {result && (
        <>
          <div className="banner banner-ok" style={{ marginTop: 'var(--space-2)' }}>
            Added {result.itemsAdded} items to your pantry.
          </div>

          {result.notes && <p className="small muted">{result.notes}</p>}

          <div className="card">
            {result.items.slice(0, 40).map((item, i) => (
              <div className="item" key={`${item.name}-${i}`}>
                <div>
                  <div style={{ textTransform: 'capitalize' }}>{item.name}</div>
                  {item.brand && <div className="tiny muted">{item.brand}</div>}
                </div>
                <div style={{ display: 'flex', gap: 'var(--space-1)', alignItems: 'center' }}>
                  {item.confidence < 0.5 && <span className="pill pill-warn">unsure</span>}
                  <span className="pill">
                    {item.quantity} {item.unit}
                  </span>
                </div>
              </div>
            ))}
          </div>

          <div className="stack">
            <CameraCapture
              onCapture={addPhotos}
              label="Scan more shelves"
              multiple
              variant="secondary"
              disabled={photos.length >= 6}
            />
            <button className="btn btn-primary btn-block" onClick={() => setStep(2)}>
              Next: cooking preferences
            </button>
          </div>
        </>
      )}

      {!result && (
        <button
          className="btn btn-block"
          style={{ marginTop: 'var(--space-1)', border: 'none', background: 'transparent' }}
          onClick={() => setStep(2)}
        >
          Skip for now
        </button>
      )}
    </>
  );
}

