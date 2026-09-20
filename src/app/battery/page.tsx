import { redirect } from "next/navigation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type SP = Record<string, string | string[] | undefined>;

// /battery merged into /power (Low battery tab). Redirect preserves any threshold bookmark.
export default async function BatteryRedirect({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const t = Array.isArray(sp.threshold) ? sp.threshold[0] : sp.threshold;
  redirect(t ? `/power?threshold=${encodeURIComponent(t)}` : "/power");
}
