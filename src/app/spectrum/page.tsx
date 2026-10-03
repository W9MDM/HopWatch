import { moduleDenied } from "../../components/ModuleGate.tsx";
import { getTrafficSpectrum } from "../../db/queries.ts";
import { DbError } from "../../components/DbError.tsx";
import { SpectrumChart } from "../../components/SpectrumChart.tsx";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const metadata = { title: "Spectrum" };

type SP = Record<string, string | string[] | undefined>;

export default async function SpectrumPage({ searchParams }: { searchParams: Promise<SP> }) {
  const __denied = await moduleDenied("analytics"); if (__denied) return __denied;
  const sp = await searchParams;
  const one = (k: string) => (Array.isArray(sp[k]) ? sp[k]![0] : (sp[k] as string | undefined));
  const hours = Number(one("hours")) || 24;
  const bin = Number(one("bin")) || 15;

  let data;
  try {
    data = await getTrafficSpectrum(hours, bin);
  } catch (e) {
    return <DbError error={e} />;
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="eyebrow">
          <span className="eyebrow-bar" />
          Traffic spectrum
        </h1>
        <p className="mt-1 text-[13px] text-ink-faint">
          RF receptions over time by packet type, split by direction: direct (zero-hop, heard clean over
          the air) rises above the line, relayed (heard via the mesh) drops below. Receptions, not packets
          (Rule 4): a node's own MQTT copies never crossed the air, so they are excluded.
        </p>
      </div>
      <SpectrumChart rows={data.rows} stats={data.stats} hours={hours} bin={bin} />
    </div>
  );
}
