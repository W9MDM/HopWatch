// Meshtastic serial/TCP stream framing. Each protobuf message (ToRadio out, FromRadio in)
// is prefixed with a 4-byte header: 0x94 0xc3 then a big-endian u16 length. Pure and
// testable; the transport (src/node/transport.ts) does the socket I/O.

const START1 = 0x94;
const START2 = 0xc3;

/**
 * Largest plausible framed payload. The firmware applies the same check in StreamAPI.cpp
 * (`if (len > MAX_TO_FROM_RADIO_SIZE) rxPtr = 0; // length is bogus, restart search for framing`),
 * where the bound is the generated `meshtastic_FromRadio_size` of 510, rounded up to 512.
 *
 * Without it, a stray 0x94 0xc3 pair inside a payload (RF bytes, a public key, a PSK) is read as a
 * frame header whose u16 length can claim up to 65535 bytes, and the parser then waits for bytes
 * that will never arrive as a single frame: every real frame behind it is buffered, never parsed,
 * and eventually discarded. On the ingest RX stream that is a silent stall of up to 64KB of
 * receptions per occurrence.
 */
const MAX_FRAME_LEN = 512;

/** Wrap a serialized protobuf payload in a stream frame. */
export function frame(payload: Uint8Array): Uint8Array {
  const len = payload.length;
  const out = new Uint8Array(4 + len);
  out[0] = START1;
  out[1] = START2;
  out[2] = (len >> 8) & 0xff;
  out[3] = len & 0xff;
  out.set(payload, 4);
  return out;
}

/**
 * Extract complete frames from a stream buffer, resynchronizing past any noise before the
 * magic bytes. Returns the decoded payloads and the unconsumed remainder (a partial frame)
 * to prepend to the next chunk.
 */
export function parseFrames(buf: Uint8Array): { frames: Uint8Array[]; rest: Uint8Array } {
  const frames: Uint8Array[] = [];
  let i = 0;
  while (i < buf.length) {
    if (buf[i] !== START1) { i++; continue; } // skip until a possible frame start
    if (i + 1 >= buf.length) break; // need the second magic byte
    if (buf[i + 1] !== START2) { i++; continue; }
    if (i + 4 > buf.length) break; // need the full 4-byte header
    const len = (buf[i + 2]! << 8) | buf[i + 3]!;
    if (len > MAX_FRAME_LEN) { i++; continue; } // bogus length: this was noise, resync past it
    if (i + 4 + len > buf.length) break; // full payload not arrived yet
    frames.push(buf.slice(i + 4, i + 4 + len));
    i += 4 + len;
  }
  return { frames, rest: buf.slice(i) };
}
