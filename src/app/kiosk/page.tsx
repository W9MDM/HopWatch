import { moduleDenied } from "../../components/ModuleGate.tsx";
import { Kiosk } from "../../components/Kiosk.tsx";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function KioskPage() {
  const __denied = await moduleDenied("kiosk"); if (__denied) return __denied;
  return (
    <div className="space-y-4">
      <div>
        <h1 className="eyebrow">
          <span className="eyebrow-bar" />
          Kiosk
        </h1>
        <p className="mt-1 text-[13px] text-ink-faint">
          A rotating, full-screen display of your key views for a wall or NOC screen.
        </p>
      </div>
      <Kiosk />
    </div>
  );
}
