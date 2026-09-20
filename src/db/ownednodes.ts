// Owned-node registry: curated, human-managed node records ported from the standalone
// meshadmin app (ownership, group sharing, maintenance logs, issue tracking). Distinct from
// the observed `nodes` table (auto-populated from MQTT); owned_node.num_id links the two
// when a numeric id is known. Identity is HopWatch's admin_users (see migration 0020).
import { query, clampLimit } from "./client.ts";
import { toMysqlUtc } from "../lib/time.ts";

export interface OwnedNode {
  id: number;
  name: string;
  node_id: string | null;
  num_id: number | null;
  owner: string | null;
  owner_type: "user" | "group";
  owner_user_id: number | null;
  owner_group_id: number | null;
  model: string | null;
  elevation: string | null;
  frequency: string;
  mqtt_topic: string | null;
  mqtt_connected: number;
  online: number;
  role: string;
  lat: number | null;
  lng: number | null;
  planned_site: number;
  created_at: string;
  // enrichment
  owner_label?: string | null;
  open_issues?: number;
  observed_name?: string | null;
  observed_last_seen?: string | null;
  can_edit?: boolean;
}

export interface Actor {
  id: number;
  username: string;
  isAdmin: boolean;
}

/**
 * Resolve a signed-in username to an actor, or null (anonymous / unknown account).
 *
 * `isAdmin` is supplied by the caller from `sessionAccess`/`pageAccess`, which re-read the account's
 * CURRENT role. It used to be derived from the role string baked into the session cookie at login,
 * which `signSession` stamps for `server.auth.session_ttl_hours` (default 30 days). That put the
 * whole owned-node subsystem back on the stale-cookie footing `src/auth/rbac.ts` deliberately left:
 * a demoted admin still passed `requireModule(req, "owned")` (the default member role grants that
 * module) and then `canEditNode` short-circuited on `actor.isAdmin`, so for up to 30 days they could
 * still edit or delete any registry entry, reassign its ownership, add shares to nodes they do not
 * own, and close other people's issues. Deriving it from the resolved access also honours a CUSTOM
 * admin role, which a literal `role === "admin"` comparison never did.
 */
export async function actorFor(username: string | null | undefined, isAdmin: boolean): Promise<Actor | null> {
  if (!username) return null;
  const rows = await query<{ id: number }>(`SELECT id FROM admin_users WHERE username=?`, [username]);
  if (!rows[0]) return null;
  return { id: Number(rows[0].id), username, isAdmin };
}

/** Group ids the user is a member of (plus groups they created). */
async function userGroupIds(userId: number): Promise<number[]> {
  const rows = await query<{ group_id: number }>(
    `SELECT group_id FROM node_group_member WHERE user_id=?
     UNION SELECT id AS group_id FROM node_group WHERE created_by=?`,
    [userId, userId],
  );
  return rows.map((r) => Number(r.group_id));
}

const NODE_COLS = `n.id, n.name, n.node_id, n.num_id, n.owner, n.owner_type, n.owner_user_id, n.owner_group_id,
  n.model, n.elevation, n.frequency, n.mqtt_topic, n.mqtt_connected, n.online, n.role, n.lat, n.lng,
  n.planned_site, n.created_at`;

/** Full registry, enriched with owner label, open-issue count, and observed-node join. */
export async function listOwnedNodes(): Promise<OwnedNode[]> {
  return query<OwnedNode>(
    `SELECT ${NODE_COLS},
       COALESCE(u.username, g.name, n.owner) AS owner_label,
       (SELECT COUNT(*) FROM node_issue i WHERE i.owned_node_id=n.id AND i.status IN ('open','in_progress')) AS open_issues,
       o.long_name AS observed_name,
       o.last_seen_at AS observed_last_seen
     FROM owned_node n
     LEFT JOIN admin_users u ON u.id=n.owner_user_id
     LEFT JOIN node_group  g ON g.id=n.owner_group_id
     LEFT JOIN nodes       o ON o.node_id=n.num_id
     ORDER BY n.name`,
  );
}

