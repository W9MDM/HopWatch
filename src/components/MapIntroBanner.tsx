"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

// One-line plain-language orientation for first-time map visitors (audit: fails the 5-second
// "what am I looking at" test). Dismissible and remembered per-browser, so regulars never see it.
export function MapIntroBanner() {
  const [show, setShow] = useState(false);
  useEffect(() => {
    try {
      setShow(localStorage.getItem("hopwatch_map_intro_dismissed") !== "1");
    } catch { setShow(true); }
  }, []);
  if (!show) return null;
  return (
    <div className="flex items-start justify-between gap-3 rounded-lg border border-accent/40 bg-accent/10 px-4 py-2.5 text-[13px] text-ink">
      <p className="leading-relaxed">
        Live map of a volunteer <strong>Meshtastic mesh radio network</strong>. Each dot is a device relaying
        messages off-grid; rings show how many hops away it was heard.{" "}
        <Link href="/about" className="text-accent hover:underline">What is this?</Link>
      </p>
      <button
        type="button"
        aria-label="Dismiss introduction"
        onClick={() => { try { localStorage.setItem("hopwatch_map_intro_dismissed", "1"); } catch { /* ignore */ } setShow(false); }}
        className="flex-none rounded-md px-2 py-0.5 text-ink-faint hover:bg-raised hover:text-ink"
      >
        Got it
      </button>
    </div>
  );
}
