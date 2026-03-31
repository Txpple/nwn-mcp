import { describe, it, expect } from "vitest";
import { buildCornerGrid, buildCrosserGrid, findTileByCorners, solveArea } from "./zone-solver.js";
import type { TerrainZone, CrosserPath, FeatureTile } from "./zone-solver.js";
import type { TilesetInfo, TileDefinition } from "./tileset.js";

// ─── Test Tileset ───────────────────────────────────────────────────────────

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
    corners: { topLeft: tl, topRight: tr, bottomLeft: bl, bottomRight: br },
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
    defaultTerrain: "Grass",
    floor: "",
    terrainTypes: [
      { index: 0, name: "Grass", strref: -1 },
      { index: 1, name: "Water", strref: -1 },
      { index: 2, name: "Trees", strref: -1 },
    ],
    crosserTypes: [{ index: 0, name: "Stream", strref: -1 }],
    primaryRules: [],
    secondaryRules: [],
    groups: [],
    tiles: [
      // 0: all-Grass
      makeTile(0, "Grass", "Grass", "Grass", "Grass"),
      // 1: all-Water
      makeTile(1, "Water", "Water", "Water", "Water"),
      // 2: all-Trees
      makeTile(2, "Trees", "Trees", "Trees", "Trees"),
      // 3: Grass/Water transition — 1 Water corner (BL)
      makeTile(3, "Grass", "Grass", "Water", "Grass"),
      // 4: Grass/Water transition — 2 Water corners (left side)
      makeTile(4, "Water", "Grass", "Water", "Grass"),
      // 5: Grass/Water transition — 2 Water corners (bottom)
      makeTile(5, "Grass", "Grass", "Water", "Water"),
      // 6: Grass/Water transition — 3 Water corners
      makeTile(6, "Water", "Grass", "Water", "Water"),
      // 7: Grass/Trees transition — 1 Trees corner (BL)
      makeTile(7, "Grass", "Grass", "Trees", "Grass"),
      // 8: all-Grass with Stream top+bottom
      makeTile(8, "Grass", "Grass", "Grass", "Grass", { top: "Stream", bottom: "Stream" }),
      // 9: all-Grass with Stream top only (dead end)
      makeTile(9, "Grass", "Grass", "Grass", "Grass", { top: "Stream" }),
      // 10: group tile — should be preserved
      makeTile(10, "Grass", "Grass", "Grass", "Grass", {}, 0),
    ],
  };
}

// ─── buildCornerGrid ────────────────────────────────────────────────────────

