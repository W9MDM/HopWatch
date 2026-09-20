"use client";

import Script from "next/script";
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";

// Google Analytics (GA4) client tag. Rendered by the root layout only when analytics is
// enabled with a measurement id and client tracking on. Loads gtag.js and sends a page_view
// on each client-side (SPA) navigation; the initial page_view comes from gtag config, so the
// first pathname change is skipped to avoid double-counting.
export function Analytics({ measurementId }: { measurementId: string }) {
  const pathname = usePathname();
  const first = useRef(true);

  useEffect(() => {
    if (first.current) { first.current = false; return; }
    const w = window as unknown as { gtag?: (...a: unknown[]) => void };
    if (typeof w.gtag === "function") w.gtag("event", "page_view", { page_path: pathname });
  }, [pathname]);

  // Guard the id charset defensively even though the admin route already sanitizes it.
  if (!measurementId || !/^[A-Za-z0-9_-]+$/.test(measurementId)) return null;

  return (
    <>
      <Script src={`https://www.googletagmanager.com/gtag/js?id=${measurementId}`} strategy="afterInteractive" />
      <Script id="ga-init" strategy="afterInteractive">
        {`window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)}gtag('js',new Date());gtag('config','${measurementId}');`}
      </Script>
    </>
  );
}
