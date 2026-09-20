import { parseNodeId } from "./types.ts";

// Meshtastic MQTT topics look like:
//   msh/<REGION>/2/e/<CHANNEL>/<GATEWAY>      (protobuf ServiceEnvelope)
//   msh/<REGION>/2/map/                         (MapReport)
//   msh/<REGION>/2/json/<CHANNEL>/<GATEWAY>    (JSON)
// The gateway id is the final segment ("!aabbccdd"); the channel is second-to-last.

export interface TopicInfo {
  isJson: boolean;
  isMap: boolean;
  channelId: string | null;
  gatewayIdFromTopic: number | null;
  root: string;
}

/** A broker's Meshtastic topic root (the prefix before `/2/...`) used by the MQTT bridge to
 * republish forwarded messages onto that broker's namespace. Prefers the admin-configured
 * `rootTopic`; otherwise derives it from the first subscribe topic. Returns the root plus how it
 * was determined, so the UI can show whether it is explicit or a fallback. Shared by the ingest
 * connector (BrokerConnector.topicRoot) and the bridge admin page so they never drift. */
export function effectiveTopicRoot(rootTopic: string | null | undefined, topics: string[]): { root: string; source: "explicit" | "derived" | "none" } {
  const explicit = (rootTopic ?? "").trim().replace(/\/+$/, "");
  if (explicit) return { root: explicit, source: "explicit" };
  const t = topics[0] ?? "";
  const i = t.indexOf("/2/");
  const root = (i >= 0 ? t.slice(0, i) : t.replace(/\/?[#+]$/, "")).replace(/\/+$/, "");
  return root ? { root, source: "derived" } : { root: "", source: "none" };
}

export function parseTopic(topic: string): TopicInfo {
  const parts = topic.split("/").filter(Boolean);
  const markerIdx = parts.findIndex((p) => p === "e" || p === "json" || p === "map" || p === "c");
  const isJson = parts.includes("json");
  const isMap = parts.includes("map");

  let channelId: string | null = null;
  let gatewayIdFromTopic: number | null = null;

  if (markerIdx >= 0 && parts.length > markerIdx + 1) {
    const tail = parts.slice(markerIdx + 1);
    if (tail.length >= 2) {
      channelId = tail[0]!;
      gatewayIdFromTopic = parseNodeId(tail[tail.length - 1]!);
    } else if (tail.length === 1) {
      // Only a gateway or only a channel present.
      const last = tail[0]!;
      if (last.startsWith("!")) gatewayIdFromTopic = parseNodeId(last);
      else channelId = last;
    }
  }

  // The root is everything before the "/2/" version segment, matching effectiveTopicRoot and the
  // firmware's own `<root>/2/e/...` construction. Taking a fixed three segments was wrong for
  // both the default root ("msh/2/e" instead of "msh") and longer community roots
  // ("msh/US/IN" instead of "msh/US/IN/NWI").
  const vi = topic.indexOf("/2/");
  const root = (vi >= 0 ? topic.slice(0, vi) : "").replace(/^\/+|\/+$/g, "");
  return { isJson, isMap, channelId, gatewayIdFromTopic, root };
}