/** Observed node nums a user can call "theirs" for reach: owned directly OR owned by a group they
 * are a member of (or created). Used by the My reach fleet view. */
export async function reachNumIdsForUser(userId: number): Promise<number[]> {
  const rows = await query<{ num_id: number }>(
    `SELECT DISTINCT num_id FROM owned_node
     WHERE num_id IS NOT NULL AND (
       owner_user_id = ?
       OR owner_group_id IN (
         SELECT group_id FROM node_group_member WHERE user_id = ?
         UNION SELECT id FROM node_group WHERE created_by = ?
       ))`,
    [userId, userId, userId]);
  return rows.map((r) => r.num_id >>> 0);
}

/** Nodes a user has claimed (owns directly), enriched, for their profile "My nodes" section. */
export async function listOwnedNodesForUser(userId: number): Promise<OwnedNode[]> {
  return query<OwnedNode>(
    `SELECT ${NODE_COLS},
       COALESCE(u.username, g.name, n.owner) AS owner_label,
       (SELECT COUNT(*) FROM node_issue i WHERE i.owned_node_id=n.id AND i.status IN ('open','in_progress')) AS open_issues,
       o.long_name AS observed_name,
       o.last_seen_at AS observed_last_seen
     FROM owned_node n
     LEFT JOIN admin_users u ON u.id=n.owner_user_id
     LEFT JOIN node_group  g ON g.id=n.owner_group_id
     LEFT JOIN nodes       o ON o.node_id=n.num_id
     WHERE n.owner_user_id=?
     ORDER BY n.name`,
    [userId],
  );
}

export interface OperatorScore {
  username: string;
  nodes: number;
  gateways: number;
  planned: number;
  open_issues: number;
}

/** Operator leaderboard: claimed-node counts per owner, for the scoreboard. */
export async function operatorScoreboard(limit = 100): Promise<OperatorScore[]> {
  return query<OperatorScore>(
    `SELECT u.username,
       COUNT(DISTINCT n.id) AS nodes,
       COUNT(DISTINCT CASE WHEN o.is_gateway=1 THEN n.id END) AS gateways,
       COUNT(DISTINCT CASE WHEN n.planned_site=1 THEN n.id END) AS planned,
       (SELECT COUNT(*) FROM node_issue i JOIN owned_node nn ON nn.id=i.owned_node_id
          WHERE nn.owner_user_id=u.id AND i.status IN ('open','in_progress')) AS open_issues
     FROM owned_node n
     JOIN admin_users u ON u.id=n.owner_user_id
     LEFT JOIN nodes o ON o.node_id=n.num_id
     GROUP BY u.id, u.username
     ORDER BY gateways DESC, nodes DESC
     LIMIT ${clampLimit(limit, 500)}`,
  );
}

export async function getOwnedNode(id: number): Promise<OwnedNode | null> {
  const rows = await query<OwnedNode>(
    `SELECT ${NODE_COLS}, COALESCE(u.username, g.name, n.owner) AS owner_label
     FROM owned_node n
     LEFT JOIN admin_users u ON u.id=n.owner_user_id
     LEFT JOIN node_group  g ON g.id=n.owner_group_id
     WHERE n.id=?`,
    [id],
  );
  return rows[0] ?? null;
}

/** True if the actor may edit / delete / manage this node. */
export async function canEditNode(actor: Actor | null, id: number): Promise<boolean> {
  if (!actor) return false;
  if (actor.isAdmin) return true;
  const rows = await query<{ owner_user_id: number | null; owner_group_id: number | null }>(
    `SELECT owner_user_id, owner_group_id FROM owned_node WHERE id=?`,
    [id],
  );
  const node = rows[0];
  if (!node) return false;
  if (node.owner_user_id && Number(node.owner_user_id) === actor.id) return true;
  const groups = await userGroupIds(actor.id);
  if (node.owner_group_id && groups.includes(Number(node.owner_group_id))) return true;
  // Edit-level share (direct or via a group the user belongs to).
  const share = await query<{ c: number }>(
    `SELECT COUNT(*) c FROM node_permission
     WHERE owned_node_id=? AND permission_level='edit'
       AND (user_id=? OR group_id IN (${groups.length ? groups.map(() => "?").join(",") : "NULL"}))`,
    [id, actor.id, ...groups],
  );
  return Number(share[0]?.c ?? 0) > 0;
}

