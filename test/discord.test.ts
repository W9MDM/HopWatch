import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDiscordPayload } from "../src/lib/discord.ts";

test("discord payload uses the configured identity", () => {
  const p = buildDiscordPayload({ title: "Gateway silent", body: "AQUA has gone quiet." }, { username: "HopWatch", avatar_url: "https://ex/logo.png" }) as any;
  assert.equal(p.username, "HopWatch");
  assert.equal(p.avatar_url, "https://ex/logo.png");
  assert.equal(p.embeds[0].title, "Gateway silent");
  assert.equal(p.embeds[0].description, "AQUA has gone quiet.");
  assert.equal(typeof p.embeds[0].color, "number");
});

test("per-message username overrides the default identity (send-as persona)", () => {
  const p = buildDiscordPayload({ title: "RWT", body: "test", username: "HopWatch Weather" }, { username: "HopWatch", avatar_url: "" }) as any;
  assert.equal(p.username, "HopWatch Weather");
});

test("avatar_url is omitted when not configured", () => {
  const p = buildDiscordPayload({ title: "t", body: "b" }, { username: "HopWatch", avatar_url: "" }) as any;
  assert.ok(!("avatar_url" in p));
});

test("falls back to HopWatch when no name is given anywhere", () => {
  const p = buildDiscordPayload({ title: "t", body: "b" }, { username: "", avatar_url: "" }) as any;
  assert.equal(p.username, "HopWatch");
});

test("title, description and username are clamped to Discord's caps", () => {
  const p = buildDiscordPayload(
    { title: "T".repeat(500), body: "B".repeat(5000), username: "U".repeat(200) },
    { username: "HopWatch", avatar_url: "" },
  ) as any;
  assert.equal(p.embeds[0].title.length, 256);
  assert.equal(p.embeds[0].description.length, 4096);
  assert.equal(p.username.length, 80);
});
