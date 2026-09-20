// PortNum id -> human name, complete as of the current meshtastic/portnums.proto. Used for the
// packet browser and payload previews; unknown ports render as hex (spec §9), and the table is also
// evidence in decode.ts's fallback acceptance test, so a MISSING port makes a legitimate
// empty-payload request from that port harder to accept.
//
// Transcribed from the raw .proto, not from a summary of it: a summary consulted during the audit
// claimed the highest value was 79 and silently omitted GROUPALARM_APP = 112 along with nine others.
export const PORT_NAMES: Record<number, string> = {
  0: "UNKNOWN_APP",
  1: "TEXT_MESSAGE_APP",
  2: "REMOTE_HARDWARE_APP",
  3: "POSITION_APP",
  4: "NODEINFO_APP",
  5: "ROUTING_APP",
  6: "ADMIN_APP",
  7: "TEXT_MESSAGE_COMPRESSED_APP",
  8: "WAYPOINT_APP",
  9: "AUDIO_APP",
  10: "DETECTION_SENSOR_APP",
  11: "ALERT_APP",
  12: "KEY_VERIFICATION_APP",
  13: "REMOTE_SHELL_APP",
  32: "REPLY_APP",
  33: "IP_TUNNEL_APP",
  34: "PAXCOUNTER_APP",
  35: "STORE_FORWARD_PLUSPLUS_APP",
  36: "NODE_STATUS_APP",
  37: "MESH_BEACON_APP",
  64: "SERIAL_APP",
  65: "STORE_FORWARD_APP",
  66: "RANGE_TEST_APP",
  67: "TELEMETRY_APP",
  68: "ZPS_APP",
  69: "SIMULATOR_APP",
  70: "TRACEROUTE_APP",
  71: "NEIGHBORINFO_APP",
  72: "ATAK_PLUGIN",
  73: "MAP_REPORT_APP",
  74: "POWERSTRESS_APP",
  75: "LORAWAN_BRIDGE",
  76: "RETICULUM_TUNNEL_APP",
  77: "CAYENNE_APP",
  78: "ATAK_PLUGIN_V2",
  79: "LORA_OTA_APP",
  112: "GROUPALARM_APP",
  256: "PRIVATE_APP",
  257: "ATAK_FORWARDER",
};

export function portName(port: number | null | undefined): string {
  if (port === null || port === undefined) return "-";
  return PORT_NAMES[port] ?? `PORT_${port}`;
}
