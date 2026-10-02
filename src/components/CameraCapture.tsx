'use client';

import { useRef, useState, type ChangeEvent } from 'react';

/**
 * Camera input for mobile browsers.
 *
 * `capture="environment"` opens the rear camera directly on iOS and Android
 * without any native app. Images are downscaled and re-encoded to JPEG on a
 * canvas before upload: a modern phone photo is 3-6MB, which is slow to upload
 * on cellular and buys nothing — the vision model sees a resized image anyway.
 */

const MAX_EDGE = 1280;
const QUALITY = 0.82;

export async function downscaleImage(file: File): Promise<File> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));

  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext('2d');
  if (!ctx) return file;
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/jpeg', QUALITY)
  );
  if (!blob) return file;

  return new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' });
}

type Props = {
  onCapture: (files: File[]) => void;
  label: string;
  multiple?: boolean;
  disabled?: boolean;
  variant?: 'primary' | 'secondary';
};

export default function CameraCapture({
  onCapture,
  label,
  multiple = false,
  disabled = false,
  variant = 'primary',
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [processing, setProcessing] = useState(false);

  async function handleChange(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    if (!files.length) return;

    setProcessing(true);
    try {
      onCapture(await Promise.all(files.map(downscaleImage)));
    } finally {
      setProcessing(false);
      // Reset so picking the same file twice still fires a change event.
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        capture="environment"
        multiple={multiple}
        onChange={handleChange}
        style={{ display: 'none' }}
      />
      <button
        type="button"
        className={`btn btn-block ${variant === 'primary' ? 'btn-primary' : ''}`}
        onClick={() => inputRef.current?.click()}
        disabled={disabled || processing}
      >
        {processing ? <span className="spinner" /> : '📷'}
        {processing ? 'Preparing…' : label}
      </button>
    </>
  );
}

