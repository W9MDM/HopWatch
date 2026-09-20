import { NextResponse, type NextRequest } from "next/server";
import { requireAdmin } from "../../../../../../auth/guard.ts";
import { effectiveConfig } from "../../../../../../db/appsettings.ts";
import { applyNodeConfig, decodeChannelPsk, type NodeWriteOp } from "../../../../../../node/writeconfig.ts";
import { readNodeConfig } from "../../../../../../node/readconfig.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const KINDS = new Set(["owner", "config", "moduleConfig", "channel", "channelSet"]);
// Every Config / ModuleConfig oneof arm is writable: the write is a read-modify-write on the section
// the node itself reported, and the field coercion comes from the protobuf schema, so an arm without
// a curated spec is no longer a special case. Validated against these lists so a typo is a 400
// rather than a confusing failure deep in the encoder.
const CONFIG_SECTIONS = new Set([
  "device", "position", "power", "network", "display", "lora", "bluetooth", "security", "sessionkey", "deviceUi",
]);
const MODULE_SECTIONS = new Set([
  "mqtt", "serial", "externalNotification", "storeForward", "rangeTest", "telemetry", "cannedMessage",
  "audio", "remoteHardware", "neighborInfo", "ambientLighting", "detectionSensor", "paxcounter",
  "statusmessage", "trafficManagement", "tak",
]);

// Write config changes to the directly-connected station node via AdminMessages. Admin only.
// This applies to that node locally and does not transmit over RF, so it is not gated by the TX
// arm state (like readNodeConfig). Re-reads the node afterward so the client can confirm.
export async function POST(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard instanceof NextResponse) return guard;
  const b = (await req.json().catch(() => ({}))) as { host?: string; port?: number; reboot?: boolean; ops?: unknown };
  const cfg = await effectiveConfig();
  const host = (b.host ?? cfg.node.host ?? "").trim();
  const port = Number.isFinite(b.port) && b.port ? Math.min(65535, Math.max(1, Math.floor(b.port!))) : cfg.node.port;
  if (!host) return NextResponse.json({ error: "no node host configured" }, { status: 400 });

  // A reboot-only request (reboot with no ops) is valid: it just sends the reboot AdminMessage.
  const hasOps = Array.isArray(b.ops) && b.ops.length > 0;
  if (!hasOps && !b.reboot) return NextResponse.json({ error: "no changes to write" }, { status: 400 });
  const rawOps = (hasOps ? b.ops : []) as Array<Record<string, unknown>>;
  for (const op of rawOps) {
    if (!op || !KINDS.has(String(op.kind ?? ""))) return NextResponse.json({ error: "unknown change kind" }, { status: 400 });
    if (op.kind === "config" && !CONFIG_SECTIONS.has(String(op.section))) return NextResponse.json({ error: `unsupported config section ${op.section}` }, { status: 400 });
    if (op.kind === "moduleConfig" && !MODULE_SECTIONS.has(String(op.section))) return NextResponse.json({ error: `unsupported module config section ${op.section}` }, { status: 400 });
  }

  // Channel writes replace the whole channel on the device, so everything the client did not send
  // (name, PSK, role, position precision) has to survive. applyNodeConfig now preserves it from the
  // node's own want_config dump on the same connection, so the channel op carries only the toggles:
  // the PSK never leaves the device, and this route no longer opens a second connection to read it
  // back (the firmware's TCP API accepts one client at a time, so each extra connection force-closes
  // the ingest RX socket).
  const ops: NodeWriteOp[] = [];
  for (const op of rawOps) {
    // channelSet creates or replaces a whole channel (name + PSK + role), like the app/CLI. The
    // channel name is capped at the firmware's 11-char limit and the PSK is validated up front so a
    // bad key is a 400 here rather than a confusing failure deep in the encoder.
    if (op.kind === "channelSet") {
      const idx = Number(op.index);
      if (!Number.isInteger(idx) || idx < 0 || idx > 7) return NextResponse.json({ error: `invalid channel index ${String(op.index)}` }, { status: 400 });
      const name = String(op.name ?? "").slice(0, 11);
      const role = ["PRIMARY", "SECONDARY", "DISABLED"].includes(String(op.role)) ? (String(op.role) as "PRIMARY" | "SECONDARY" | "DISABLED") : undefined;
      const psk = String(op.psk ?? "");
      try { decodeChannelPsk(psk); } catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 400 }); }
      ops.push({ kind: "channelSet", index: idx, name, psk, role, uplink_enabled: !!op.uplink_enabled, downlink_enabled: !!op.downlink_enabled });
      continue;
    }
    if (op.kind !== "channel") { ops.push(op as unknown as NodeWriteOp); continue; }
    const idx = Number(op.index);
    if (!Number.isInteger(idx) || idx < 0 || idx > 7) return NextResponse.json({ error: `invalid channel index ${String(op.index)}` }, { status: 400 });
    ops.push({ kind: "channel", index: idx, uplink_enabled: !!op.uplink_enabled, downlink_enabled: !!op.downlink_enabled });
  }

  try {
    await applyNodeConfig(host, port, ops, !!b.reboot);
    // Give a rebooting node a moment before re-reading; otherwise read straight back.
    if (b.reboot) await new Promise((r) => setTimeout(r, 4000));
    const snapshot = await readNodeConfig(host, port).catch(() => null);
    return NextResponse.json({ ok: true, snapshot });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
