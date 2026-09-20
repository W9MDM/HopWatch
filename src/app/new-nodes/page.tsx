import { moduleDenied } from "../../components/ModuleGate.tsx";
import { newNodeFeed } from "../../db/queries.ts";
import { pageAccess } from "../../auth/rbac.ts";
import { DbError } from "../../components/DbError.tsx";
import { NewNodeFeed } from "../../components/NewNodeFeed.tsx";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function NewNodesPage() {
  const __denied = await moduleDenied("new-nodes"); if (__denied) return __denied;
  // The stored role, not the cookie's: a literal "admin" comparison on a 30-day-old cookie both
  // kept a demoted admin's controls and hid them from a custom admin role.
  const isAdmin = (await pageAccess()).admin;

  let rows;
  try {
    rows = await newNodeFeed(7);
  } catch (e) {
    return <DbError error={e} />;
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="eyebrow">
          <span className="eyebrow-bar" />
          New node feed
        </h1>
        <p className="mt-1 text-[13px] text-ink-faint">
          First-heard nodes from the last 7 days, doubling as the anomaly review queue.
          {isAdmin ? " Acknowledge items you have reviewed." : " Sign in as admin to acknowledge."}
        </p>
      </div>
      <NewNodeFeed initial={rows} isAdmin={isAdmin} />
    </div>
  );
}