describe("buildCornerGrid", () => {
  it("fills all corners with default terrain when no zones", () => {
    const tileset = makeTileset();
    const grid = buildCornerGrid(2, 2, "Grass", [], [], tileset);
    // 3x3 corner grid = 9 values
    expect(grid).toHaveLength(9);
    expect(grid.every(c => c === "Grass")).toBe(true);
  });

  it("sets zone corners correctly for a single-tile zone", () => {
    const tileset = makeTileset();
    // Zone: Water at tile (0,0) in a 2x2 area
    const zones: TerrainZone[] = [{ terrain: "Water", tiles: [{ x: 0, y: 0 }] }];
    const grid = buildCornerGrid(2, 2, "Grass", zones, [], tileset);
    // Corner grid is 3x3. Tile (0,0) corners: BL=(0,0), BR=(1,0), TL=(0,1), TR=(1,1)
    expect(grid[0]).toBe("Water");  // (0,0)
    expect(grid[1]).toBe("Water");  // (1,0)
    expect(grid[3]).toBe("Water");  // (0,1)
    expect(grid[4]).toBe("Water");  // (1,1)
    // Other corners stay Grass
    expect(grid[2]).toBe("Grass");  // (2,0)
    expect(grid[5]).toBe("Grass");  // (2,1)
    expect(grid[6]).toBe("Grass");  // (0,2)
    expect(grid[7]).toBe("Grass");  // (1,2)
    expect(grid[8]).toBe("Grass");  // (2,2)
  });

  it("later zones override earlier zones at shared boundaries", () => {
    const tileset = makeTileset();
    // Zone 1: Water at (0,0). Zone 2: Trees at (1,0). Shared corner = (1,0)
    const zones: TerrainZone[] = [
      { terrain: "Water", tiles: [{ x: 0, y: 0 }] },
      { terrain: "Trees", tiles: [{ x: 1, y: 0 }] },
    ];
    const grid = buildCornerGrid(2, 2, "Grass", zones, [], tileset);
    // Shared corner (1,0) and (1,1): Trees should win (last zone)
    expect(grid[1]).toBe("Trees");  // (1,0)
    expect(grid[4]).toBe("Trees");  // (1,1)
    // Water-only corners
    expect(grid[0]).toBe("Water");  // (0,0)
    expect(grid[3]).toBe("Water");  // (0,1)
  });

  it("feature corners are locked and not overwritten by zones", () => {
    const tileset = makeTileset();
    // Feature tile 0 (all-Grass) at (0,0). Zone: Water at (0,0).
    const features: FeatureTile[] = [{ x: 0, y: 0, tileId: 0, orientation: 0 }];
    const zones: TerrainZone[] = [{ terrain: "Water", tiles: [{ x: 0, y: 0 }] }];
    const grid = buildCornerGrid(2, 2, "Grass", zones, features, tileset);
    // Feature locked all 4 corners of (0,0) to Grass (lowercased) — zone can't override
    expect(grid[0]).toBe("grass");  // (0,0)
    expect(grid[1]).toBe("grass");  // (1,0)
    expect(grid[3]).toBe("grass");  // (0,1)
    expect(grid[4]).toBe("grass");  // (1,1)
  });
});

// ─── buildCrosserGrid ───────────────────────────────────────────────────────

describe("buildCrosserGrid", () => {
  it("initializes all edges empty", () => {
    const grid = buildCrosserGrid(2, 2, []);
    expect(grid).toHaveLength(4);
    for (const entry of grid) {
      expect(entry).toEqual({ top: "", right: "", bottom: "", left: "" });
    }
  });

  it("sets crosser edges from path", () => {
    const crossers: CrosserPath[] = [{
      type: "Stream",
      path: [
        { x: 0, y: 0, edges: { top: true } },
        { x: 0, y: 1, edges: { top: true, bottom: true } },
      ],
    }];
    const grid = buildCrosserGrid(2, 2, crossers);
    expect(grid[0].top).toBe("Stream");    // (0,0)
    expect(grid[0].bottom).toBe("");
    expect(grid[2].top).toBe("Stream");    // (0,1) = index 1*2+0 = 2
    expect(grid[2].bottom).toBe("Stream");
  });
});

// ─── findTileByCorners ──────────────────────────────────────────────────────