/**
 * The set of owned-node ids this actor may edit, in a fixed number of queries.
 *
 * The per-row alternative was three queries per node (the node lookup, the group list, the share
 * count), run strictly sequentially by the listing route: on an install with 400 claimed nodes a
 * member's page load meant ~1,200 sequential round trips, each holding a pool connection, growing
 * linearly with the table. Admins and anonymous callers short-circuit, which is why the cost was
 * invisible in admin testing.
 */
export async function editableNodeIds(actor: Actor | null): Promise<Set<number>> {
  if (!actor) return new Set();
  const groups = await userGroupIds(actor.id);
  const gp = groups.length ? groups.map(() => "?").join(",") : "NULL";
  const rows = await query<{ id: number }>(
    `SELECT id FROM owned_node
      WHERE owner_user_id = ?
         OR (owner_group_id IS NOT NULL AND owner_group_id IN (${gp}))
         OR id IN (
              SELECT owned_node_id FROM node_permission
               WHERE permission_level='edit' AND (user_id = ? OR group_id IN (${gp}))
            )`,
    [actor.id, ...groups, actor.id, ...groups],
  );
  return new Set(rows.map((r) => Number(r.id)));
}

function numFromNodeId(nodeId: string | null): number | null {
  if (!nodeId) return null;
  const hex = nodeId.replace(/^!/, "").trim();
  if (!/^[0-9a-fA-F]{1,8}$/.test(hex)) return null;
  return parseInt(hex, 16) >>> 0;
}

export interface OwnedNodeInput {
  name: string;
  node_id?: string | null;
  owner_type?: "user" | "group";
  owner_user_id?: number | null;
  owner_group_id?: number | null;
  model?: string | null;
  elevation?: string | null;
  frequency?: string;
  mqtt_topic?: string | null;
  mqtt_connected?: boolean;
  online?: boolean;
  role?: string;
  lat?: number | null;
  lng?: number | null;
  planned_site?: boolean;
}

