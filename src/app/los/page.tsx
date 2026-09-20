import { moduleDenied } from "../../components/ModuleGate.tsx";
import { listPositionedNodes } from "../../db/queries.ts";
import { DbError } from "../../components/DbError.tsx";
import { LosTool } from "../../components/LosTool.tsx";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type SP = Record<string, string | string[] | undefined>;

export default async function LosPage({ searchParams }: { searchParams: Promise<SP> }) {
  const __denied = await moduleDenied("link-budget"); if (__denied) return __denied;
  const sp = await searchParams;
  const one = (k: string) => (Array.isArray(sp[k]) ? sp[k]![0] : (sp[k] as string | undefined));
  const a = Number(one("a")) || undefined;
  const b = Number(one("b")) || undefined;

  let nodes;
  try {
    nodes = await listPositionedNodes();
  } catch (e) {
    return <DbError error={e} />;
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="eyebrow"><span className="eyebrow-bar" />Line of sight</h1>
        <p className="mt-1 text-[13px] text-ink-faint">Terrain profile, line of sight, and first Fresnel zone between any two positioned nodes.</p>
      </div>
      <LosTool nodes={nodes} initialA={a} initialB={b} />
    </div>
  );
}
