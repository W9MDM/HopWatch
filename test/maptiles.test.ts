import { test } from "node:test";
import assert from "node:assert/strict";
import { configSchema } from "../src/config/schema.ts";

// The dark basemap is a configurable, pasteable URL, not a hardcoded constant. It became a setting
// when CARTO started requiring an API key on its raster tiles: an operator pastes a keyed URL
// (https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png?key=...) in /admin/settings.

// Minimal object that satisfies the required parts of the schema; the map settings under test all
// have defaults, so nothing here touches them.
const MINIMAL = { version: 1, ingest: { brokers: [{ id: "b", host: "h", topics: ["msh/#"] }] } } as const;

function parseWith(server?: Record<string, unknown>) {
  return configSchema.parse(server ? { ...MINIMAL, server } : MINIMAL);
}

function ui() {
  const cfg = parseWith();
  return { cfg, dark: cfg.server.ui.tile_provider_dark, light: cfg.server.ui.tile_provider };
}

test("the dark provider exists with a keyless CARTO default, so upgrades are unchanged", () => {
  const { dark } = ui();
  assert.equal(dark.url_template, "https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png");
  assert.ok(dark.attribution.includes("CARTO"));
});

test("light and dark are independent providers", () => {
  const { light, dark } = ui();
  assert.equal(light.url_template, "https://tile.openstreetmap.org/{z}/{x}/{y}.png");
  assert.notEqual(light.url_template, dark.url_template);
});

test("a pasted CARTO-keyed dark URL round-trips through the schema", () => {
  const keyed = "https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png?key=abc123";
  const cfg = parseWith({ ui: { tile_provider_dark: { url_template: keyed, attribution: "© CARTO" } } });
  assert.equal(cfg.server.ui.tile_provider_dark.url_template, keyed, "the ?key=... query string is preserved");
});

test("a dark URL missing the {z}/{x}/{y} placeholders is rejected", () => {
  assert.throws(
    () => parseWith({ ui: { tile_provider_dark: { url_template: "https://example.com/tiles.png" } } }),
    /z.*x.*y|placeholder/i,
  );
});