describe("findTileByCorners", () => {
  it("finds exact match for all-Grass tile", () => {
    const tileset = makeTileset();
    const result = findTileByCorners(
      { tl: "Grass", tr: "Grass", bl: "Grass", br: "Grass" },
      { top: "", right: "", bottom: "", left: "" },
      tileset,
    );
    expect(result).not.toBeNull();
    expect(result!.tileId).toBe(0); // all-Grass tile
  });

  it("finds exact match for all-Water tile", () => {
    const tileset = makeTileset();
    const result = findTileByCorners(
      { tl: "Water", tr: "Water", bl: "Water", br: "Water" },
      { top: "", right: "", bottom: "", left: "" },
      tileset,
    );
    expect(result).not.toBeNull();
    expect(result!.tileId).toBe(1);
  });

  it("finds transition tile for mixed corners", () => {
    const tileset = makeTileset();
    // Tile 3 at ori 0: TL=Grass TR=Grass BL=Water BR=Grass
    const result = findTileByCorners(
      { tl: "Grass", tr: "Grass", bl: "Water", br: "Grass" },
      { top: "", right: "", bottom: "", left: "" },
      tileset,
    );
    expect(result).not.toBeNull();
    expect(result!.tileId).toBe(3);
    expect(result!.orientation).toBe(0);
  });

  it("finds rotated match", () => {
    const tileset = makeTileset();
    // Tile 3: TL=Grass TR=Grass BL=Water BR=Grass
    // At orientation 1 (90° CW): TL=TR=Grass, TR=BR=Grass, BR=BL=Water, BL=TL=Grass
    // Wait — rotation: ori 1: TL←TR, TR←BR, BR←BL, BL←TL
    // So: TL=Grass, TR=Grass, BR=Water, BL=Grass
    const result = findTileByCorners(
      { tl: "Grass", tr: "Grass", bl: "Grass", br: "Water" },
      { top: "", right: "", bottom: "", left: "" },
      tileset,
    );
    expect(result).not.toBeNull();
    expect(result!.tileId).toBe(3);
    expect(result!.orientation).toBe(1);
  });

  it("matches crosser edges exactly", () => {
    const tileset = makeTileset();
    const result = findTileByCorners(
      { tl: "Grass", tr: "Grass", bl: "Grass", br: "Grass" },
      { top: "Stream", right: "", bottom: "Stream", left: "" },
      tileset,
    );
    expect(result).not.toBeNull();
    expect(result!.tileId).toBe(8); // Stream top+bottom
  });

  it("returns null for impossible corner combo", () => {
    const tileset = makeTileset();
    // No tile has TL=Water TR=Trees BL=Water BR=Trees
    const result = findTileByCorners(
      { tl: "Water", tr: "Trees", bl: "Water", br: "Trees" },
      { top: "", right: "", bottom: "", left: "" },
      tileset,
    );
    expect(result).toBeNull();
  });

  it("skips group tiles", () => {
    const tileset = makeTileset();
    // Tile 10 is a group tile — should not be returned even though corners match
    const result = findTileByCorners(
      { tl: "Grass", tr: "Grass", bl: "Grass", br: "Grass" },
      { top: "", right: "", bottom: "", left: "" },
      tileset,
    );
    expect(result).not.toBeNull();
    expect(result!.tileId).not.toBe(10);
  });
});

// ─── solveArea ──────────────────────────────────────────────────────────────

