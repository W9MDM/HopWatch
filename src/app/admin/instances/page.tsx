import Link from "next/link";
import { cookies } from "next/headers";
import { verifySession, SESSION_COOKIE } from "../../../auth/session.ts";
import { sessionAccess } from "../../../auth/rbac.ts";
import { effectiveConfig } from "../../../db/appsettings.ts";
import { listInstances } from "../../../db/registry.ts";
import { InstanceDirectory } from "../../../components/InstanceDirectory.tsx";
import { DbError } from "../../../components/DbError.tsx";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function InstancesPage() {
  const jar = await cookies();
  const session = verifySession(jar.get(SESSION_COOKIE)?.value);
  if (!session || !(await sessionAccess(session)).admin) {
    return (
      <div className="mx-auto max-w-sm py-16 text-center">
        <p className="text-[13px] text-ink-mute">Admin access required.</p>
        <Link className="btn btn-primary mt-3 h-9 px-4 text-[13px]" href="/admin/login">Sign in</Link>
      </div>
    );
  }

  let hubEnabled = false;
  let staleDays = 30;
  let rows: Awaited<ReturnType<typeof listInstances>> = [];
  try {
    const cfg = await effectiveConfig();
    hubEnabled = cfg.registry.hub.enabled;
    staleDays = cfg.registry.hub.stale_days;
    rows = await listInstances();
  } catch (e) {
    return <DbError error={e} />;
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-lg font-semibold text-ink">HopWatch instances</h1>
        <p className="mt-1 text-[12px] text-ink-faint">
          Other HopWatch deployments that have opted in to announce themselves to this hub. Configure
          the registry in <Link className="text-accent hover:underline" href="/admin/settings">Settings &rarr; Registry</Link>.
        </p>
      </div>

      {!hubEnabled && (
        <div className="card text-[13px] text-ink-mute">
          This instance is not acting as a hub, so it is not collecting announcements. Turn on
          <span className="mono"> Act as a hub </span> in Settings &rarr; Registry to start. Any entries
          below were received while it was previously enabled.
        </div>
      )}

      <div className="card">
        <InstanceDirectory rows={rows} staleDays={staleDays} />
      </div>
    </div>
  );
}