export async function createOwnedNode(input: OwnedNodeInput, ownerLabel: string | null): Promise<number> {
  const nodeId = input.node_id?.trim() || null;
  const isGroup = input.owner_type === "group";
  const r = await query<never>(
    `INSERT INTO owned_node
       (name, node_id, num_id, owner, owner_type, owner_user_id, owner_group_id, model, elevation,
        frequency, mqtt_topic, mqtt_connected, online, role, lat, lng, planned_site, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      input.name, nodeId, numFromNodeId(nodeId), ownerLabel, isGroup ? "group" : "user",
      isGroup ? null : input.owner_user_id ?? null, isGroup ? input.owner_group_id ?? null : null,
      input.model ?? null, input.elevation ?? null, input.frequency || "915 MHz", input.mqtt_topic ?? null,
      input.mqtt_connected ? 1 : 0, input.online ? 1 : 0, input.role || "Client",
      input.lat ?? null, input.lng ?? null, input.planned_site ? 1 : 0, toMysqlUtc(new Date()),
    ],
  );
  return (r as unknown as { insertId: number }).insertId;
}

export async function updateOwnedNode(id: number, input: OwnedNodeInput, ownerLabel: string | null): Promise<void> {
  const nodeId = input.node_id?.trim() || null;
  const isGroup = input.owner_type === "group";
  await query(
    `UPDATE owned_node SET name=?, node_id=?, num_id=?, owner=?, owner_type=?, owner_user_id=?, owner_group_id=?,
       model=?, elevation=?, frequency=?, mqtt_topic=?, mqtt_connected=?, online=?, role=?, lat=?, lng=?, planned_site=?
     WHERE id=?`,
    [
      input.name, nodeId, numFromNodeId(nodeId), ownerLabel, isGroup ? "group" : "user",
      isGroup ? null : input.owner_user_id ?? null, isGroup ? input.owner_group_id ?? null : null,
      input.model ?? null, input.elevation ?? null, input.frequency || "915 MHz", input.mqtt_topic ?? null,
      input.mqtt_connected ? 1 : 0, input.online ? 1 : 0, input.role || "Client",
      input.lat ?? null, input.lng ?? null, input.planned_site ? 1 : 0, id,
    ],
  );
}

export async function deleteOwnedNode(id: number): Promise<void> {
  await query(`DELETE FROM owned_node WHERE id=?`, [id]);
}

/** Observed nodes whose short name matches a MySQL REGEXP, for pattern-based bulk assignment. */
export async function numIdsByShortNamePattern(pattern: string): Promise<{ num: number; name: string; short: string | null }[]> {
  const p = (pattern ?? "").trim().slice(0, 128);
  if (!p) return [];
  const rows = await query<{ node_id: number; long_name: string | null; short_name: string | null }>(
    `SELECT node_id, long_name, short_name FROM nodes WHERE short_name REGEXP ? ORDER BY short_name LIMIT 500`, [p]);
  return rows.map((r) => ({ num: r.node_id >>> 0, name: r.long_name ?? r.short_name ?? ("!" + (r.node_id >>> 0).toString(16).padStart(8, "0")), short: r.short_name }));
}

/**
 * Bulk-assign nodes to a user OR a group: reassign existing owned_node rows and/or, for observed node
 * nums not yet in the registry, create an owned_node record with that owner. Admin action. Pass
 * exactly one of ownerUserId / ownerGroupId. Returns counts.
 */
export async function bulkAssign(opts: { ownerUserId?: number; ownerGroupId?: number; ownedIds?: number[]; nodeNums?: { num: number; name: string }[] }): Promise<{ created: number; reassigned: number }> {
  const isGroup = opts.ownerGroupId != null;
  const label = isGroup
    ? (await query<{ name: string }>(`SELECT name FROM node_group WHERE id=?`, [opts.ownerGroupId]))[0]?.name
    : (await query<{ username: string }>(`SELECT username FROM admin_users WHERE id=?`, [opts.ownerUserId]))[0]?.username;
  if (!label) throw new Error(isGroup ? "unknown group" : "unknown user");
  const ownerType = isGroup ? "group" : "user";
  const uid = isGroup ? null : opts.ownerUserId ?? null;
  const gid = isGroup ? opts.ownerGroupId ?? null : null;
  let created = 0, reassigned = 0;

  const ownedIds = [...new Set((opts.ownedIds ?? []).filter((x) => Number.isInteger(x) && x > 0))];
  if (ownedIds.length) {
    await query(
      `UPDATE owned_node SET owner_user_id=?, owner_group_id=?, owner_type=?, owner=? WHERE id IN (${ownedIds.map(() => "?").join(",")})`,
      [uid, gid, ownerType, label, ...ownedIds]);
    reassigned += ownedIds.length;
  }

  for (const n of opts.nodeNums ?? []) {
    const num = n.num >>> 0;
    if (!num) continue;
    const hex = "!" + num.toString(16).padStart(8, "0");
    const existing = await query<{ id: number }>(`SELECT id FROM owned_node WHERE num_id=? LIMIT 1`, [num]);
    if (existing[0]) {
      await query(`UPDATE owned_node SET owner_user_id=?, owner_group_id=?, owner_type=?, owner=? WHERE id=?`, [uid, gid, ownerType, label, existing[0].id]);
      reassigned += 1;
    } else {
      await query(
        `INSERT INTO owned_node (name, node_id, num_id, owner, owner_type, owner_user_id, owner_group_id, model, elevation, frequency, mqtt_topic, mqtt_connected, online, role, lat, lng, planned_site, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [n.name.slice(0, 120), hex, num, label, ownerType, uid, gid, null, null, "915 MHz", null, 0, 0, "Client", null, null, 0, toMysqlUtc(new Date())]);
      created += 1;
    }
  }
  return { created, reassigned };
}

