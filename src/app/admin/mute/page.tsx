import Link from "next/link";
import { cookies } from "next/headers";
import { verifySession, SESSION_COOKIE } from "../../../auth/session.ts";
import { sessionAccess } from "../../../auth/rbac.ts";
import { listMuted } from "../../../db/queries.ts";
import { DbError } from "../../../components/DbError.tsx";
import { MuteManager } from "../../../components/MuteManager.tsx";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function AdminMutePage() {
  const jar = await cookies();
  const session = verifySession(jar.get(SESSION_COOKIE)?.value);

  if (!session || !(await sessionAccess(session)).admin) {
    return (
      <div className="mx-auto max-w-sm py-16 text-center">
        <p className="text-[13px] text-ink-mute">Admin access required.</p>
        <Link className="btn btn-primary mt-3 h-9 px-4 text-[13px]" href="/admin/login">
          Sign in
        </Link>
      </div>
    );
  }

  let muted;
  try {
    muted = await listMuted();
  } catch (e) {
    return <DbError error={e} />;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="eyebrow">
          <span className="eyebrow-bar" />
          Mute list
        </h1>
        <span className="text-[11px] text-ink-faint">signed in as {session.sub}</span>
      </div>
      <p className="text-[13px] text-ink-faint">
        Muting hides a node from default views only. It never sends anything to the mesh.
      </p>
      <MuteManager initial={muted} />
    </div>
  );
}
