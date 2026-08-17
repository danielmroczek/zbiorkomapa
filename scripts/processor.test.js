/**
 * processor.test.js — vitest suite for the GTFS processor output.
 *
 * Validates the structure and correctness of per-route JSON files generated
 * by scripts/processor.js. Tests cover:
 *   - direction grouping (direction_id vs first→last stop pair)
 *   - route merging by short_name (Gorzów pattern)
 *   - per-direction color overrides
 *   - loop route detection (is_loop flag)
 *   - OSRM shape fallback (Świnoujście)
 *   - on-demand stop detection
 *   - audio_id presence (recordings cities)
 *   - representative trip selection (no extended-course stops)
 *
 * Run: npx vitest run scripts/processor.test.js
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const dist = path.join(projectRoot, "public", "dist");

function loadRoute(routeId, city = "poznan") {
  const filePath = path.join(dist, city, `${routeId}.json`);
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Find a direction whose last stop name contains the given substring. */
function findDirByLastStop(route, substring) {
  return route.directions.find(
    (d) => d.stops[d.stops.length - 1]?.stop_name.includes(substring),
  );
}

/** Find a direction whose first stop name contains the given substring. */
function findDirByFirstStop(route, substring) {
  return route.directions.find((d) => d.stops[0]?.stop_name.includes(substring));
}

/** Count on-demand stops in a direction. */
function onDemandCount(direction) {
  return direction.stops.filter((s) => s.is_on_demand).length;
}

/** Count null audio_id stops in a direction. */
function nullAudioCount(direction) {
  return direction.stops.filter((s) => s.audio_id === null).length;
}

/** Unique zone_ids in a direction (non-empty). */
function directionZones(direction) {
  return [...new Set(direction.stops.map((s) => s.zone_id).filter(Boolean))];
}

// ===========================================================================
// Poznań — direction_id grouping (canonical GTFS field)
// ===========================================================================

describe("Poznań/425 — standard bus (direction_id grouping)", () => {
  const r = loadRoute("425");

  it("has 2–3 directions (tolerates variant additions)", () => {
    expect(r.directions.length).toBeGreaterThanOrEqual(2);
    expect(r.directions.length).toBeLessThanOrEqual(3);
  });

  it("has type BUS", () => {
    expect(r.type).toBe("BUS");
  });

  it("directions are roughly symmetric (±2 stops)", () => {
    const [a, b] = r.directions;
    expect(Math.abs(a.stop_count - b.stop_count)).toBeLessThanOrEqual(2);
  });

  it("each direction has shape coordinates", () => {
    for (const d of r.directions) {
      expect(d.shape.coordinates.length).toBeGreaterThan(0);
    }
  });

  it("first/last stop names are distinct (non-loop)", () => {
    for (const d of r.directions) {
      expect(d.is_loop).toBe(false);
      expect(d.stops[0].stop_name).not.toBe(d.stops[d.stops.length - 1].stop_name);
    }
  });

  it("has on-demand stops", () => {
    const total = r.directions.reduce((sum, d) => sum + onDemandCount(d), 0);
    expect(total).toBeGreaterThan(0);
  });

  it("has audio_id on all stops (recordings city)", () => {
    for (const d of r.directions) {
      expect(nullAudioCount(d)).toBe(0);
    }
  });

  it("crosses multiple zones", () => {
    const zones = new Set(r.directions.flatMap(directionZones));
    expect(zones.size).toBeGreaterThanOrEqual(2);
  });
});

// ===========================================================================
// Poznań/701 — extended-course regression guard
// ===========================================================================

describe("Poznań/701 — no extended-course stops (representative trip)", () => {
  const r = loadRoute("701");

  it("has 2–3 directions (tolerates variant additions)", () => {
    expect(r.directions.length).toBeGreaterThanOrEqual(2);
    expect(r.directions.length).toBeLessThanOrEqual(3);
  });

  it("contains NO extended-course stops (Poetów/Kompozytorów)", () => {
    for (const d of r.directions) {
      const hasExtended = d.stops.some(
        (s) => /Poetów|Kompozytorów/.test(s.stop_name),
      );
      expect(hasExtended).toBe(false);
    }
  });

  it("each direction ends at its declared terminus", () => {
    for (const d of r.directions) {
      const last = d.stops[d.stops.length - 1].stop_name;
      const nameTail = d.direction_name.trim().split(" - ").pop().toLowerCase();
      if (nameTail.includes("jeziorna")) {
        expect(last).toBe("Komorniki/Jeziorna");
      } else if (nameTail.includes("górczyn")) {
        expect(last).toBe("Górczyn PKM");
      }
    }
  });

  it("direction names are distinct", () => {
    const names = r.directions.map((d) => d.direction_name);
    expect(new Set(names).size).toBe(2);
  });
});

// ===========================================================================
// Poznań/0 — tram with custom color, single direction
// ===========================================================================

