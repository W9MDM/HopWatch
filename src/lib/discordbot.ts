import type { HopWatchConfig } from "../config/schema.ts";
import { query } from "../db/client.ts";
import { getNode, getNodeReach, getFleetReach } from "../db/queries.ts";
import { reachNumIdsForUser } from "../db/ownednodes.ts";

// Discord slash-command bot logic, kept out of the route so it is unit-testable and the route stays a
// thin verify-then-dispatch shell. Replies are Discord interaction responses (type 4 = message).
// Bounded work only: an interaction must be answered within ~3s, and every command here is a few
// indexed reads. The bot posts as its own configured identity (name/avatar set in the portal); unlike
// a webhook it cannot override the display name per message, so name the application "HopWatch".

const COLOR = 0x11b3a6; // teal, matches the webhook embeds
const EPHEMERAL = 64; // message flag: only the caller sees it (used for errors + help)

// Discord application command specs, sent verbatim to the register endpoint. option type 3 = STRING.
export const BOT_COMMANDS = [
  { name: "reach", description: "How far a node reaches: who hears it, link margin, redundancy", options: [{ name: "node", description: "Node name, !hex id, or number", type: 3, required: true }] },
  { name: "node", description: "Look up a node: position, last heard, hardware", options: [{ name: "query", description: "Node name, !hex id, or number", type: 3, required: true }] },
  { name: "myreach", description: "Your whole fleet's reach (link your Discord to HopWatch first)" },
  { name: "status", description: "HopWatch network snapshot" },
  { name: "claim", description: "How to claim a node so it shows in your stats", options: [{ name: "node", description: "Node name or !hex id (optional)", type: 3, required: false }] },
  // Post a message into the current channel as the bot (name it HopWatch). Admin-only by default
  // (default_member_permissions "0" = only members with Administrator, until re-enabled per role in
  // Server Settings), guild-only (no DMs).
  { name: "sendas", description: "Post a message into this channel as the bot", default_member_permissions: "0", dm_permission: false, options: [{ name: "message", description: "The message to post", type: 3, required: true }] },
] as const;

export type DiscordInteraction = {
  type?: number;
  channel_id?: string;
  channel?: { id?: string };
  data?: { name?: string; options?: { name: string; value?: unknown }[] };
  member?: { user?: { id?: string } };
  user?: { id?: string };
};
type Embed = Record<string, unknown>;
export type BotResponse = { type: 4; data: { embeds?: Embed[]; content?: string; flags?: number } };

const embed = (e: Embed): BotResponse => ({ type: 4, data: { embeds: [{ color: COLOR, ...e }] } });
const note = (text: string): BotResponse => ({ type: 4, data: { content: text, flags: EPHEMERAL } });
const optOf = (i: DiscordInteraction, name: string): string => String(i.data?.options?.find((o) => o.name === name)?.value ?? "").trim();
const hexId = (id: number) => "!" + (id >>> 0).toString(16).padStart(8, "0");
const nodeName = (n: { long_name: string | null; short_name: string | null; node_id: number }) => n.long_name ?? n.short_name ?? hexId(n.node_id);
const km = (v: number | null) => (v == null ? "-" : `${v.toFixed(1)} km`);
const ago = (s: string | null) => (s ? `${s.replace("T", " ").slice(0, 16)} UTC` : "never");

/** Parse a user-typed node reference: `!hex`, a bare 8-hex id, a decimal node id, or a name search. */
export async function resolveNodeId(q: string): Promise<number | null> {
  const s = (q || "").trim();
  if (!s) return null;
  if (s.startsWith("!") && /^[0-9a-fA-F]{1,8}$/.test(s.slice(1))) return parseInt(s.slice(1), 16) >>> 0;
  if (/^[0-9a-fA-F]{8}$/.test(s) && /[a-fA-F]/.test(s)) return parseInt(s, 16) >>> 0; // 8 hex chars with a letter
  if (/^\d+$/.test(s)) { const n = Number(s); if (Number.isFinite(n) && n > 0 && n <= 0xffffffff) return n >>> 0; }
  const exact = await query<{ node_id: number }>(`SELECT node_id FROM nodes WHERE long_name = ? OR short_name = ? ORDER BY last_seen_at DESC LIMIT 1`, [s, s]);
  if (exact[0]) return exact[0].node_id;
  const like = `%${s}%`;
  const fuzzy = await query<{ node_id: number }>(`SELECT node_id FROM nodes WHERE long_name LIKE ? OR short_name LIKE ? ORDER BY last_seen_at DESC LIMIT 1`, [like, like]);
  return fuzzy[0]?.node_id ?? null;
}

