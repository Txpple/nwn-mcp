import { describe, it, expect } from "vitest";
import { validateTilePlacement, findDefaultTile } from "./tile-solver.js";
import type { TileGridEntry } from "./tile-solver.js";
import type { TilesetInfo, TileDefinition } from "./tileset.js";

function makeTile(
  id: number,
  tl: string, tr: string, bl: string, br: string,
  crossers: { top?: string; right?: string; bottom?: string; left?: string } = {},
  groupId: number | null = null,
): TileDefinition {
  return {
    id,
    model: `tile${id}`,
    imageMap2D: "",
    corners: {
      topLeft: tl,
      topRight: tr,
      bottomLeft: bl,
      bottomRight: br,
    },
    flat: true,
    crossers: {
      top: crossers.top ?? "",
      right: crossers.right ?? "",
      bottom: crossers.bottom ?? "",
      left: crossers.left ?? "",
    },
    pathNode: "",
    doors: 0,
    sounds: 0,
    orientation: 0,
    groupId,
    groupName: groupId !== null ? "TestGroup" : null,
  };
}

function makeTileset(): TilesetInfo {
  return {
    resref: "test",
    displayName: "Test Tileset",
    interior: false,
    hasHeightTransition: false,
    envMap: "",
    transition: 0,
    border: "",
    defaultTerrain: "Forest",
    floor: "",
    terrainTypes: [{ index: 0, name: "Forest", strref: -1 }, { index: 1, name: "Cliff", strref: -1 }],
    crosserTypes: [{ index: 0, name: "Road", strref: -1 }],
    primaryRules: [],
    secondaryRules: [],
    groups: [],
    tiles: [
      makeTile(0, "Forest", "Forest", "Forest", "Forest"),
      makeTile(1, "Cliff", "Cliff", "Cliff", "Cliff"),
      makeTile(2, "Forest", "Cliff", "Forest", "Cliff"),
      makeTile(3, "Forest", "Forest", "Forest", "Forest", { top: "Road" }),
      makeTile(4, "Forest", "Forest", "Forest", "Forest", { bottom: "Road" }),
      makeTile(5, "Forest", "Forest", "Forest", "Forest", {}, 0),
    ],
  };
}

describe("findDefaultTile", () => {
  it("finds all-Forest tile as default", () => {
    const tileset = makeTileset();
    const result = findDefaultTile(tileset, "Forest");
    expect(result).not.toBeNull();
    expect(result!.tileId).toBe(0);
  });

  it("finds all-Cliff tile when requested", () => {
    const tileset = makeTileset();
    const result = findDefaultTile(tileset, "Cliff");
    expect(result).not.toBeNull();
    expect(result!.tileId).toBe(1);
  });

  it("uses tileset defaultTerrain when no terrain specified", () => {
    const tileset = makeTileset();
    const result = findDefaultTile(tileset);
    expect(result).not.toBeNull();
    expect(result!.tileId).toBe(0); // Forest is default
  });

  it("skips group tiles", () => {
    const tileset = makeTileset();
    const result = findDefaultTile(tileset, "Forest");
    expect(result).not.toBeNull();
    expect(result!.tileId).not.toBe(5);
  });
});

describe("validateTilePlacement", () => {
  it("returns no violations for matching neighbors", () => {
    const tileset = makeTileset();
    const grid: (TileGridEntry | null)[] = [
      { tileId: 0, orientation: 0 },
      { tileId: 0, orientation: 0 },
    ];
    const violations = validateTilePlacement(grid, 0, 0, 2, 1, tileset);
    expect(violations).toHaveLength(0);
  });

  it("detects corner mismatch between neighbors", () => {
    const tileset = makeTileset();
    // Tile 0 (all-Forest) next to Tile 1 (all-Cliff) — shared corners don't match
    const grid: (TileGridEntry | null)[] = [
      { tileId: 0, orientation: 0 },
      { tileId: 1, orientation: 0 },
    ];
    const violations = validateTilePlacement(grid, 0, 0, 2, 1, tileset);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.some(v => v.includes("corner mismatch"))).toBe(true);
  });
});
