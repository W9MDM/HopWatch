import { test } from "node:test";
import assert from "node:assert/strict";
import { severityRank, alertMatches, isRequiredTest, fillAlert, type AlertLike, alertAreas, matchedZoneAreas } from "../src/lib/wxalerts.ts";

const base: AlertLike = { id: "1", event: "Severe Thunderstorm Warning", severity: "Severe", areaDesc: "Lake, IN" };

test("severityRank orders NWS severities", () => {
  assert.ok(severityRank("Extreme") > severityRank("Severe"));
  assert.ok(severityRank("Severe") > severityRank("Moderate"));
  assert.equal(severityRank(undefined), 0);
});

test("alertMatches respects the severity threshold", () => {
  assert.equal(alertMatches(base, "Severe", []), true);
  assert.equal(alertMatches(base, "Extreme", []), false, "Severe is below an Extreme threshold");
  assert.equal(alertMatches({ ...base, severity: "Extreme" }, "Severe", []), true);
});

test("alertMatches respects the event allow-list (case-insensitive), empty = any", () => {
  assert.equal(alertMatches(base, "Severe", ["Tornado Warning"]), false, "not in allow-list");
  assert.equal(alertMatches(base, "Severe", ["severe thunderstorm warning"]), true);
  assert.equal(alertMatches(base, "Severe", []), true, "empty allow-list = any event");
});

test("isRequiredTest gates each EAS test event on its own toggle", () => {
  const rwt: AlertLike = { id: "t1", event: "Required Weekly Test", severity: "Unknown", status: "Test" };
  const rmt: AlertLike = { id: "t2", event: "required monthly test", severity: "Minor", status: "Test" };
  assert.equal(isRequiredTest(rwt, true, false), true);
  assert.equal(isRequiredTest(rwt, false, true), false, "weekly test needs the weekly toggle");
  assert.equal(isRequiredTest(rmt, false, true), true, "event match is case-insensitive");
  assert.equal(isRequiredTest(rmt, true, false), false, "monthly test needs the monthly toggle");
  assert.equal(isRequiredTest(base, true, true), false, "a real alert is never a test event");
});

test("test events cannot pass the normal severity filter (why the toggles exist)", () => {
  const rwt: AlertLike = { id: "t1", event: "Required Weekly Test", severity: "Unknown", status: "Test" };
  assert.equal(alertMatches(rwt, "Severe", []), false);
});

test("fillAlert substitutes vars and leaves unknown tokens", () => {
  const out = fillAlert("WX {event} ({severity}) {area} {nope}", base, "UTC");
  assert.equal(out, "WX Severe Thunderstorm Warning (Severe) Lake, IN {nope}");
});

// ---------------------------------------------------------------------------
// Zone-scoped areas.
//
// An NWS query for `zone=A,B` returns any alert affecting A or B, but the alert covers whatever it
// covers. A Storm Prediction Center watch that clips one Indiana county also names sixteen Illinois
// ones, and broadcasting the whole list spends the mesh's 220-character budget on places nobody at
// the station cares about, truncating away the expiry time.
//
// geocode.UGC is positionally aligned with the semicolon-separated areaDesc entries: verified
// against 120 live alerts, where the counts matched in all 120.
// ---------------------------------------------------------------------------

// The real shape of the watch in the operator's broadcast log: two Indiana counties among sixteen
// Illinois ones.
const WATCH: AlertLike = {
  id: "urn:oid:test.watch", event: "Severe Thunderstorm Watch", severity: "Severe", status: "Actual",
  areaDesc: "Cook, IL; De Kalb, IL; DuPage, IL; Ford, IL; Grundy, IL; Iroquois, IL; Kane, IL; Kankakee, IL; Kendall, IL; La Salle, IL; Lee, IL; Livingston, IL; Ogle, IL; Will, IL; Lake, IN; Newton, IN",
  ugc: ["ILC031", "ILC037", "ILC043", "ILC053", "ILC063", "ILC075", "ILC089", "ILC091", "ILC093", "ILC099", "ILC103", "ILC105", "ILC141", "ILC197", "INC089", "INC111"],
  expires: "2026-08-22T06:00:00Z",
};