/** Verify-then-dispatch has already run in the route; this only handles APPLICATION_COMMAND (type 2). */
export async function handleInteraction(i: DiscordInteraction, cfg: HopWatchConfig, baseUrl: string): Promise<BotResponse> {
  const name = i.data?.name;
  const discordUserId = i.member?.user?.id ?? i.user?.id ?? null;
  try {
    if (name === "reach") return await cmdReach(optOf(i, "node"), baseUrl);
    if (name === "node") return await cmdNode(optOf(i, "query"), baseUrl);
    if (name === "myreach") return await cmdMyReach(discordUserId, baseUrl);
    if (name === "status") return await cmdStatus();
    if (name === "claim") return await cmdClaim(optOf(i, "node"), baseUrl);
    if (name === "sendas") return await cmdSendAs(optOf(i, "message"), i.channel_id ?? i.channel?.id ?? null, cfg);
    return note("Unknown command.");
  } catch (e) {
    return note(`Sorry, that command failed: ${(e as Error).message}`);
  }
}

async function cmdReach(q: string, baseUrl: string): Promise<BotResponse> {
  const id = await resolveNodeId(q);
  if (id == null) return note(`No node matches "${q}". Try a name, a !hex id, or the node number.`);
  const r = await getNodeReach(id);
  if (!r) return note(`No reach data for ${hexId(id)} yet.`);
  const s = r.summary;
  const name = nodeName(r.node);
  const fields = [
    { name: "Grade", value: `${s.grade} (${s.grade_score}/100)`, inline: true },
    { name: "Direct receivers", value: String(s.direct_receivers), inline: true },
    { name: "Neighbors", value: s.degree_rank ? `${s.neighbor_degree} (rank ${s.degree_rank}/${s.nodes_ranked})` : String(s.neighbor_degree), inline: true },
    { name: "Max distance", value: km(s.max_distance_km), inline: true },
    { name: "Redundancy", value: s.is_spof ? "Single point of failure" : "OK", inline: true },
    { name: "Heard relayed", value: String(s.heard_relayed), inline: true },
  ];
  const tips = r.tips.slice(0, 2).map((t) => `- ${t}`).join("\n");
  return embed({
    title: `Reach: ${name}`,
    url: `${baseUrl}/nodes/${id}/reach`,
    description: [s.grade_reason, tips].filter(Boolean).join("\n\n") || undefined,
    fields,
    footer: { text: `${hexId(id)} - last ${r.window_days} days` },
  });
}

async function cmdNode(q: string, baseUrl: string): Promise<BotResponse> {
  const id = await resolveNodeId(q);
  if (id == null) return note(`No node matches "${q}". Try a name, a !hex id, or the node number.`);
  const n = await getNode(id);
  if (!n) return note(`No node ${hexId(id)} on record yet.`);
  const pos = n.latitude != null && n.longitude != null
    ? `${n.latitude.toFixed(4)}, ${n.longitude.toFixed(4)}`
    : n.est_latitude != null && n.est_longitude != null ? `~${n.est_latitude.toFixed(4)}, ${n.est_longitude.toFixed(4)} (estimated)` : "unknown";
  const kind = n.is_gateway ? "gateway" : n.is_relay ? "relay" : "node";
  const fields = [
    { name: "Role", value: `${n.role ?? "?"} (${kind})`, inline: true },
    { name: "Hardware", value: n.hw_model ?? "?", inline: true },
    { name: "Last heard", value: ago(n.last_seen_at), inline: true },
    { name: "Position", value: pos, inline: true },
    { name: "Packets", value: String(n.total_packet_count ?? 0), inline: true },
    { name: "Receptions", value: String(n.total_reception_count ?? 0), inline: true },
  ];
  return embed({ title: nodeName(n), url: `${baseUrl}/nodes/${id}`, fields, footer: { text: hexId(id) } });
}

