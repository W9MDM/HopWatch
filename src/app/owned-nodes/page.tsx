import Link from "next/link";
import { pageAccess } from "../../auth/rbac.ts";
import { OwnedNodesManager } from "../../components/OwnedNodesManager.tsx";
import { effectiveConfig } from "../../db/appsettings.ts";
import { mapTiles } from "../../lib/maptiles.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function OwnedNodesPage() {
  const access = await pageAccess();
  if (!access.admin && !access.modules.has("owned")) {
    return (
      <div className="mx-auto max-w-sm py-16 text-center">
        <p className="text-[13px] text-ink-mute">Owned nodes are not available for your role.</p>
        <Link className="btn btn-primary mt-3 h-9 px-4 text-[13px]" href="/admin/login">Sign in</Link>
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="eyebrow"><span className="eyebrow-bar" />Owned nodes</h1>
      </div>
      <p className="text-[13px] text-ink-faint">
        Curated registry of managed nodes: ownership, sharing, maintenance visits, and issue tracking.
        Imported from meshadmin and tied to Discord accounts.
      </p>
      <OwnedNodesManager tile={await mapTiles()} />
    </div>
  );
}