describe("solveArea", () => {
  it("fills entire area with default terrain when no zones", () => {
    const tileset = makeTileset();
    const result = solveArea(2, 2, "Grass", tileset, [], [], []);
    expect(result.placements).toHaveLength(4);
    for (const p of result.placements) {
      expect(p.tileId).toBe(0); // all-Grass
    }
    expect(result.warnings).toHaveLength(0);
  });

  it("places water zone with correct transitions", () => {
    const tileset = makeTileset();
    // Water at (0,0) in a 2x2 area. Corner grid:
    // (0,0)=Water (1,0)=Water (2,0)=Grass
    // (0,1)=Water (1,1)=Water (2,1)=Grass
    // (0,2)=Grass  (1,2)=Grass  (2,2)=Grass
    //
    // Tile (0,0): TL=(0,1)=Water TR=(1,1)=Water BL=(0,0)=Water BR=(1,0)=Water → all-Water
    // Tile (1,0): TL=(1,1)=Water TR=(2,1)=Grass BL=(1,0)=Water BR=(2,0)=Grass → Water/Grass transition
    // Tile (0,1): TL=(0,2)=Grass TR=(1,2)=Grass BL=(0,1)=Water BR=(1,1)=Water → transition
    // Tile (1,1): TL=(1,2)=Grass TR=(2,2)=Grass BL=(1,1)=Water BR=(2,1)=Grass → 1 Water corner
    const zones: TerrainZone[] = [{ terrain: "Water", tiles: [{ x: 0, y: 0 }] }];
    const result = solveArea(2, 2, "Grass", tileset, zones, [], []);
    expect(result.placements).toHaveLength(4);

    // (0,0) should be all-Water
    const t00 = result.placements.find(p => p.x === 0 && p.y === 0);
    expect(t00).toBeDefined();
    expect(t00!.tileId).toBe(1); // all-Water
  });

  it("preserves feature tiles", () => {
    const tileset = makeTileset();
    const features: FeatureTile[] = [{ x: 0, y: 0, tileId: 10, orientation: 0 }];
    const result = solveArea(2, 2, "Grass", tileset, [], [], features);
    // Feature at (0,0) should not be in placements
    const hasFeaturePos = result.placements.some(p => p.x === 0 && p.y === 0);
    expect(hasFeaturePos).toBe(false);
    // Other 3 tiles should be placed
    expect(result.placements).toHaveLength(3);
  });

  it("places stream crosser tiles", () => {
    const tileset = makeTileset();
    const crossers: CrosserPath[] = [{
      type: "Stream",
      path: [{ x: 0, y: 0, edges: { top: true, bottom: true } }],
    }];
    const result = solveArea(2, 2, "Grass", tileset, [], crossers, []);
    const t00 = result.placements.find(p => p.x === 0 && p.y === 0);
    expect(t00).toBeDefined();
    expect(t00!.tileId).toBe(8); // Stream top+bottom
  });

  it("does not inject alien terrain when zones have incompatible adjacency", () => {
    // Tileset with Trees and CastleWall but NO transition tiles between them.
    // Grass is the default terrain but should NOT appear if zones only define
    // Trees and CastleWall with no unzoned tiles.
    const tileset: TilesetInfo = {
      ...makeTileset(),
      terrainTypes: [
        { index: 0, name: "Grass", strref: -1 },
        { index: 1, name: "Trees", strref: -1 },
        { index: 2, name: "CastleWall", strref: -1 },
      ],
      tiles: [
        makeTile(0, "Grass", "Grass", "Grass", "Grass"),
        makeTile(1, "Trees", "Trees", "Trees", "Trees"),
        makeTile(2, "CastleWall", "CastleWall", "CastleWall", "CastleWall"),
        // Trees/Grass transitions (exist)
        makeTile(3, "Grass", "Grass", "Trees", "Grass"),
        // CastleWall/Grass transitions (exist) — these are the "bait"
        // The solver should NOT use these because Grass is not in any zone
        makeTile(4, "Grass", "Grass", "CastleWall", "Grass"),
        makeTile(5, "CastleWall", "Grass", "CastleWall", "Grass"),
        // NO Trees/CastleWall transitions — this is the gap
      ],
    };

    // 4x1 area: all tiles covered by zones, no unzoned tiles
    // Left 2 tiles = Trees, right 2 tiles = CastleWall
    const zones: TerrainZone[] = [
      { terrain: "Trees", tiles: [{ x: 0, y: 0 }, { x: 1, y: 0 }] },
      { terrain: "CastleWall", tiles: [{ x: 2, y: 0 }, { x: 3, y: 0 }] },
    ];
    const result = solveArea(4, 1, "Grass", tileset, zones, [], []);

    // Check that NO placement uses a Grass tile — Grass was not in any zone
    // and every tile is covered by a zone, so Grass should not appear.
    // The boundary tile may fall back to all-default, but the solver must not
    // inject Grass corners on interior tiles.
    for (const p of result.placements) {
      const tile = tileset.tiles.find(t => t.id === p.tileId);
      expect(tile).toBeDefined();
      const corners = tile!.corners;
      // No corner should be "Grass" — it's an alien terrain not in any zone
      // (Grass IS the default terrain, but all tiles are covered by zones,
      // so the corner grid should contain only Trees and CastleWall)
      const hasGrass = [corners.topLeft, corners.topRight, corners.bottomLeft, corners.bottomRight]
        .some(c => c.toLowerCase() === "grass");
      expect(hasGrass).toBe(false);
    }
  });
});
