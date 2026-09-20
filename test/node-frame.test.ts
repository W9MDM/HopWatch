import { test } from "node:test";
import assert from "node:assert/strict";
import { fromBinary } from "@bufbuild/protobuf";
import { frame, parseFrames } from "../src/node/frame.ts";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { encodeToRadio } from "../src/meshtastic/encode.ts";

test("frame prepends the 0x94 0xc3 + big-endian length header", () => {
  const f = frame(new Uint8Array([1, 2, 3]));
  assert.deepEqual([...f], [0x94, 0xc3, 0x00, 0x03, 1, 2, 3]);
});

test("parseFrames extracts complete frames, keeps the partial remainder, resyncs past noise", () => {
  const a = frame(new Uint8Array([10, 20]));
  const b = frame(new Uint8Array([30]));
  const stream = new Uint8Array([0xff, ...a, ...b.slice(0, 3)]); // leading noise + a full frame + partial b
  const { frames, rest } = parseFrames(stream);
  assert.equal(frames.length, 1);
  assert.deepEqual([...frames[0]!], [10, 20]);
  assert.deepEqual([...rest], [...b.slice(0, 3)], "partial frame retained for the next chunk");
});

test("encodeToRadio round-trips: unframe -> ToRadio decode yields our MeshPacket", async () => {
  const { packetId, frame: f } = await encodeToRadio({
    kind: "text", fromNode: 0xaabbccdd, toNode: 0x0badf00d, channelIndex: 0, channelName: "LongFast",
    channelKey: "AQ==", text: "hi", hopLimit: 3, wantAck: true, topicRoot: "msh", packetId: 0x1234,
  });
  const { frames } = parseFrames(f);
  assert.equal(frames.length, 1);
  const m: any = await import("@meshtastic/protobufs");
  const toRadio: any = fromBinary(m.Mesh.ToRadioSchema, frames[0]!);
  assert.equal(toRadio.payloadVariant.case, "packet");
  assert.equal(Number(toRadio.payloadVariant.value.id) >>> 0, packetId);
  assert.equal(Number(toRadio.payloadVariant.value.from) >>> 0, 0xaabbccdd);
  assert.equal(Number(toRadio.payloadVariant.value.to) >>> 0, 0x0badf00d);
});

test("a stray magic pair with a bogus length does not stall the stream", () => {
  // A payload byte pair that happens to be 0x94 0xc3 is read as a frame header, and its u16 length
  // can claim up to 65535 bytes. Without the firmware's own length sanity check (StreamAPI.cpp:
  // `if (len > MAX_TO_FROM_RADIO_SIZE) rxPtr = 0`), the parser waits for a frame that never comes
  // and buffers, then discards, every real frame behind it.
  const good = frame(new Uint8Array([1, 2, 3, 4, 5]));
  const decoy = new Uint8Array([0x94, 0xc3, 0xff, 0xf0]); // claims 65520 bytes
  const stream = new Uint8Array(decoy.length + good.length);
  stream.set(decoy, 0);
  stream.set(good, decoy.length);

  const { frames, rest } = parseFrames(stream);
  assert.equal(frames.length, 1, "the real frame behind the decoy must still be parsed");
  assert.deepEqual([...frames[0]!], [1, 2, 3, 4, 5]);
  assert.equal(rest.length, 0, "nothing is left buffered waiting on the bogus length");
});

test("a frame at the largest plausible size still parses", () => {
  // The cap must not reject real traffic: meshtastic_FromRadio_size is 510.
  const payload = new Uint8Array(510).fill(7);
  const { frames, rest } = parseFrames(frame(payload));
  assert.equal(frames.length, 1);
  assert.equal(frames[0]!.length, 510);
  assert.equal(rest.length, 0);
});

// ---------------------------------------------------------------------------
// Static guard: a socket close is not a success.
//
// Every station-node operation is a promise settled by a `done()` helper, and each of the three had
// `socket.on("close", () => done())`, which RESOLVES. The station node closes the stream routinely:
// its API server keeps one client and force-closes the previous one, it drops a client silent for
// 15 minutes, and it closes on reboot. So a publish that never wrote a byte resolved and the outbox
// row was recorded as `sent` (a phantom transmit in the Rule 2 audit log); a config read resolved
// with a partial snapshot; a config write reported success having applied nothing.
//
// The fix is per-file (each has its own notion of "far enough to count"), so the guard is the shape:
// no unconditional resolve on close anywhere in the node/ingest transports.
// ---------------------------------------------------------------------------

test("no station-node transport treats a socket close as unconditional success", () => {
  const offenders: string[] = [];
  for (const dir of ["src/node", "src/ingest"]) {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".ts")) continue;
      const rel = `${dir}/${f}`;
      const src = readFileSync(join(dir, f), "utf8");
      // `done()` / `resolve()` with no argument, directly in a close handler.
      if (/\bon\(\s*["']close["']\s*,\s*\(\s*\)\s*=>\s*(done|resolve)\(\s*\)/.test(src)) {
        offenders.push(`${rel} resolves unconditionally on close`);
      }
    }
  }
  assert.deepEqual(offenders, [], offenders.join("\n"));
});
