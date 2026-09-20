import { NextResponse, type NextRequest } from "next/server";
import { requireModule } from "../../../../../auth/rbac.ts";
import { requestActor } from "../../../../../auth/actor.ts";
import { listGroups } from "../../../../../db/ownednodes.ts";
import { query } from "../../../../../db/client.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Pickers for the owned-node UI: accounts and groups.
//
// A signed-in session is required, like every other route in this tree. Module gating alone was not
// enough: `resolveAccess` grants the anonymous role whenever server.auth.anonymous_read_only is on
// (the default), and nothing stops an operator granting the "owned" module to the anonymous role,
// which is a coherent choice for a public owned-node registry page. That combination turned this
// into an unauthenticated dump of every account.
//
// The Discord handle is admin-only. The picker needs the account list (any signed-in user may share
// a node with another user), but not each user's external identity.
export async function GET(req: NextRequest) {
  const denied = await requireModule(req, "owned");
  if (denied) return denied;
  const actor = await requestActor(req);
  if (!actor) return NextResponse.json({ error: "sign in required" }, { status: 401 });
  const rows = await query<{ id: number; username: string; discord_username: string | null }>(
    `SELECT id, username, discord_username FROM admin_users ORDER BY username`,
  );
  const users = actor.isAdmin ? rows : rows.map((u) => ({ id: u.id, username: u.username, discord_username: null }));
  const groups = await listGroups();
  return NextResponse.json({ users, groups });
}
