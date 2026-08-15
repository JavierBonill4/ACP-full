"use client";

import { useState } from "react";

import { Button, Window } from "@/components/ui";
import { ApiError, api } from "@/lib/api";

/**
 * The deliverable is a real file now (pptx, pdf, whatever the agent
 * produced) — not markdown rendered in-page like the old SlideDeck. This is
 * a download card: fetch the bytes as a Blob through the authenticated API
 * (see api.downloadDeliverable's doc comment for why a bare `<a href>`
 * can't do this) and hand the browser a real download.
 */
export default function DeliverableFile({
  jobId,
  filename,
  mimeType,
}: {
  jobId: string;
  filename: string;
  mimeType: string | null;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const download = async () => {
    setBusy(true);
    setError(null);
    try {
      const { blob, filename: served } = await api.downloadDeliverable(jobId);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = served || filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : "Download failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Window title="Deliverable">
      <div className="flex items-center justify-between gap-4 p-5">
        <div>
          <p className="font-mono text-xs text-white/80">{filename}</p>
          {mimeType && <p className="mt-0.5 text-[11px] text-white/35">{mimeType}</p>}
          {error && <p className="mt-1 text-[11px] text-bad">{error}</p>}
        </div>
        <Button disabled={busy} onClick={download}>
          {busy ? "Downloading…" : "Download"}
        </Button>
      </div>
    </Window>
  );
}
