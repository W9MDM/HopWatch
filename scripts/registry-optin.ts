// Enable the opt-in instance registry announce from the installer, after the DB exists.
// Driven by env so it needs no npm arg forwarding:
//   REGISTRY_ANNOUNCE=1 [REGISTRY_PUBLIC_URL=https://...] tsx scripts/registry-optin.ts
// Writes a config override (Rule 1), so it is picked up by hot-reload and editable later in
// /admin/settings -> Registry. Does nothing unless REGISTRY_ANNOUNCE=1.
import { saveOverrides } from "../src/db/appsettings.ts";
import { closePool } from "../src/db/client.ts";

async function main(): Promise<void> {
  if (process.env.REGISTRY_ANNOUNCE !== "1") return;
  const publicUrl = (process.env.REGISTRY_PUBLIC_URL ?? "").trim();
  const announce: Record<string, unknown> = { enabled: true };
  if (publicUrl) announce.public_url = publicUrl;
  await saveOverrides({ registry: { announce } });
  console.log(`registry announce enabled${publicUrl ? ` (public_url=${publicUrl})` : ""}`);
}

main()
  .catch((e) => { console.error(`registry opt-in failed: ${(e as Error).message}`); process.exitCode = 1; })
  .finally(() => closePool());
