import { NextResponse, type NextRequest } from "next/server";
import { versionInfo } from "../../../../lib/version.ts";
import { requireModule } from "../../../../auth/rbac.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Hand-maintained OpenAPI 3.1 description of the read-only API surface (fixes Malla #62).
export async function GET(req: NextRequest) {
  const denied = await requireModule(req, "api");
  if (denied) return denied;
  const v = versionInfo();
  const listParams = [
    { name: "limit", in: "query", schema: { type: "integer" } },
    { name: "format", in: "query", schema: { type: "string", enum: ["json", "csv"] } },
  ];
  const ok = { description: "OK" };
  const doc = {
    openapi: "3.1.0",
    info: { title: "HopWatch API", version: v.version, description: "Meshtastic observatory API. Partial spec: a representative subset of endpoints, including some admin writes." },
    servers: [{ url: "/api/v1" }],
    components: {
      securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
    },
    security: [{ bearer: [] }],
    paths: {
      "/packets": {
        get: {
          summary: "List packets",
          parameters: [
            { name: "from", in: "query", schema: { type: "string" } },
            { name: "port", in: "query", schema: { type: "integer" } },
            { name: "status", in: "query", schema: { type: "string", enum: ["decoded", "encrypted", "malformed"] } },
            ...listParams,
          ],
          responses: { 200: ok },
        },
      },
      "/nodes": { get: { summary: "List nodes", parameters: [{ name: "q", in: "query", schema: { type: "string" } }, ...listParams], responses: { 200: ok } } },
      "/nodes/{id}": { get: { summary: "Node detail + biography", parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }], responses: { 200: ok, 404: { description: "Unknown node" } } } },
      "/nodes/{id}/telemetry": { get: { summary: "Node telemetry series", parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }, { name: "metric", in: "query", schema: { type: "string" } }, { name: "hours", in: "query", schema: { type: "integer" } }], responses: { 200: ok } } },
      "/gateways/{id}/heard-direct": { get: { summary: "Per-gateway direct-heard roster", parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }, ...listParams], responses: { 200: ok } } },
      "/matrix": { get: { summary: "Gateway x node matrix", parameters: [{ name: "nodes", in: "query", schema: { type: "integer" } }], responses: { 200: ok } } },
      "/map": { get: { summary: "Map nodes + RF links", responses: { 200: ok } } },
      "/traceroutes": { get: { summary: "Recent traceroutes", parameters: listParams, responses: { 200: ok } } },
      "/analytics": { get: { summary: "Gateway compare, longest links, hop distribution", responses: { 200: ok } } },
      "/links/{gateway}/{node}": { get: { summary: "Per-pair RSSI/SNR history", parameters: [{ name: "gateway", in: "path", required: true, schema: { type: "integer" } }, { name: "node", in: "path", required: true, schema: { type: "integer" } }], responses: { 200: ok } } },
      "/health": { get: { summary: "Broker + ingest health", responses: { 200: ok } } },
      "/live/stream": { get: { summary: "SSE live reception feed", responses: { 200: { description: "text/event-stream" } } } },
      "/admin/mute-list": {
        get: { summary: "List muted nodes (admin)", responses: { 200: ok, 401: { description: "admin required" } } },
        post: { summary: "Mute a node (admin)", responses: { 200: ok, 401: { description: "admin required" } } },
        delete: { summary: "Unmute a node (admin)", responses: { 200: ok, 401: { description: "admin required" } } },
      },
    },
  };
  return NextResponse.json(doc);
}
