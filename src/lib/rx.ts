// Reception-class + role display metadata. Colors map to theme tokens so the
// map, graph, and tables stay consistent (spec §: role colors everywhere).

export interface ClassMeta {
  label: string;
  text: string; // tailwind text color utility from a --color-rx-* token
  dot: string; // tailwind bg utility for a status dot
}

const RX: Record<string, ClassMeta> = {
  rf_direct: { label: "direct", text: "text-rx-direct", dot: "bg-rx-direct" },
  rf_direct_low_conf: { label: "direct?", text: "text-rx-lowconf", dot: "bg-rx-lowconf" },
  rf_relayed: { label: "relayed", text: "text-rx-relayed", dot: "bg-rx-relayed" },
  mqtt_self: { label: "self-gated", text: "text-rx-mqtt", dot: "bg-rx-mqtt" },
  mqtt_injected: { label: "mqtt", text: "text-rx-mqtt", dot: "bg-rx-mqtt" },
  unknown: { label: "unknown", text: "text-ink-faint", dot: "bg-rx-never" },
};

export function receptionClassMeta(cls: string): ClassMeta {
  return RX[cls] ?? RX["unknown"]!;
}

const ROLE: Record<string, string> = {
  CLIENT: "text-role-client",
  CLIENT_MUTE: "text-role-client-mute",
  ROUTER: "text-role-router",
  ROUTER_CLIENT: "text-role-router-client",
  REPEATER: "text-role-repeater",
};

export function roleColor(role: string | null | undefined): string {
  if (!role) return "text-ink-faint";
  return ROLE[role.toUpperCase()] ?? "text-ink-mute";
}
