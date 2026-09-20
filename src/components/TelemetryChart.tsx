"use client";

import { useEffect, useRef } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { utcToDate } from "../lib/format.ts";

export interface Series {
  label: string;
  color?: string;
  points: { t: string; v: number }[];
}

// Dense time-series chart (uPlot). Used for telemetry and per-pair RSSI/SNR.
// Warm-charcoal theme to match the design system.
export function TelemetryChart({ series, height = 160 }: { series: Series; height?: number }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const xs = series.points.map((p) => (utcToDate(p.t)?.getTime() ?? 0) / 1000);
    const ys = series.points.map((p) => p.v);
    const data: uPlot.AlignedData = [xs, ys];

    const opts: uPlot.Options = {
      width: el.clientWidth || 600,
      height,
      padding: [8, 8, 0, 0],
      cursor: { points: { size: 5 } },
      scales: { x: { time: true } },
      axes: [
        {
          stroke: "#a4a39c",
          grid: { stroke: "#272725", width: 1 },
          ticks: { stroke: "#272725" },
          font: "11px ui-sans-serif, system-ui",
        },
        {
          stroke: "#a4a39c",
          grid: { stroke: "#272725", width: 1 },
          ticks: { stroke: "#272725" },
          font: "11px ui-sans-serif, system-ui",
        },
      ],
      series: [
        {},
        {
          label: series.label,
          stroke: series.color ?? "#3f9e63",
          width: 1.5,
          points: { show: series.points.length < 80 },
        },
      ],
    };

    const plot = new uPlot(opts, data, el);
    const onResize = () => plot.setSize({ width: el.clientWidth || 600, height });
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      plot.destroy();
    };
  }, [series, height]);

  if (series.points.length === 0) {
    return <div className="text-[13px] text-ink-faint">No {series.label} data.</div>;
  }
  return <div ref={ref} className="w-full" />;
}
