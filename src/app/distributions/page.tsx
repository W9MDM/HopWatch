import { redirect } from "next/navigation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// /distributions merged into /analytics (Distributions tab).
export default function DistributionsRedirect() {
  redirect("/analytics?tab=distributions");
}
