"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { cn } from "../lib/cn.ts";

// Auto-refresh toggle for server-rendered table views, with a visible pause state
// (spec: auto-refresh toggle on every table view). Uses router.refresh(), which
// re-runs the server component query; no client-side heavy query loop.
export function AutoRefresh({ intervalMs = 15000 }: { intervalMs?: number }) {
  const router = useRouter();
  const [on, setOn] = useState(true);
  const onRef = useRef(on);
  onRef.current = on;

  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => {
      if (onRef.current) router.refresh();
    }, intervalMs);
    return () => clearInterval(t);
  }, [on, intervalMs, router]);

  return (
    <button
      className={cn("btn h-8 px-3 text-[13px]", on ? "btn-primary" : "btn-outline")}
      onClick={() => setOn((v) => !v)}
      aria-pressed={on}
    >
      <span className={cn("mr-1 inline-block h-2 w-2 rounded-full", on ? "bg-white" : "bg-ink-faint")} />
      {on ? "Live" : "Paused"}
    </button>
  );
}
