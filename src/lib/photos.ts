import { queryOne } from './db';

/**
 * Photo storage.
 *
 * Images arrive already downscaled by the browser (see components/CameraCapture
 * — it draws to a canvas at max 1280px and re-encodes as JPEG). Doing it client
 * side keeps upload bodies small and means no image library on the server.
 */

export const MAX_PHOTO_BYTES = 4 * 1024 * 1024;

export async function savePhoto(params: {
  userId: string;
  kind: 'meal' | 'pantry_scan' | 'receipt';
  bytes: Buffer;
  mimeType?: string;
}): Promise<string> {
  if (params.bytes.byteLength > MAX_PHOTO_BYTES) {
    throw new Error('Photo is too large after downscaling');
  }

  const row = await queryOne<{ id: string }>(
    `INSERT INTO photos (user_id, kind, mime_type, bytes, byte_size)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [
      params.userId,
      params.kind,
      params.mimeType ?? 'image/jpeg',
      params.bytes,
      params.bytes.byteLength,
    ]
  );

  if (!row) throw new Error('Failed to store photo');
  return row.id;
}

export function toDataUrl(bytes: Buffer, mimeType = 'image/jpeg'): string {
  return `data:${mimeType};base64,${bytes.toString('base64')}`;
}

export async function loadPhoto(
  userId: string,
  photoId: string
): Promise<{ bytes: Buffer; mime_type: string } | null> {
  return queryOne<{ bytes: Buffer; mime_type: string }>(
    `SELECT bytes, mime_type FROM photos WHERE id = $1 AND user_id = $2`,
    [photoId, userId]
  );
}

/** Reads uploaded files out of a multipart form, enforcing type and count. */
export async function filesFromForm(
  form: FormData,
  field: string,
  maxFiles: number
): Promise<Buffer[]> {
  const entries = form.getAll(field).filter((v): v is File => v instanceof File);
  if (!entries.length) throw new Error(`No files uploaded under "${field}"`);
  if (entries.length > maxFiles) {
    throw new Error(`Too many files: ${entries.length} (max ${maxFiles})`);
  }

  const buffers: Buffer[] = [];
  for (const file of entries) {
    if (!file.type.startsWith('image/')) {
      throw new Error(`Unsupported file type: ${file.type || 'unknown'}`);
    }
    const bytes = Buffer.from(await file.arrayBuffer());
    if (bytes.byteLength > MAX_PHOTO_BYTES) {
      throw new Error('Photo is too large; retake it at a lower resolution');
    }
    buffers.push(bytes);
  }
  return buffers;
}
