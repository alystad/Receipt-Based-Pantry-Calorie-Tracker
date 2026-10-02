'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

type SyncResult = {
  scanned: number;
  parsed: number;
  skipped: number;
  itemsAdded: number;
  error?: string;
  reconnect?: boolean;
};

/** Manual trigger for the receipt sync that otherwise runs on a daily cron. */
export default function SyncButton({ connected }: { connected: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [needsReconnect, setNeedsReconnect] = useState(false);

  if (!connected || needsReconnect) {
    return (
      <div className="banner">
        {needsReconnect
          ? 'Gmail access expired. Reconnect to keep receipts syncing.'
          : 'Connect Gmail to import grocery receipts automatically.'}{' '}
        <a href="/api/auth/google" style={{ textDecoration: 'underline' }}>
          {needsReconnect ? 'Reconnect' : 'Connect Gmail'}
        </a>
      </div>
    );
  }

  async function sync() {
    setBusy(true);
    setStatus(null);
    try {
      const res = await fetch('/api/receipts/sync', { method: 'POST' });
      const data = (await res.json()) as SyncResult;

      if (!res.ok) {
        if (data.reconnect) setNeedsReconnect(true);
        setStatus(data.error ?? 'Sync failed');
        return;
      }

      setStatus(
        data.parsed > 0
          ? `Imported ${data.itemsAdded} items from ${data.parsed} receipt${data.parsed > 1 ? 's' : ''}.`
          : `No new receipts found (checked ${data.scanned}).`
      );
      router.refresh();
    } catch {
      setStatus('Sync failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button className="btn btn-block" onClick={sync} disabled={busy}>
        {busy ? <span className="spinner" /> : '✉️'}
        {busy ? 'Checking Gmail…' : 'Check for new receipts'}
      </button>
      {status && (
        <p className="tiny muted" style={{ marginTop: 'var(--space-1)', textAlign: 'center' }}>
          {status}
        </p>
      )}
    </>
  );
}

