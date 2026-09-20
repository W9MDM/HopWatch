import Link from "next/link";
import { cookies } from "next/headers";
import { moduleDenied } from "../../components/ModuleGate.tsx";
import { verifySession, SESSION_COOKIE } from "../../auth/session.ts";
import { getUserIdByUsername } from "../../auth/users.ts";
import { listWatchlist } from "../../db/watchlist.ts";
import { effectiveConfig } from "../../db/appsettings.ts";
import { fmtAge } from "../../lib/format.ts";
import { formatNodeId } from "../../meshtastic/types.ts";
import { cn } from "../../lib/cn.ts";
import { roleColor } from "../../lib/rx.ts";
import { DbError } from "../../components/DbError.tsx";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function tz(): Promise<string> {
  try { return (await effectiveConfig()).server.local_timezone; } catch { return "UTC"; }
}

export default async function WatchlistPage() {
  const __denied = await moduleDenied("watchlist"); if (__denied) return __denied;
  const jar = await cookies();
  const session = verifySession(jar.get(SESSION_COOKIE)?.value);
  if (!session) {
    return (
      <div className="mx-auto max-w-sm py-16 text-center">
        <p className="text-[13px] text-ink-mute">Sign in to keep a watchlist of nodes.</p>
        <Link className="btn btn-primary mt-3 h-9 px-4 text-[13px]" href="/admin/login">Sign in</Link>
      </div>
    );
  }

  let rows;
  try {
    const uid = await getUserIdByUsername(session.sub);
    rows = uid ? await listWatchlist(uid) : [];
  } catch (e) {
    return <DbError error={e} />;
  }

  const zone = await tz();
  const alerting = rows.filter((r) => r.alert_offline && r.offline);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="eyebrow"><span className="eyebrow-bar" />Watchlist</h1>
        <p className="mt-1 text-[13px] text-ink-faint">Your starred nodes, private notes, tags, and offline alerts. Star a node from its page.</p>
      </div>

      {alerting.length > 0 && (
        <div className="rounded-md border border-accent/40 bg-accent/10 px-3 py-2 text-[13px] text-accent-strong">
          {alerting.length} watched node{alerting.length === 1 ? " is" : "s are"} currently offline: {alerting.map((r) => r.long_name ?? r.short_name ?? formatNodeId(r.node_id)).join(", ")}.
        </div>
      )}

      {rows.length === 0 ? (
        <div className="card text-ink-faint">Nothing watched yet. Open a node and hit &ldquo;Star this node&rdquo;.</div>
      ) : (
        <div className="card overflow-x-auto p-0">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-line text-left text-[11px] uppercase tracking-wide text-ink-faint">
                <th className="px-3 py-2"></th><th className="px-3 py-2">Node</th><th className="px-3 py-2">Short</th><th className="px-3 py-2">Role</th>
                <th className="px-3 py-2">Status</th><th className="px-3 py-2">Last heard</th><th className="px-3 py-2">Tags</th><th className="px-3 py-2">Note</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.node_id} className="border-b border-line/60 align-top hover:bg-raised/40">
                  <td className="px-3 py-2 text-accent-strong">{r.favorite ? "★" : ""}</td>
                  <td className="px-3 py-2">
                    <Link className="text-ink hover:text-accent" href={`/nodes/${r.node_id}`}>{r.long_name ?? r.short_name ?? formatNodeId(r.node_id)}</Link>
                    {r.open_flags > 0 && <span className="ml-2 rounded bg-accent/20 px-1.5 py-0.5 text-[10px] text-accent-strong">{r.open_flags} flag{r.open_flags === 1 ? "" : "s"}</span>}
                    <div className="mono text-[11px] text-ink-faint">{formatNodeId(r.node_id)}</div>
                  </td>
                  <td className="px-3 py-2 mono text-ink-mute">{r.short_name ?? "-"}</td>
                  <td className="px-3 py-2"><span className={cn(roleColor(r.role))}>{r.role ?? "unknown"}</span>{r.is_gateway ? <span className="ml-1 text-[10px] text-ink-faint">gw</span> : null}</td>
                  <td className="px-3 py-2">
                    <span className={r.offline ? "text-ink-faint" : "text-ok"}>{r.offline ? "offline" : "online"}</span>
                    {r.alert_offline && <span className="ml-1 text-[10px] text-ink-faint" title="offline alerts on">&#128276;</span>}
                  </td>
                  <td className="px-3 py-2 text-ink-mute">{r.last_seen_at ? `${fmtAge(r.last_seen_at)} ago` : "never"}</td>
                  <td className="px-3 py-2">{r.tags.map((t) => <span key={t} className="mr-1 inline-block rounded bg-raised px-1.5 py-0.5 text-[11px] text-ink-mute">{t}</span>)}</td>
                  <td className="px-3 py-2 max-w-xs text-ink-mute">{r.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
