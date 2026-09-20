import { redirect } from "next/navigation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// /stats merged into /analytics (Traffic tab).
export default function StatsRedirect() {
  redirect("/analytics?tab=traffic");
}