async function cmdMyReach(discordUserId: string | null, baseUrl: string): Promise<BotResponse> {
  if (!discordUserId) return note("Could not read your Discord id.");
  const rows = await query<{ id: number }>(`SELECT id FROM admin_users WHERE discord_id = ?`, [discordUserId]);
  if (!rows[0]) return note(`Link your Discord to HopWatch first: sign in at ${baseUrl} with Discord, then run /myreach again.`);
  const ids = await reachNumIdsForUser(rows[0].id);
  if (ids.length === 0) return note(`You have not claimed any nodes yet. Open your node at ${baseUrl}, then click "Claim this node".`);
  const f = await getFleetReach(ids);
  const s = f.summary;
  const fields = [
    { name: "Nodes claimed", value: `${s.nodes_claimed} (${s.nodes_mapped} mapped)`, inline: true },
    { name: "Unique receivers", value: String(s.unique_receivers), inline: true },
    { name: "Neighbors", value: String(s.unique_neighbors), inline: true },
    { name: "Relayed-by", value: String(s.relay_receivers), inline: true },
    { name: "Max reach", value: km(s.max_reach_km), inline: true },
    { name: "At risk", value: `${s.at_risk} node(s)`, inline: true },
  ];
  return embed({ title: "Your fleet reach", url: `${baseUrl}/my-reach`, fields, footer: { text: `last ${f.window_days} days` } });
}

async function cmdStatus(): Promise<BotResponse> {
  const [[tot], [day], [gw]] = await Promise.all([
    query<{ c: number }>(`SELECT COUNT(*) c FROM nodes`),
    query<{ c: number }>(`SELECT COUNT(*) c FROM nodes WHERE last_seen_at >= (UTC_TIMESTAMP() - INTERVAL 24 HOUR)`),
    query<{ c: number }>(`SELECT COUNT(*) c FROM nodes WHERE is_gateway = 1 AND last_seen_at >= (UTC_TIMESTAMP() - INTERVAL 24 HOUR)`),
  ]);
  const fields = [
    { name: "Nodes known", value: String(tot?.c ?? 0), inline: true },
    { name: "Heard (24h)", value: String(day?.c ?? 0), inline: true },
    { name: "Active gateways", value: String(gw?.c ?? 0), inline: true },
  ];
  return embed({ title: "HopWatch network", fields });
}

async function cmdClaim(q: string, baseUrl: string): Promise<BotResponse> {
  if (q) {
    const id = await resolveNodeId(q);
    if (id != null) {
      return note(`Claim ${hexId(id)}: sign in with Discord at ${baseUrl}, open ${baseUrl}/nodes/${id}, and click "Claim this node". It then appears in /myreach.`);
    }
  }
  return note(`To claim a node: sign in with Discord at ${baseUrl}, open your node's page (search it under Nodes), and click "Claim this node". Then /myreach shows your whole fleet.`);
}

// Post the pasted text into the invoking channel as the bot itself (a normal bot message, not an
// interaction reply, so there is no "used /sendas" line: it reads as a clean post from the bot's
// identity). The invoker gets an ephemeral confirmation only. Needs the bot's Send Messages permission
// in that channel; admin-gated by the command's default_member_permissions.
async function cmdSendAs(text: string, channelId: string | null, cfg: HopWatchConfig): Promise<BotResponse> {
  const msg = (text || "").trim();
  if (!msg) return note("Nothing to send. Usage: /sendas message: your text");
  if (!channelId) return note("Could not tell which channel to post in.");
  const token = cfg.discord_bot.bot_token;
  if (!token) return note("Bot token is not configured in HopWatch.");
  const trimmed = msg.length > 2000; // Discord's message content cap
  const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: "POST",
    headers: { authorization: `Bot ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ content: msg.slice(0, 2000) }),
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) {
    const detail = res.status === 403 ? "the bot needs the Send Messages permission in this channel." : (await res.text()).slice(0, 150);
    return note(`Could not post (Discord ${res.status}): ${detail}`);
  }
  return note(`Posted.${trimmed ? " (trimmed to 2000 characters)" : ""}`);
}
