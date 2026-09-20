import { type NextRequest } from "next/server";
import { verifySession, SESSION_COOKIE } from "./session.ts";
import { sessionAccess } from "./rbac.ts";
import { actorFor, type Actor } from "../db/ownednodes.ts";

// Resolve the signed-in actor (admin_users row) for an owned-node request, or null when
// anonymous / no matching account. Owned-node reads are additionally module-gated by
// requireModule(req, "owned"); writes check canEditNode / admin.
//
// The actor's admin flag comes from sessionAccess, i.e. the account's CURRENT stored role, not the
// role the cookie was signed with up to 30 days ago. Without that, demoting an admin left them full
// write access to every owned node until their cookie expired.
export async function requestActor(req: NextRequest): Promise<Actor | null> {
  const session = verifySession(req.cookies.get(SESSION_COOKIE)?.value);
  if (!session) return null;
  return actorFor(session.sub, (await sessionAccess(session)).admin);
}