/** Human-readable owner label stored alongside the resolved FK (mirrors meshadmin). */
export async function ownerLabelFor(b: OwnedNodeInput): Promise<string | null> {
  if (b.owner_type === "group" && b.owner_group_id) {
    const rows = await query<{ name: string }>(`SELECT name FROM node_group WHERE id=?`, [b.owner_group_id]);
    return rows[0]?.name ?? null;
  }
  if (b.owner_user_id) {
    const rows = await query<{ username: string }>(`SELECT username FROM admin_users WHERE id=?`, [b.owner_user_id]);
    return rows[0]?.username ?? null;
  }
  return null;
}

// --- Claiming (from the observed node page / map) ---

export interface ClaimStatus {
  owned_node_id: number | null;
  owner_user_id: number | null;
  owner_group_id: number | null;
  owner_label: string | null;
  mine: boolean;
  can_claim: boolean; // signed-in and (unclaimed or admin)
}

const nodeIdStrFromNum = (num: number) => "!" + (num >>> 0).toString(16).padStart(8, "0");

/** Claim state of an observed node (by numeric id) for the given actor. */
export async function getClaimStatus(numId: number, actor: Actor | null): Promise<ClaimStatus> {
  const rows = await query<{ id: number; owner_user_id: number | null; owner_group_id: number | null; owner_label: string | null }>(
    `SELECT n.id, n.owner_user_id, n.owner_group_id, COALESCE(u.username, g.name, n.owner) AS owner_label
     FROM owned_node n LEFT JOIN admin_users u ON u.id=n.owner_user_id LEFT JOIN node_group g ON g.id=n.owner_group_id
     WHERE n.num_id=? LIMIT 1`,
    [numId],
  );
  const r = rows[0];
  const claimed = !!(r && (r.owner_user_id || r.owner_group_id));
  const mine = !!(r && actor && Number(r.owner_user_id) === actor.id);
  return {
    owned_node_id: r?.id ?? null,
    owner_user_id: r?.owner_user_id ?? null,
    owner_group_id: r?.owner_group_id ?? null,
    owner_label: r?.owner_label ?? null,
    mine,
    can_claim: !!actor && (!claimed || actor.isAdmin || mine),
  };
}

export type ClaimResult = { status: "claimed" | "mine" | "taken"; owned_node_id?: number; owner_label?: string | null };

/** Claim an observed node for the actor. Creates the owned_node if none exists yet. */
export async function claimNode(actor: Actor, numId: number, defaults: { name?: string; lat?: number | null; lng?: number | null; role?: string }): Promise<ClaimResult> {
  const st = await getClaimStatus(numId, actor);
  if (st.mine) return { status: "mine", owned_node_id: st.owned_node_id!, owner_label: actor.username };
  if (st.owned_node_id && (st.owner_user_id || st.owner_group_id) && !actor.isAdmin) {
    return { status: "taken", owner_label: st.owner_label };
  }
  if (st.owned_node_id) {
    await query(`UPDATE owned_node SET owner_type='user', owner_user_id=?, owner_group_id=NULL, owner=? WHERE id=?`, [actor.id, actor.username, st.owned_node_id]);
    return { status: "claimed", owned_node_id: st.owned_node_id, owner_label: actor.username };
  }
  const id = await createOwnedNode(
    { name: defaults.name || nodeIdStrFromNum(numId), node_id: nodeIdStrFromNum(numId), owner_type: "user", owner_user_id: actor.id, role: defaults.role || "Client", lat: defaults.lat ?? null, lng: defaults.lng ?? null },
    actor.username,
  );
  return { status: "claimed", owned_node_id: id, owner_label: actor.username };
}

/**
 * Link imported nodes to an account by their free-text owner tag. meshadmin nodes carry a
 * Discord-handle-ish `owner` string (e.g. "RuffJas"); when that user signs in with Discord,
 * any still-unowned node whose owner tag matches one of their handles becomes theirs. Only
 * touches nodes with no resolved owner yet, so it never steals an already-claimed node.
 * Returns the number of nodes linked.
 */
