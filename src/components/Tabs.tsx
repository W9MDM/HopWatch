"use client";

import { useState, type ReactNode } from "react";
import { cn } from "../lib/cn.ts";

export interface TabDef { id: string; label: string; panel: ReactNode }

// Generic tab strip for consolidated pages. Panels are server-rendered and passed in; the
// client only toggles which one is visible (all are in the payload, so switching is instant).
export function Tabs({ tabs, initial }: { tabs: TabDef[]; initial?: string }) {
  const [active, setActive] = useState(initial && tabs.some((t) => t.id === initial) ? initial : tabs[0]?.id);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-1 border-b border-line">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setActive(t.id)}
            className={cn(
              "-mb-px border-b-2 px-3 py-1.5 text-[13px] font-medium transition-colors outline-none",
              active === t.id ? "border-accent text-ink" : "border-transparent text-ink-mute hover:text-ink",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div>{tabs.find((t) => t.id === active)?.panel}</div>
    </div>
  );
}
