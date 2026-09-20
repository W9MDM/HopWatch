import { NextResponse } from "next/server";
import { versionInfo } from "../../../lib/version.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Version + git commit (fixes Malla #49).
export function GET() {
  return NextResponse.json(versionInfo());
}
