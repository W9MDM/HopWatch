import { query } from "../../db/client.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Readiness: the web process can reach the database.
export async function GET() {
  try {
    await query("SELECT 1");
    return new Response("ready", { headers: { "content-type": "text/plain" } });
  } catch (e) {
    console.error(`[readyz] ${(e as Error).message}`);
    return new Response("not ready", { status: 503, headers: { "content-type": "text/plain" } });
  }
}