export async function assignOwnershipByHandle(userId: number, handles: (string | null | undefined)[]): Promise<number> {
  const norm = [...new Set(handles.map((h) => String(h ?? "").trim().toLowerCase()).filter(Boolean))];
  if (norm.length === 0) return 0;
  const placeholders = norm.map(() => "?").join(",");
  const r = await query<never>(
    `UPDATE owned_node SET owner_user_id=?, owner_type='user'
     WHERE owner_user_id IS NULL AND owner_group_id IS NULL AND LOWER(TRIM(owner)) IN (${placeholders})`,
    [userId, ...norm],
  );
  return Number((r as unknown as { affectedRows?: number }).affectedRows ?? 0);
}

/** Release ownership (owner or admin). Keeps the record and its issues/maintenance. */
export async function releaseNode(actor: Actor, numId: number): Promise<boolean> {
  const st = await getClaimStatus(numId, actor);
  if (!st.owned_node_id) return false;
  if (!actor.isAdmin && !st.mine) return false;
  await query(`UPDATE owned_node SET owner_user_id=NULL, owner=NULL WHERE id=?`, [st.owned_node_id]);
  return true;
}

// --- Groups ---

export interface NodeGroup { id: number; name: string; description: string | null; created_by: number | null; created_at: string; member_count?: number; creator?: string | null }

export async function listGroups(): Promise<NodeGroup[]> {
  return query<NodeGroup>(
    `SELECT g.id, g.name, g.description, g.created_by, g.created_at,
       (SELECT COUNT(*) FROM node_group_member m WHERE m.group_id=g.id) AS member_count,
       c.username AS creator
     FROM node_group g LEFT JOIN admin_users c ON c.id=g.created_by
     ORDER BY g.name`,
  );
}

export async function createGroup(name: string, description: string | null, createdBy: number): Promise<number> {
  const r = await query<never>(`INSERT INTO node_group (name, description, created_by, created_at) VALUES (?,?,?,?)`, [name, description, createdBy, toMysqlUtc(new Date())]);
  return (r as unknown as { insertId: number }).insertId;
}

export async function deleteGroup(id: number): Promise<void> {
  await query(`DELETE FROM node_group WHERE id=?`, [id]);
}

export async function listGroupMembers(groupId: number): Promise<{ user_id: number; username: string }[]> {
  return query(`SELECT m.user_id, u.username FROM node_group_member m JOIN admin_users u ON u.id=m.user_id WHERE m.group_id=? ORDER BY u.username`, [groupId]);
}

export async function addGroupMember(groupId: number, userId: number): Promise<void> {
  await query(`INSERT INTO node_group_member (group_id, user_id, created_at) VALUES (?,?,?) ON DUPLICATE KEY UPDATE group_id=group_id`, [groupId, userId, toMysqlUtc(new Date())]);
}

export async function removeGroupMember(groupId: number, userId: number): Promise<void> {
  await query(`DELETE FROM node_group_member WHERE group_id=? AND user_id=?`, [groupId, userId]);
}

// --- Shares ---

export interface Share { id: number; user_id: number | null; group_id: number | null; permission_level: "view" | "edit"; label: string }

export async function listShares(nodeId: number): Promise<Share[]> {
  return query<Share>(
    `SELECT p.id, p.user_id, p.group_id, p.permission_level, COALESCE(u.username, g.name) AS label
     FROM node_permission p LEFT JOIN admin_users u ON u.id=p.user_id LEFT JOIN node_group g ON g.id=p.group_id
     WHERE p.owned_node_id=? ORDER BY label`,
    [nodeId],
  );
}

export async function addShare(nodeId: number, target: { user_id?: number; group_id?: number }, level: "view" | "edit", grantedBy: number): Promise<void> {
  await query(
    `INSERT INTO node_permission (owned_node_id, user_id, group_id, permission_level, granted_by, granted_at)
     VALUES (?,?,?,?,?,?) ON DUPLICATE KEY UPDATE permission_level=VALUES(permission_level)`,
    [nodeId, target.user_id ?? null, target.group_id ?? null, level, grantedBy, toMysqlUtc(new Date())],
  );
}

