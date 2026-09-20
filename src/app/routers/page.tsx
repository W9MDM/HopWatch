import { redirect } from "next/navigation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// /routers merged into /power (Routers tab).
export default function RoutersRedirect() {
  redirect("/power?tab=routers");
}
