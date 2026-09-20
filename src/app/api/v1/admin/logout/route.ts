import { NextResponse } from "next/server";
import { SESSION_COOKIE } from "../../../../../auth/session.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, "", { path: "/", maxAge: 0 });
  return res;
}
