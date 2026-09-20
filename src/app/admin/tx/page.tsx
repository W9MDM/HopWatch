import Link from "next/link";
import { cookies } from "next/headers";
import { verifySession, SESSION_COOKIE } from "../../../auth/session.ts";
import { sessionAccess } from "../../../auth/rbac.ts";
import { effectiveConfig } from "../../../db/appsettings.ts";
import { listOutbox } from "../../../db/tx.ts";
import { DbError } from "../../../components/DbError.tsx";
import { TxManager, type TxSettings } from "../../../components/TxManager.tsx";
import { AutomationsManager, type Automation } from "../../../components/AutomationsManager.tsx";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function AdminTxPage() {
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

  let tx: TxSettings, outbox, node, automations: Automation[] = [];
  try {
    const cfg = await effectiveConfig();
    tx = cfg.tx as unknown as TxSettings;
    node = cfg.node;
    automations = cfg.automations as unknown as Automation[];
    outbox = await listOutbox(50);
  } catch (e) {
    return <DbError error={e} />;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="eyebrow"><span className="eyebrow-bar" />Transmit</h1>
        <span className="text-[11px] text-ink-faint">signed in as {session.sub}</span>
      </div>
      <TxManager initial={tx} initialNode={node} initialOutbox={outbox} />
      <AutomationsManager initial={automations} />
    </div>
  );
}
