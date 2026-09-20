import { test } from "node:test";
import assert from "node:assert/strict";
import { fromBinary } from "@bufbuild/protobuf";
import { buildChannelSetUrl } from "../src/meshtastic/channelurl.ts";

// The share URL must round-trip: the fragment is a base64url ChannelSet the app can decode back into
// the same channel name and PSK. A wrong encoding produces a link that silently adds nothing.
async function decodeFragment(url: string): Promise<any> {
  const m: any = await import("@meshtastic/protobufs");
  const frag = url.split("#")[1]!;
  const b64 = frag.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  return fromBinary(m.AppOnly.ChannelSetSchema, new Uint8Array(Buffer.from(padded, "base64")));
}

test("channel URL round-trips name and the basic PSK, in add mode by default", async () => {
  const url = await buildChannelSetUrl({ name: "Testing", psk: "AQ==" });
  assert.ok(url.startsWith("https://meshtastic.org/e/?add=true#"), `unexpected url: ${url}`);
  const set = await decodeFragment(url);
  assert.equal(set.settings.length, 1);
  assert.equal(set.settings[0].name, "Testing");
  assert.deepEqual(Array.from(set.settings[0].psk as Uint8Array), [1]); // AQ== -> [1] default key
  assert.ok(set.loraConfig, "lora config present");
});

test("replace mode omits the add query", async () => {
  const url = await buildChannelSetUrl({ name: "X", psk: "", add: false });
  assert.ok(url.startsWith("https://meshtastic.org/e/#"), `unexpected url: ${url}`);
  const set = await decodeFragment(url);
  assert.equal(set.settings[0].name, "X");
  assert.equal((set.settings[0].psk as Uint8Array).length, 0); // no key -> unencrypted
});
