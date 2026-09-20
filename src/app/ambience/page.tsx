import { moduleDenied } from "../../components/ModuleGate.tsx";
import { Ambience } from "../../components/Ambience.tsx";

export const dynamic = "force-dynamic";

export default async function AmbiencePage() {
  const __denied = await moduleDenied("ambience"); if (__denied) return __denied;
  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <h1 className="eyebrow">
        <span className="eyebrow-bar" />
        Audio ambience
      </h1>
      <Ambience />
    </div>
  );
}
