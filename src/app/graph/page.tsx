import { moduleDenied } from "../../components/ModuleGate.tsx";
import { MeshGraph } from "../../components/MeshGraph.tsx";

export const dynamic = "force-dynamic";

export const metadata = { title: "Graph" };

export default async function GraphPage() {
  const __denied = await moduleDenied("graph"); if (__denied) return __denied;
  return (
    <div className="space-y-4">
      <div>
        <h1 className="eyebrow">
          <span className="eyebrow-bar" />
          Mesh graph
        </h1>
        <p className="mt-1 text-[13px] text-ink-faint">
          Force-directed view of the mesh: RF direct-heard links, relayed links, and traceroute hops.
          Nodes are colored by role; gateways are ringed. Use Focus to center on a node, or pick a
          second node to highlight the path spidering between them.
        </p>
      </div>
      <MeshGraph />
    </div>
  );
}
