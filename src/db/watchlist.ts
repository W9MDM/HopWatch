// Per-user node watchlist: favorites, private notes, tags, and per-node alert subscriptions.
// Private to each account (keyed on admin_users.id). See migration 0022.
import { query } from "./client.ts";
import { toMysqlUtc } from "../lib/time.ts";

export interface UserNode {
  node_id: number;
  favorite: boolean;
  note: string;
  tags: string[];
  alert_offline: boolean;
}

export interface WatchRow extends UserNode {
  long_name: string | null;
  short_name: string | null;
  role: string | null;
  is_gateway: number;
  last_seen_at: string | null;
  latitude: number | null;
  longitude: number | null;
  open_flags: number;
  offline: boolean; // last seen > 2h ago (matches the dashboard "stale/off" convention)
}

function parseTags(raw: unknown): string[] {
  if (!raw) return [];
  try {
    const a = typeof raw === "string" ? JSON.parse(raw) : raw;
    return Array.isArray(a) ? a.map((t) => String(t)).filter(Boolean).slice(0, 20) : [];
  } catch {
    return [];
  }
}

const EMPTY = (nodeId: number): UserNode => ({ node_id: nodeId, favorite: false, note: "", tags: [], alert_offline: false });

export async function getUserNode(userId: number, nodeId: number): Promise<UserNode> {
  const rows = await query<{ favorite: number; note: string | null; tags: unknown; alert_offline: number }>(
    `SELECT favorite, note, tags, alert_offline FROM user_node WHERE user_id=? AND node_id=?`,
    [userId, nodeId],
  );
  const r = rows[0];
  if (!r) return EMPTY(nodeId);
  return { node_id: nodeId, favorite: !!r.favorite, note: r.note ?? "", tags: parseTags(r.tags), alert_offline: !!r.alert_offline };
}

export interface WatchPatch { favorite?: boolean; note?: string; tags?: string[]; alert_offline?: boolean }

/** Upsert one node's watch state for a user. Removes the row when nothing is set (unwatch). */
export async function saveUserNode(userId: number, nodeId: number, patch: WatchPatch): Promise<void> {
  const cur = await getUserNode(userId, nodeId);
  const next: UserNode = {
    node_id: nodeId,
    favorite: patch.favorite ?? cur.favorite,
    note: (patch.note ?? cur.note).slice(0, 4000),
    tags: (patch.tags ?? cur.tags).map((t) => String(t).trim().slice(0, 40)).filter(Boolean).slice(0, 20),
    alert_offline: patch.alert_offline ?? cur.alert_offline,
  };
  // Nothing worth keeping -> drop the row so it disappears from the watchlist.
  if (!next.favorite && !next.note && next.tags.length === 0 && !next.alert_offline) {
    await query(`DELETE FROM user_node WHERE user_id=? AND node_id=?`, [userId, nodeId]);
    return;
  }
  await query(
    `INSERT INTO user_node (user_id, node_id, favorite, note, tags, alert_offline, updated_at)
     VALUES (?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE favorite=VALUES(favorite), note=VALUES(note), tags=VALUES(tags), alert_offline=VALUES(alert_offline), updated_at=VALUES(updated_at)`,
    [userId, nodeId, next.favorite ? 1 : 0, next.note || null, JSON.stringify(next.tags), next.alert_offline ? 1 : 0, toMysqlUtc(new Date())],
  );
}

/** The user's watched nodes joined with live node state (name, status, flags, position). */
export async function listWatchlist(userId: number): Promise<WatchRow[]> {
  const rows = await query<any>(
    `SELECT un.node_id, un.favorite, un.note, un.tags, un.alert_offline,
            n.long_name, n.short_name, n.role, n.is_gateway, n.last_seen_at,
            p.latitude, p.longitude,
            (SELECT COUNT(*) FROM node_flags f WHERE f.node_id=un.node_id AND f.resolved_at IS NULL) AS open_flags
     FROM user_node un
     LEFT JOIN nodes n ON n.node_id=un.node_id
     LEFT JOIN node_positions p ON p.node_id=un.node_id
     WHERE un.user_id=?
     ORDER BY un.favorite DESC, n.last_seen_at DESC`,
    [userId],
  );
  const now = Date.now();
  return rows.map((r) => {
    const lastMs = r.last_seen_at ? new Date(String(r.last_seen_at).replace(" ", "T") + "Z").getTime() : 0;
    return {
      node_id: Number(r.node_id), favorite: !!r.favorite, note: r.note ?? "", tags: parseTags(r.tags), alert_offline: !!r.alert_offline,
      long_name: r.long_name ?? null, short_name: r.short_name ?? null, role: r.role ?? null, is_gateway: Number(r.is_gateway ?? 0),
      last_seen_at: r.last_seen_at ?? null, latitude: r.latitude ?? null, longitude: r.longitude ?? null,
      open_flags: Number(r.open_flags ?? 0), offline: lastMs === 0 || now - lastMs > 2 * 3600 * 1000,
    };
  });
}
