import Link from "next/link";
import { cookies } from "next/headers";
import { verifySession, SESSION_COOKIE } from "../../auth/session.ts";
import { sessionAccess } from "../../auth/rbac.ts";
import { getUserPrefs, getDiscordLink } from "../../auth/users.ts";
import { effectiveConfig } from "../../db/appsettings.ts";
import { distinctBrokers } from "../../db/queries.ts";
import { distinctChannels } from "../../db/settings.ts";
import { actorFor, listOwnedNodesForUser, type OwnedNode } from "../../db/ownednodes.ts";
import { fmtAge } from "../../lib/format.ts";
import { formatNodeId } from "../../meshtastic/types.ts";
import { cn } from "../../lib/cn.ts";
import { DbError } from "../../components/DbError.tsx";
import { ProfileManager, type ProfileInitial } from "../../components/ProfileManager.tsx";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type SP = Record<string, string | string[] | undefined>;

function MyNodes({ nodes }: { nodes: OwnedNode[] }) {
  return (
    <div className="card">
      <div className="flex items-center justify-between">
        <h2 className="eyebrow"><span className="eyebrow-bar" />My nodes</h2>
        <Link className="text-[12px] text-accent hover:underline" href="/owned-nodes">Manage all</Link>
      </div>
      {nodes.length === 0 ? (
        <p className="mt-2 text-[13px] text-ink-faint">
          You have not claimed any nodes yet. Claim a node from its popup on the <Link className="text-accent hover:underline" href="/coverage">coverage map</Link> or from <Link className="text-accent hover:underline" href="/owned-nodes">owned nodes</Link>.
        </p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="data">
            <thead><tr><th>Name</th><th>Node ID</th><th>Role</th><th>Last heard</th><th className="text-right">Open issues</th></tr></thead>
            <tbody>
              {nodes.map((n) => {
                const idStr = n.num_id ? formatNodeId(n.num_id) : (n.node_id ?? "-");
                const name = n.name || n.observed_name || idStr;
                return (
                  <tr key={n.id}>
                    <td>
                      {n.num_id
                        ? <Link className="callsign" href={`/nodes/${n.num_id}`}>{name}</Link>
                        : <span>{name}</span>}
                      {n.planned_site ? <span className="pill pill-off ml-2">planned</span> : null}
                    </td>
                    <td className="mono text-ink-mute">{idStr}</td>
                    <td className="text-ink-mute">{n.role}</td>
                    <td className="text-ink-mute">{n.observed_last_seen ? fmtAge(n.observed_last_seen) : "never"}</td>
                    <td className="text-right tabular-nums">
                      <span className={cn(Number(n.open_issues) > 0 ? "text-accent-strong" : "text-ink-faint")}>{n.open_issues ?? 0}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default async function ProfilePage({ searchParams }: { searchParams: Promise<SP> }) {
  const jar = await cookies();
  const session = verifySession(jar.get(SESSION_COOKIE)?.value);
  if (!session) {
    return (
      <div className="mx-auto max-w-sm py-16 text-center">
        <p className="text-[13px] text-ink-mute">Sign in to manage your profile.</p>
        <Link className="btn btn-primary mt-3 h-9 px-4 text-[13px]" href="/admin/login">Sign in</Link>
      </div>
    );
  }

  const sp = await searchParams;
  const discordNote = Array.isArray(sp.discord) ? sp.discord[0] : sp.discord;

  let initial: ProfileInitial;
  let myNodes: OwnedNode[] = [];
  try {
    // The role shown here (and the actor's admin flag) is the account's CURRENT stored role, not the
    // one signed into the cookie at login, so a demotion is reflected immediately rather than after
    // the 30-day cookie lifetime.
    const access = await sessionAccess(session);
    const [prefs, discord, brokers, channels, cfg, actor] = await Promise.all([
      getUserPrefs(session.sub), getDiscordLink(session.sub), distinctBrokers(), distinctChannels(), effectiveConfig(),
      actorFor(session.sub, access.admin),
    ]);
    initial = {
      username: session.sub, role: access.roleKey, discord_linked: discord,
      discord_enabled: cfg.server.auth.discord.enabled, prefs, brokers, channels,
    };
    if (actor) myNodes = await listOwnedNodesForUser(actor.id);
  } catch (e) {
    return <DbError error={e} />;
  }

  return (
    <div className="space-y-4">
      <h1 className="eyebrow"><span className="eyebrow-bar" />Profile</h1>
      {discordNote === "linked" && <div className="rounded-md border border-ok/40 bg-ok/10 px-3 py-2 text-[13px] text-ok">Discord linked.</div>}
      {discordNote && discordNote !== "linked" && <div className="rounded-md border border-accent/40 bg-accent/10 px-3 py-2 text-[13px] text-accent-strong">Could not link Discord: {discordNote}</div>}
      <MyNodes nodes={myNodes} />
      <ProfileManager initial={initial} />
    </div>
  );
}