describe("Poznań/0 — tram, single direction, custom color", () => {
  const r = loadRoute("0");

  it("has type TRAM", () => {
    expect(r.type).toBe("TRAM");
  });

  it("has a custom route color (not default 525252)", () => {
    expect(r.color).not.toBe("525252");
  });

  it("has at least 1 direction", () => {
    expect(r.directions.length).toBeGreaterThanOrEqual(1);
  });

  it("first stop is Biblioteka Uniwersytecka", () => {
    const d = r.directions[0];
    expect(d.stops[0].stop_name).toBe("Biblioteka Uniwersytecka");
  });

  it("has shape coordinates", () => {
    const d = r.directions[0];
    expect(d.shape.coordinates.length).toBeGreaterThan(0);
  });

  it("has at least 14 stops", () => {
    const d = r.directions[0];
    expect(d.stop_count).toBeGreaterThanOrEqual(14);
  });
});

// ===========================================================================
// Poznań/148 — mixed loop/non-loop
// ===========================================================================

describe("Poznań/148 — loop + non-loop directions", () => {
  const r = loadRoute("148");

  it("has at least 2 directions", () => {
    expect(r.directions.length).toBeGreaterThanOrEqual(2);
  });

  it("direction 0 is a loop", () => {
    const loopDir = r.directions[0];
    expect(loopDir.is_loop).toBe(true);
  });

  it("direction 1 is NOT a loop", () => {
    const nonLoopDir = r.directions[1];
    expect(nonLoopDir.is_loop).toBe(false);
  });

  it("loop direction: first/last stop names match", () => {
    const loopDir = r.directions[0];
    expect(loopDir.stops[0].stop_name).toBe(
      loopDir.stops[loopDir.stops.length - 1].stop_name,
    );
  });

  it("non-loop direction: first/last stop names differ", () => {
    const nonLoopDir = r.directions[1];
    expect(nonLoopDir.stops[0].stop_name).not.toBe(
      nonLoopDir.stops[nonLoopDir.stops.length - 1].stop_name,
    );
  });

  it("loop direction has more stops than non-loop", () => {
    const loopDir = r.directions[0];
    const nonLoopDir = r.directions[1];
    expect(loopDir.stop_count).toBeGreaterThan(nonLoopDir.stop_count);
  });
});

// ===========================================================================
// Poznań/125 — 4 directions: 2 loop + 2 non-loop
// ===========================================================================

describe("Poznań/125 — 4 directions (2 loop + 2 non-loop)", () => {
  const r = loadRoute("125");

  it("has 3–5 directions (tolerates variant additions)", () => {
    expect(r.directions.length).toBeGreaterThanOrEqual(3);
    expect(r.directions.length).toBeLessThanOrEqual(5);
  });

  it("at least 2 directions are loops", () => {
    const loopCount = r.directions.filter((d) => d.is_loop).length;
    expect(loopCount).toBeGreaterThanOrEqual(2);
  });

  it("at least 2 directions are non-loops", () => {
    const nonLoopCount = r.directions.filter((d) => !d.is_loop).length;
    expect(nonLoopCount).toBeGreaterThanOrEqual(2);
  });

  it("loop directions have matching first/last stop names", () => {
    for (const d of r.directions.filter((d) => d.is_loop)) {
      expect(d.stops[0].stop_name).toBe(d.stops[d.stops.length - 1].stop_name);
    }
  });

  it("non-loop directions have different first/last stop names", () => {
    for (const d of r.directions.filter((d) => !d.is_loop)) {
      expect(d.stops[0].stop_name).not.toBe(d.stops[d.stops.length - 1].stop_name);
    }
  });

  it("non-loop directions are roughly symmetric (±2 stops)", () => {
    const nonLoops = r.directions.filter((d) => !d.is_loop);
    expect(Math.abs(nonLoops[0].stop_count - nonLoops[1].stop_count)).toBeLessThanOrEqual(2);
  });

  it("has on-demand stops", () => {
    const total = r.directions.reduce((sum, d) => sum + onDemandCount(d), 0);
    expect(total).toBeGreaterThan(0);
  });
});

// ===========================================================================
// Poznań/822 — 4 directions: 1 loop + 3 non-loop, different termini
// ===========================================================================

describe("Poznań/822 — 4 directions (1 loop + 3 non-loop)", () => {
  const r = loadRoute("822");

  it("has 3–5 directions (tolerates variant additions)", () => {
    expect(r.directions.length).toBeGreaterThanOrEqual(3);
    expect(r.directions.length).toBeLessThanOrEqual(5);
  });

  it("at least 1 direction is a loop", () => {
    const loopCount = r.directions.filter((d) => d.is_loop).length;
    expect(loopCount).toBeGreaterThanOrEqual(1);
  });

  it("loop direction has matching first/last stop names", () => {
    const loopDir = r.directions.find((d) => d.is_loop);
    expect(loopDir.stops[0].stop_name).toBe(
      loopDir.stops[loopDir.stops.length - 1].stop_name,
    );
  });

  it("non-loop directions have different first/last stop names", () => {
    for (const d of r.directions.filter((d) => !d.is_loop)) {
      expect(d.stops[0].stop_name).not.toBe(d.stops[d.stops.length - 1].stop_name);
    }
  });

  it("has multiple distinct termini among non-loop directions", () => {
    const nonLoops = r.directions.filter((d) => !d.is_loop);
    const lastStops = nonLoops.map((d) => d.stops[d.stops.length - 1].stop_name);
    expect(new Set(lastStops).size).toBeGreaterThanOrEqual(2);
  });

  it("has on-demand stops", () => {
    const total = r.directions.reduce((sum, d) => sum + onDemandCount(d), 0);
    expect(total).toBeGreaterThan(0);
  });

  it("crosses multiple zones", () => {
    const zones = new Set(r.directions.flatMap(directionZones));
    expect(zones.size).toBeGreaterThanOrEqual(2);
  });
});

