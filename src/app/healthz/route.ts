export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Liveness: the web process is up. No dependencies checked.
export function GET() {
  return new Response("ok", { headers: { "content-type": "text/plain" } });
}