test("alertAreas pairs each UGC code with its areaDesc entry", () => {
  const areas = alertAreas(WATCH);
  assert.equal(areas.length, 16);
  assert.deepEqual(areas[0], { ugc: "ILC031", name: "Cook, IL" });
  assert.deepEqual(areas[14], { ugc: "INC089", name: "Lake, IN" });
  assert.deepEqual(areas[15], { ugc: "INC111", name: "Newton, IN" });
});

test("alertAreas refuses to pair mismatched lists rather than pairing them wrongly", () => {
  // A mispaired name would put a neighbouring county's name on someone else's warning, which is
  // worse than falling back to the full area string.
  assert.deepEqual(alertAreas({ ...WATCH, ugc: ["ILC031", "INC089"] }), []);
  assert.deepEqual(alertAreas({ ...WATCH, ugc: [] }), []);
  assert.deepEqual(alertAreas({ ...WATCH, areaDesc: undefined }), []);
});

test("matchedZoneAreas keeps only the configured zones, in alert order", () => {
  const matched = matchedZoneAreas(WATCH, ["INC089", "INC111", "INC127"]);
  assert.deepEqual(matched.map((x) => x.name), ["Lake, IN", "Newton, IN"]);
  assert.deepEqual(matched.map((x) => x.ugc), ["INC089", "INC111"]);
});

test("matching is by UGC code, never by county name", () => {
  // There is a Lake county in both Illinois and Indiana. Matching on the name would pull in the
  // wrong state's, and the areaDesc format is no help: a single-state alert omits the state suffix
  // that a multi-state one includes.
  const matched = matchedZoneAreas(WATCH, ["ILC031"]);
  assert.deepEqual(matched.map((x) => x.name), ["Cook, IL"]);
  assert.equal(matchedZoneAreas(WATCH, ["ILC097"]).length, 0, "Lake, IL is not in this watch");
});

test("an alert covering none of the configured zones matches nothing", () => {
  // The self-diagnosing case from the operator's log: a Severe Thunderstorm Warning for Dubois, IN,
  // hundreds of km from a northwest-Indiana mesh.
  const dubois: AlertLike = {
    id: "urn:oid:test.dubois", event: "Severe Thunderstorm Warning", severity: "Severe", status: "Actual",
    areaDesc: "Dubois, IN", ugc: ["INC037"],
  };
  assert.equal(matchedZoneAreas(dubois, ["INC089", "INC111", "INC127"]).length, 0);
  // ...and it matches when the operator's own list contains the code that admitted it, which is what
  // the recorded matched_zones column surfaces.
  assert.deepEqual(matchedZoneAreas(dubois, ["INC037", "INC089"]).map((x) => x.ugc), ["INC037"]);
});

test("zone codes are matched case- and whitespace-insensitively", () => {
  assert.equal(matchedZoneAreas(WATCH, [" inc089 ", "", "INC111"]).length, 2);
  assert.equal(matchedZoneAreas(WATCH, []).length, 0, "no configured zones matches nothing");
});

test("the trimmed area is what reaches the mesh, and it fits", () => {
  const tpl = "WX {event} ({severity}) {area} until {expires}";
  const full = fillAlert(tpl, WATCH, "UTC");
  const trimmed = fillAlert(tpl, WATCH, "UTC", matchedZoneAreas(WATCH, ["INC089", "INC111"]).map((x) => x.name).join(", "));

  // The whole point: the full list is truncated at the 220-char cap before it reaches the expiry,
  // so the operator is told about sixteen counties and not when it ends.
  assert.equal(full.length, 220, "full area list hits the cap");
  assert.ok(!full.includes("until"), "the expiry is truncated away");
  assert.ok(trimmed.includes("Lake, IN, Newton, IN"));
  assert.ok(trimmed.includes("until"), "the trimmed message still carries the expiry");
  assert.ok(!trimmed.includes("Cook"), "no counties outside the configured zones");
  assert.ok(trimmed.length < full.length);
});

test("{area_all} still gives the full list even when {area} is trimmed", () => {
  const out = fillAlert("{area} | ALL:{area_all}", WATCH, "UTC", "Lake, IN");
  assert.ok(out.startsWith("Lake, IN | ALL:Cook, IL;"));
});
