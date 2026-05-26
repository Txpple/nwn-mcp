import { describe, expect, it } from "vitest";
import { getGroupTransformDimensions, getTransformedGroupPlacements } from "./group-transform.js";
import type { TileGridEntry } from "./tile-solver.js";
import {
  buildDefaultTileGrid,
  findDefaultTile,
  findDefaultTileVariants,
  validateTilePlacement,
} from "./tile-solver.js";
import type { TileDefinition, TilesetInfo } from "./tileset.js";

function makeTile(
  id: number,
  tl: string,
  tr: string,
  bl: string,
  br: string,
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
    doorPlacements: [],
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
    terrainTypes: [
      { index: 0, name: "Forest", rawName: "Forest", strref: -1 },
      { index: 1, name: "Cliff", rawName: "Cliff", strref: -1 },
    ],
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
      makeTile(6, "Forest", "Forest", "Forest", "Forest"),
    ],
  };
}

describe("findDefaultTile", () => {
  it("finds all-Forest tile as default", () => {
    const tileset = makeTileset();
    const result = findDefaultTile(tileset, "Forest");
    expect(result).not.toBeNull();
    expect([0, 6]).toContain(result!.tileId);
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
    expect([0, 6]).toContain(result!.tileId); // Forest is default
  });

  it("skips group tiles", () => {
    const tileset = makeTileset();
    const result = findDefaultTile(tileset, "Forest");
    expect(result).not.toBeNull();
    expect(result!.tileId).not.toBe(5);
  });

  it("returns a strict candidate pool in safe mode", () => {
    const tileset = makeTileset();
    const result = findDefaultTileVariants(tileset, "Forest", "safe");
    const tileIds = new Set(result.variants.map((variant) => variant.tileId));
    expect(tileIds.has(0)).toBe(true);
    expect(tileIds.has(6)).toBe(true);
    expect(tileIds.has(2)).toBe(false);
    expect(tileIds.has(3)).toBe(false);
    expect(tileIds.has(5)).toBe(false);
  });

  it("fills an area with multiple safe default tile variants", () => {
    const tileset = makeTileset();
    const result = buildDefaultTileGrid(4, 2, tileset, "Forest", "safe");
    expect(result).not.toBeNull();

    const tileIds = new Set(result!.placements.map((placement) => placement.tileId));
    expect(tileIds.has(0)).toBe(true);
    expect(tileIds.has(6)).toBe(true);
    expect(result!.warnings).toHaveLength(0);
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
    expect(violations.some((v) => v.includes("corner mismatch"))).toBe(true);
  });
});

describe("group transform helpers", () => {
  it("rotates a group footprint as a unit", () => {
    const group = {
      index: 0,
      name: "TestGroup",
      strref: 0,
      rows: 2,
      columns: 3,
      tileIds: [0, 1, 2, 3, 4, 5],
    };

    const dims = getGroupTransformDimensions(group, "rotate90");
    expect(dims).toEqual({ columns: 2, rows: 3 });

    const placements = getTransformedGroupPlacements(group, 10, 20, "rotate90");
    expect(placements).toHaveLength(6);
    expect(placements.map((p) => [p.gx, p.gy, p.tileId, p.orientation])).toEqual([
      [10, 22, 0, 1],
      [10, 21, 1, 1],
      [10, 20, 2, 1],
      [11, 22, 3, 1],
      [11, 21, 4, 1],
      [11, 20, 5, 1],
    ]);
  });
});
