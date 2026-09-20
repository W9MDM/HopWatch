import { moduleDenied } from "../../components/ModuleGate.tsx";
import Link from "next/link";
import { Tabs } from "../../components/Tabs.tsx";
import { StatsPanel } from "../../components/analytics/StatsPanel.tsx";
import { AnalyticsPanel } from "../../components/analytics/AnalyticsPanel.tsx";
import { DistributionsPanel } from "../../components/analytics/DistributionsPanel.tsx";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type SP = Record<string, string | string[] | undefined>;

// Consolidated analytics view (formerly /stats, /analytics, /distributions). One route, one
// module (`analytics`); the former paths redirect here to the matching tab.
export default async function AnalyticsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const __denied = await moduleDenied("analytics"); if (__denied) return __denied;
  const sp = await searchParams;
  const tab = Array.isArray(sp.tab) ? sp.tab[0] : sp.tab;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="eyebrow"><span className="eyebrow-bar" />Analytics</h1>
          <p className="mt-1 text-[13px] text-ink-faint">Network traffic and totals, RF signal quality, and how activity/signal/protocols are distributed across the mesh.</p>
        </div>
        <Link className="btn btn-outline h-8 px-3 text-[13px]" href="/traceroutes">Traceroutes</Link>
      </div>
      <Tabs
        initial={tab}
        tabs={[
          { id: "traffic", label: "Traffic", panel: <StatsPanel /> },
          { id: "signal", label: "Signal & RF", panel: <AnalyticsPanel /> },
          { id: "distributions", label: "Distributions", panel: <DistributionsPanel /> },
        ]}
      />
    </div>
  );
}
