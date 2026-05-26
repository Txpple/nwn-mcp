import { describe, expect, it } from "vitest";
import type { GffDocument, GffObj } from "../types/gff.js";
import type { ModuleIndex } from "../types/module.js";
import { buildMinimalUtc, degToRad, getGitDoc, updateAreaCounts } from "./git-helpers.js";

describe("degToRad", () => {
  it("converts 0 degrees to 0 radians", () => {
    expect(degToRad(0)).toBe(0);
  });

  it("converts 90 degrees to pi/2", () => {
    expect(degToRad(90)).toBeCloseTo(Math.PI / 2);
  });

  it("converts 180 degrees to pi", () => {
    expect(degToRad(180)).toBeCloseTo(Math.PI);
  });

  it("converts 360 degrees to 2*pi", () => {
    expect(degToRad(360)).toBeCloseTo(2 * Math.PI);
  });

  it("converts negative degrees", () => {
    expect(degToRad(-90)).toBeCloseTo(-Math.PI / 2);
  });

  it("converts fractional degrees", () => {
    expect(degToRad(45)).toBeCloseTo(Math.PI / 4);
  });
});

describe("buildMinimalUtc", () => {
  it("returns a valid UTC GFF document", () => {
    const utc = buildMinimalUtc();
    expect(utc.__data_type).toBe("UTC ");
  });

  it("has default ability scores of 10", () => {
    const utc = buildMinimalUtc() as GffObj;
    for (const stat of ["Str", "Dex", "Con", "Int", "Wis", "Cha"]) {
      const field = utc[stat] as { type: string; value: number };
      expect(field.value).toBe(10);
    }
  });

  it("has a ClassList with one entry", () => {
    const utc = buildMinimalUtc() as GffObj;
    const classList = utc.ClassList as { type: string; value: unknown[] };
    expect(classList.type).toBe("list");
    expect(classList.value).toHaveLength(1);
  });

  it("has default hit points of 10", () => {
    const utc = buildMinimalUtc() as GffObj;
    expect((utc.HitPoints as { value: number }).value).toBe(10);
    expect((utc.MaxHitPoints as { value: number }).value).toBe(10);
    expect((utc.CurrentHitPoints as { value: number }).value).toBe(10);
  });

  it("has standard NWN creature scripts", () => {
    const utc = buildMinimalUtc() as GffObj;
    expect((utc.ScriptHeartbeat as { value: string }).value).toBe("nw_c2_default1");
    expect((utc.ScriptSpawn as { value: string }).value).toBe("nw_c2_default9");
    expect((utc.ScriptDeath as { value: string }).value).toBe("nw_c2_default7");
  });

  it("has empty Tag and TemplateResRef for caller to fill", () => {
    const utc = buildMinimalUtc() as GffObj;
    expect((utc.Tag as { value: string }).value).toBe("");
    expect((utc.TemplateResRef as { value: string }).value).toBe("");
  });

  it("has empty equipment and item lists", () => {
    const utc = buildMinimalUtc() as GffObj;
    expect((utc.Equip_ItemList as { value: unknown[] }).value).toEqual([]);
    expect((utc.ItemList as { value: unknown[] }).value).toEqual([]);
    expect((utc.FeatList as { value: unknown[] }).value).toEqual([]);
  });

  it("returns independent copies on each call", () => {
    const a = buildMinimalUtc() as GffObj;
    const b = buildMinimalUtc() as GffObj;
    (a.Tag as { value: string }).value = "modified";
    expect((b.Tag as { value: string }).value).toBe("");
  });
});

// Helper to build a minimal ModuleIndex for getGitDoc/updateAreaCounts tests
function makeIndex(areaResref: string, gitDoc: GffDocument): ModuleIndex {
  const parsedGff = new Map<string, GffDocument>();
  parsedGff.set(`${areaResref}.git`, gitDoc);

  const areas = new Map();
  areas.set(areaResref, {
    resref: areaResref,
    name: "Test Area",
    width: 4,
    height: 4,
    tileset: "tms01",
    isInterior: false,
    creatureCount: 0,
    placeableCount: 0,
    doorCount: 0,
    encounterCount: 0,
    triggerCount: 0,
    waypointCount: 0,
  });

  return {
    modPath: "/fake/path.mod",
    tempDir: "/fake/temp",
    moduleName: "Test",
    resources: new Map(),
    tags: new Map(),
    scripts: new Map(),
    areas,
    dialogs: new Map(),
    creatures: [],
    items: [],
    parsedGff,
    twodaTables: new Map(),
    customTlk: null,
    baseTlk: null,
    hakList: [],
    customTlkName: "",
    loadWarnings: [],
  };
}

function makeGitDoc(creatureCount: number, placeableCount: number, doorCount: number): GffDocument {
  const makeList = (n: number, structId: number) =>
    Array.from({ length: n }, (_, i) => ({
      __struct_id: structId,
      Tag: { type: "cexostring", value: `obj_${i}` },
    }));

  return {
    __data_type: "GIT ",
    "Creature List": { type: "list", value: makeList(creatureCount, 4) },
    "Placeable List": { type: "list", value: makeList(placeableCount, 9) },
    "Door List": { type: "list", value: makeList(doorCount, 8) },
    "Encounter List": { type: "list", value: [] },
    TriggerList: { type: "list", value: [] },
    WaypointList: { type: "list", value: [] },
    SoundList: { type: "list", value: [] },
    StoreList: { type: "list", value: [] },
  } as unknown as GffDocument;
}

describe("getGitDoc", () => {
  it("returns doc and obj for existing area", () => {
    const gitDoc = makeGitDoc(2, 3, 1);
    const index = makeIndex("testarea", gitDoc);
    const { doc, obj } = getGitDoc(index, "testarea");
    expect(doc).toBe(gitDoc);
    expect(obj).toBe(gitDoc);
  });

  it("throws for missing area", () => {
    const index = makeIndex("testarea", makeGitDoc(0, 0, 0));
    expect(() => getGitDoc(index, "nonexistent")).toThrow("GIT not found");
  });

  it("is case-insensitive on area resref", () => {
    const gitDoc = makeGitDoc(1, 0, 0);
    const index = makeIndex("myarea", gitDoc);
    const { doc } = getGitDoc(index, "MYAREA");
    expect(doc).toBe(gitDoc);
  });
});

describe("updateAreaCounts", () => {
  it("updates creature, placeable, and door counts", () => {
    const gitDoc = makeGitDoc(5, 3, 2);
    const index = makeIndex("testarea", gitDoc);
    updateAreaCounts(index, "testarea");

    const summary = index.areas.get("testarea")!;
    expect(summary.creatureCount).toBe(5);
    expect(summary.placeableCount).toBe(3);
    expect(summary.doorCount).toBe(2);
  });

  it("sets zero counts for empty lists", () => {
    const gitDoc = makeGitDoc(0, 0, 0);
    const index = makeIndex("testarea", gitDoc);
    updateAreaCounts(index, "testarea");

    const summary = index.areas.get("testarea")!;
    expect(summary.creatureCount).toBe(0);
    expect(summary.placeableCount).toBe(0);
    expect(summary.doorCount).toBe(0);
    expect(summary.encounterCount).toBe(0);
    expect(summary.triggerCount).toBe(0);
    expect(summary.waypointCount).toBe(0);
  });

  it("does nothing for unknown area (no crash)", () => {
    const index = makeIndex("testarea", makeGitDoc(0, 0, 0));
    expect(() => updateAreaCounts(index, "nonexistent")).not.toThrow();
  });
});
