// Build a Meshtastic channel share URL (https://meshtastic.org/e/#...), the same link the app and
// device UI generate for a QR code. The fragment is a base64url-encoded AppOnly.ChannelSet protobuf
// (one or more ChannelSettings plus a LoRaConfig). Opening the link on a phone with Meshtastic adds
// the channel; `?add=true` appends it without replacing the primary, which is what a secondary
// channel (e.g. Testing) wants. This is the inverse of the channel bytes decode.ts reads.
//
// The PSK travels inside the URL by design: a channel link IS the key exchange. So only build share
// links for channels whose key is meant to be shared (a public/basic-key channel), never a private
// community key (Rule 6).
import { create, toBinary } from "@bufbuild/protobuf";

let pbMod: unknown = null;
async function pb(): Promise<any> {
  if (!pbMod) pbMod = await import("@meshtastic/protobufs");
  return pbMod;
}

export interface ChannelShare {
  name: string;
  /** base64 PSK: "" = unencrypted, "AQ==" = the default/basic key, else a 16/32 byte key. */
  psk: string;
  /** LoRa region enum name (e.g. "US"); defaults to US. Ignored by the importer in add mode. */
  region?: string;
  /** Modem preset enum name (e.g. "LONG_FAST"); defaults to LONG_FAST. */
  modemPreset?: string;
  /** Add mode appends the channel without replacing existing ones. Default true. */
  add?: boolean;
}

/** URL-safe base64 with padding stripped, as the meshtastic.org/e fragment uses. */
function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** base64 PSK -> raw key bytes ("AQ==" decodes to the 1-byte [1] default-key selector). */
function pskBytes(psk: string): Uint8Array {
  if (!psk) return new Uint8Array(0);
  return new Uint8Array(Buffer.from(psk, "base64"));
}

/** Map an enum NAME to its number, passing a number through; undefined when unknown. */
function enumVal(enumObj: any, name: string | undefined, dflt: number): number {
  if (name == null || name === "") return dflt;
  const n = enumObj?.[name];
  return typeof n === "number" ? n : dflt;
}

/**
 * Build the shareable channel URL for one channel. Async because it lazy-loads the protobuf lib
 * (kept out of the hot path, like encode.ts). Returns e.g.
 * https://meshtastic.org/e/?add=true#CgkSAQE... .
 */
export async function buildChannelSetUrl(ch: ChannelShare): Promise<string> {
  const m = await pb();
  const settings = create(m.Channel.ChannelSettingsSchema, { name: ch.name, psk: pskBytes(ch.psk) });
  const loraConfig = create(m.Config.Config_LoRaConfigSchema, {
    usePreset: true,
    region: enumVal(m.Config.Config_LoRaConfig_RegionCode, ch.region, enumVal(m.Config.Config_LoRaConfig_RegionCode, "US", 1)),
    modemPreset: enumVal(m.Config.Config_LoRaConfig_ModemPreset, ch.modemPreset, 0),
  });
  const set = create(m.AppOnly.ChannelSetSchema, { settings: [settings], loraConfig });
  const frag = toBase64Url(toBinary(m.AppOnly.ChannelSetSchema, set));
  const q = (ch.add ?? true) ? "?add=true" : "";
  return `https://meshtastic.org/e/${q}#${frag}`;
}