// ===========================================================================
// Świnoujście/3 — first→last stop grouping + OSRM shape fallback
// ===========================================================================

describe("Świnoujście/3 — first→last stop grouping, OSRM shapes", () => {
  const r = loadRoute("3", "swinoujscie");

  it("has 2–3 directions (tolerates variant additions)", () => {
    expect(r.directions.length).toBeGreaterThanOrEqual(2);
    expect(r.directions.length).toBeLessThanOrEqual(3);
  });

  it("direction names contain Posejdon and Dworzec PKP", () => {
    const names = r.directions.map((d) => d.direction_name);
    expect(
      names.some((n) => n.includes("POSEJDON") && n.includes("DWORZEC PKP")),
    ).toBe(true);
  });

  it("each direction has at least 10 stops", () => {
    for (const d of r.directions) {
      expect(d.stop_count).toBeGreaterThanOrEqual(10);
    }
  });

  it("uses OSRM-generated shapes (Świnoujście has no GTFS shapes)", () => {
    for (const d of r.directions) {
      expect(d.shape_id).toBe("osrm-generated");
    }
  });

  it("OSRM shapes have coordinates", () => {
    for (const d of r.directions) {
      expect(d.shape.coordinates.length).toBeGreaterThan(0);
    }
  });

  it("no audio_id field (TTS city)", () => {
    for (const d of r.directions) {
      for (const s of d.stops) {
        expect(s).not.toHaveProperty("audio_id");
      }
    }
  });

  it("no loop directions", () => {
    for (const d of r.directions) {
      expect(d.is_loop).toBe(false);
    }
  });
});

// ===========================================================================
// Gorzów/4 — merged route + per-direction color overrides
// ===========================================================================

describe("Gorzów/4 — merged route, per-direction colors", () => {
  const r = loadRoute("1895", "gorzow-wielkopolski");

  it("has 2–3 directions (tolerates variant additions)", () => {
    expect(r.directions.length).toBeGreaterThanOrEqual(2);
    expect(r.directions.length).toBeLessThanOrEqual(3);
  });

  it("has type TRAM", () => {
    expect(r.type).toBe("TRAM");
  });

  it("both directions have color overrides", () => {
    const colors = r.directions.map((d) => d.color).filter(Boolean);
    expect(colors.length).toBe(2);
  });

  it("direction colors are different from each other", () => {
    const colors = r.directions.map((d) => d.color);
    expect(colors[0]).not.toBe(colors[1]);
  });

  it("direction text_colors are different from each other", () => {
    const textColors = r.directions.map((d) => d.text_color);
    expect(textColors[0]).not.toBe(textColors[1]);
  });

  it("no audio_id field (TTS city)", () => {
    for (const d of r.directions) {
      for (const s of d.stops) {
        expect(s).not.toHaveProperty("audio_id");
      }
    }
  });
});

// ===========================================================================
// Gorzów/510 — merged route + loop + 4 directions
// ===========================================================================

describe("Gorzów/510 — merged route, loop + non-loop directions", () => {
  const r = loadRoute("2140", "gorzow-wielkopolski");

  it("has at least 3 directions (tolerates variant additions)", () => {
    expect(r.directions.length).toBeGreaterThanOrEqual(3);
  });

  it("at least 1 direction is a loop", () => {
    const loopCount = r.directions.filter((d) => d.is_loop).length;
    expect(loopCount).toBeGreaterThanOrEqual(1);
  });

  it("loop direction has matching first/last stop names", () => {
    const loopDir = r.directions.find((d) => d.is_loop);
    expect(loopDir.stops[0].stop_name).toBe(
      loopDir.stops[loopDir.stops.length - 1].stop_name,
    );
  });

  it("loop direction is the longest", () => {
    const loopDir = r.directions.find((d) => d.is_loop);
    const maxNonLoop = Math.max(
      ...r.directions.filter((d) => !d.is_loop).map((d) => d.stop_count),
    );
    expect(loopDir.stop_count).toBeGreaterThan(maxNonLoop);
  });

  it("all directions have shape coordinates", () => {
    for (const d of r.directions) {
      expect(d.shape.coordinates.length).toBeGreaterThan(0);
    }
  });

  it("no audio_id field (TTS city)", () => {
    for (const d of r.directions) {
      for (const s of d.stops) {
        expect(s).not.toHaveProperty("audio_id");
      }
    }
  });
});
