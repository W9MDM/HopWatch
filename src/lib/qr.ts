import QRCode from "qrcode";

// Server-side QR rendering to an inline SVG string (no canvas, no browser). Used to show a scannable
// "add this channel" code next to its meshtastic.org/e link. Kept tiny and dependency-isolated here.
export async function qrSvg(text: string, opts?: { margin?: number }): Promise<string> {
  return QRCode.toString(text, { type: "svg", margin: opts?.margin ?? 1, errorCorrectionLevel: "M" });
}
