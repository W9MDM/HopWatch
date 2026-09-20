"use client";

import { useEffect } from "react";

// When a page is loaded inside the kiosk rotator (URL carries ?embed=1), flag the document
// so globals.css hides the header/footer and the content fills the screen. No-op otherwise,
// so normal browsing is unaffected.
export function KioskChrome() {
  useEffect(() => {
    try {
      const embed = new URLSearchParams(window.location.search).get("embed") === "1";
      if (embed) document.documentElement.setAttribute("data-embed", "1");
      return () => document.documentElement.removeAttribute("data-embed");
    } catch {
      /* ignore */
    }
  }, []);
  return null;
}
