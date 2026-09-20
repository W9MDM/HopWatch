// Reception classification: the core of HopWatch's "receptions, not packets" model.
//
// This module is intentionally DEPENDENCY-FREE and operates on a normalized plain
// object (not protobuf types) so it is trivially unit-testable and reusable by both
// the ingest daemon and the re-decode job. See spec §4.
//
// Broadcast address constant (MeshPacket.to for a broadcast) is 0xFFFFFFFF.

export const RECEPTION_CLASSES = [
  "rf_direct",
  "rf_direct_low_conf",
  "rf_relayed",
  "mqtt_self",
  "mqtt_injected",
  "unknown",
] as const;

export type ReceptionClass = (typeof RECEPTION_CLASSES)[number];

/**
 * Normalized header fields extracted from a decoded ServiceEnvelope + MeshPacket.
 * `null` means the field was ABSENT (not present in the wire data), which is
 * semantically distinct from a present zero.
 */
export interface ReceptionFacts {
  /** ServiceEnvelope.gateway_id, normalized to a uint32 node number. */
  gatewayId: number;
  /** MeshPacket.from (uint32 node number). */
  fromNodeId: number;
  /** MeshPacket.rx_rssi in dBm, or null if absent. A present 0 is kept (suspect). */
  rxRssi: number | null;
  /** MeshPacket.rx_snr in dB, or null if absent. */
  rxSnr: number | null;
  /** MeshPacket.hop_start, or null on firmware that predates the field. */
  hopStart: number | null;
  /** MeshPacket.hop_limit, or null if absent. */
  hopLimit: number | null;
  /** MeshPacket.relay_node (last byte of the relayer's node id), or null if absent. 0 = none. */
  relayNode: number | null;
}

export interface Classification {
  class: ReceptionClass;
  /** Number of hops the packet traversed, when computable (hop_start - hop_limit). */
  hopsUsed: number | null;
  /** True only for rf_direct, the sole class that feeds the confirmed direct-heard roster. */
  isConfirmedDirect: boolean;
  /** True if RF metadata (rssi or snr) was present on this reception. */
  hasRfMetadata: boolean;
  /** Human-readable reason, useful for the packet-detail view and debugging. */
  reason: string;
}

function hasRf(f: ReceptionFacts): boolean {
  return f.rxRssi !== null || f.rxSnr !== null;
}

/**
 * Classify a single gateway reception. Pure function of the header facts.
 *
 * Decision tree (spec §4):
 *   gateway_id == from                    -> mqtt_self       (node uplinked its OWN traffic)
 *   no rx_rssi AND no rx_snr              -> mqtt_injected   (no RF metadata at all)
 *   hop_start & hop_limit present:
 *       hops_used == 0                    -> rf_direct
 *       hops_used  > 0                    -> rf_relayed
 *       hops_used  < 0                    -> unknown         (inconsistent header)
 *   hop_start absent, RF present:
 *       relay_node present & != 0         -> rf_relayed      (relay byte proves a relay)
 *       otherwise                         -> rf_direct_low_conf
 */
export function classifyReception(f: ReceptionFacts): Classification {
  const hasRfMetadata = hasRf(f);

  // 1. Self-gated: node uploaded its own packet via its own MQTT link.
  //    NOT evidence that any gateway heard it over RF.
  if (f.gatewayId === f.fromNodeId) {
    return {
      class: "mqtt_self",
      hopsUsed: null,
      isConfirmedDirect: false,
      hasRfMetadata,
      reason: "gateway_id == from: node uplinked its own traffic (MQTT-attached, not RF-heard)",
    };
  }

  // 2. No RF metadata at all -> arrived over MQTT, not an RF reception.
  if (!hasRfMetadata) {
    return {
      class: "mqtt_injected",
      hopsUsed: null,
      isConfirmedDirect: false,
      hasRfMetadata,
      reason: "no rx_rssi and no rx_snr: MQTT-injected, no RF observation",
    };
  }

  // 3. Hop metadata present -> authoritative hop count.
  if (f.hopStart !== null && f.hopLimit !== null) {
    const hopsUsed = f.hopStart - f.hopLimit;
    if (hopsUsed === 0) {
      return {
        class: "rf_direct",
        hopsUsed,
        isConfirmedDirect: true,
        hasRfMetadata,
        reason: "hop_start == hop_limit with RF metadata: zero hops, direct",
      };
    }
    if (hopsUsed > 0) {
      return {
        class: "rf_relayed",
        hopsUsed,
        isConfirmedDirect: false,
        hasRfMetadata,
        reason: `hops_used=${hopsUsed} (>0): relayed`,
      };
    }
    // hop_limit > hop_start is impossible in well-formed data.
    return {
      class: "unknown",
      hopsUsed,
      isConfirmedDirect: false,
      hasRfMetadata,
      reason: `hops_used=${hopsUsed} (<0): inconsistent hop header`,
    };
  }

  // 4. hop_start absent (old firmware) but RF metadata present.
  if (f.relayNode !== null && f.relayNode !== 0) {
    return {
      class: "rf_relayed",
      hopsUsed: null,
      isConfirmedDirect: false,
      hasRfMetadata,
      reason: "hop_start absent but relay_node != 0: relayed",
    };
  }
  return {
    class: "rf_direct_low_conf",
    hopsUsed: null,
    isConfirmedDirect: false,
    hasRfMetadata,
    reason: "hop_start absent, RF metadata present, no relay byte: tentative direct (low confidence)",
  };
}

/** True when this reception should feed the confirmed per-gateway direct-heard roster. */
export function feedsDirectRoster(c: Classification): boolean {
  return c.class === "rf_direct";
}

/** True when the reception represents an RF observation (direct, low-conf, or relayed). */
export function isRfReception(c: Classification): boolean {
  return c.class === "rf_direct" || c.class === "rf_direct_low_conf" || c.class === "rf_relayed";
}