export async function removeShare(shareId: number, nodeId: number): Promise<void> {
  await query(`DELETE FROM node_permission WHERE id=? AND owned_node_id=?`, [shareId, nodeId]);
}

// --- Maintenance ---

export interface Maintenance { id: number; owned_node_id: number; user_id: number | null; visit_date: string; notes: string | null; created_at: string; username?: string | null }

export async function listMaintenance(nodeId: number): Promise<Maintenance[]> {
  return query<Maintenance>(
    `SELECT m.id, m.owned_node_id, m.user_id, m.visit_date, m.notes, m.created_at, u.username
     FROM node_maintenance m LEFT JOIN admin_users u ON u.id=m.user_id
     WHERE m.owned_node_id=? ORDER BY m.visit_date DESC`,
    [nodeId],
  );
}

export async function addMaintenance(nodeId: number, userId: number | null, visitDate: Date, notes: string | null): Promise<void> {
  await query(`INSERT INTO node_maintenance (owned_node_id, user_id, visit_date, notes, created_at) VALUES (?,?,?,?,?)`, [nodeId, userId, toMysqlUtc(visitDate), notes, toMysqlUtc(new Date())]);
}

export async function deleteMaintenance(id: number, nodeId: number): Promise<void> {
  await query(`DELETE FROM node_maintenance WHERE id=? AND owned_node_id=?`, [id, nodeId]);
}

// --- Issues ---

export type IssueStatus = "open" | "in_progress" | "resolved" | "closed";
export interface Issue { id: number; owned_node_id: number; reported_by: number | null; issue_type: string; description: string | null; status: IssueStatus; reported_at: string; resolved_at: string | null; reporter?: string | null; node_name?: string }

export async function listIssues(nodeId: number): Promise<Issue[]> {
  return query<Issue>(
    `SELECT i.id, i.owned_node_id, i.reported_by, i.issue_type, i.description, i.status, i.reported_at, i.resolved_at, u.username AS reporter
     FROM node_issue i LEFT JOIN admin_users u ON u.id=i.reported_by
     WHERE i.owned_node_id=? ORDER BY (i.status IN ('open','in_progress')) DESC, i.reported_at DESC`,
    [nodeId],
  );
}

/** Open issues across all nodes, for the registry overview. */
export async function listOpenIssues(): Promise<Issue[]> {
  return query<Issue>(
    `SELECT i.id, i.owned_node_id, i.reported_by, i.issue_type, i.description, i.status, i.reported_at, i.resolved_at,
       u.username AS reporter, n.name AS node_name
     FROM node_issue i JOIN owned_node n ON n.id=i.owned_node_id LEFT JOIN admin_users u ON u.id=i.reported_by
     WHERE i.status IN ('open','in_progress') ORDER BY i.reported_at DESC`,
  );
}

export async function createIssue(nodeId: number, reportedBy: number | null, issueType: string, description: string | null): Promise<void> {
  await query(`INSERT INTO node_issue (owned_node_id, reported_by, issue_type, description, status, reported_at) VALUES (?,?,?,?,'open',?)`, [nodeId, reportedBy, issueType, description, toMysqlUtc(new Date())]);
}

export async function updateIssueStatus(id: number, nodeId: number, status: IssueStatus): Promise<void> {
  const resolved = status === "resolved" || status === "closed";
  await query(`UPDATE node_issue SET status=?, resolved_at=${resolved ? "?" : "NULL"} WHERE id=? AND owned_node_id=?`, resolved ? [status, toMysqlUtc(new Date()), id, nodeId] : [status, id, nodeId]);
}

export async function deleteIssue(id: number, nodeId: number): Promise<void> {
  await query(`DELETE FROM node_issue WHERE id=? AND owned_node_id=?`, [id, nodeId]);
}
