/**
 * Area creation and tile painting MCP tools.
 *
 * Tools:
 * - create_area: Create a new area with default terrain tiles
 * - delete_area: Remove an area and its files from the module
 * - paint_tiles: Set exact tile IDs (manual/direct placement)
 * - paint_terrain: Paint terrain and re-solve shared-corner neighbors
 * - paint_group: Place multi-tile groups (temples, lodges, etc.)
 * - set_area_properties: Modify area lighting, music, weather, etc.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import fs from "fs/promises";
import path from "path";
import { z } from "zod";
import { buildResmanOptions, requireIndex } from "../module-loader.js";
import { syncNasherSourceForIndex } from "../nasher-sync.js";
import { jsonToGff } from "../nim-tools.js";
import type { GffDocument, GffObj } from "../types/gff.js";
import { getFieldList, getFieldNum, getFieldStr, setFieldNum } from "../types/gff.js";
import type { TwoDATable } from "../types/module.js";
import {
  GROUP_TRANSFORMS,
  type GroupTransform,
  getGroupTransformDimensions,
  getTransformedGroupPlacements,
  parseGroupTransformRequest,
  pickRandomGroupTransform,
  type TransformedGroupDimensions,
  type TransformedGroupPlacement,
} from "../util/group-transform.js";
import {
  buildDefaultTileGrid,
  type DefaultTileFillMode,
  type DefaultTileGridWarning,
  type DefaultTileVariant,
  type TileGridEntry,
  validateTilePlacement,
} from "../util/tile-solver.js";
import type { TilesetInfo } from "../util/tileset.js";
import { getTilesetInfo } from "../util/tileset.js";
import { computeTileWalkSummary, ensureWokCacheDir, getWokForTile } from "../util/walkmesh.js";
import { paintTerrainTiles, type TerrainPaintTile } from "../util/zone-solver.js";

function parseDefaultFillMode(value: string | undefined): DefaultTileFillMode | null {
  const mode = (value ?? "relaxed").toLowerCase();
  return mode === "safe" || mode === "relaxed" ? mode : null;
}

function summarizeDefaultFillUsage(placements: DefaultTileVariant[]) {
  const usage = new Map<
    string,
    { tileId: number; orientation: number; score: number; count: number; warnings: string[] }
  >();
  for (const placement of placements) {
    const key = `${placement.tileId}:${placement.orientation}`;
    const existing = usage.get(key);
    if (existing) {
      existing.count++;
    } else {
      usage.set(key, {
        tileId: placement.tileId,
        orientation: placement.orientation,
        score: placement.score,
        count: 1,
        warnings: placement.warnings,
      });
    }
  }
  return [...usage.values()].sort((a, b) => b.count - a.count || a.tileId - b.tileId || a.orientation - b.orientation);
}

function summarizeDefaultFillWarnings(warnings: DefaultTileGridWarning[]) {
  const counts = new Map<string, number>();
  for (const warning of warnings) {
    counts.set(warning.message, (counts.get(warning.message) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([message, count]) => ({ message, count }))
    .sort((a, b) => b.count - a.count || a.message.localeCompare(b.message));
}

function buildTileGrid(tileList: GffObj[], width: number, height: number): (TileGridEntry | null)[] {
  const grid: (TileGridEntry | null)[] = [];
  for (let i = 0; i < width * height; i++) {
    const entry = tileList[i];
    if (entry) {
      grid.push({ tileId: getFieldNum(entry, "Tile_ID"), orientation: getFieldNum(entry, "Tile_Orientation") });
    } else {
      grid.push(null);
    }
  }
  return grid;
}

function parseIntegerField(value: unknown, label: string): number {
  const numberValue =
    typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
  if (!Number.isInteger(numberValue)) {
    throw new Error(`${label} must be an integer`);
  }
  return numberValue;
}

function parseTerrainPaintTiles(tilesJson: string): TerrainPaintTile[] {
  const parsed: unknown = JSON.parse(tilesJson);
  if (!Array.isArray(parsed)) throw new Error("tiles must be an array");

  return parsed.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`tiles[${index}] must be an object`);
    }
    const raw = entry as Record<string, unknown>;
    return {
      x: parseIntegerField(raw.x, `tiles[${index}].x`),
      y: parseIntegerField(raw.y, `tiles[${index}].y`),
    };
  });
}

function terrainLookupNames(terrain: TilesetInfo["terrainTypes"][number]): string[] {
  return [terrain.rawName, terrain.name].filter((name): name is string => !!name);
}

function resolveTerrainName(tileset: TilesetInfo, requested: string): string | null {
  const lcRequested = requested.toLowerCase();
  const match = tileset.terrainTypes.find((terrain) =>
    terrainLookupNames(terrain).some((name) => name.toLowerCase() === lcRequested),
  );
  return match ? (match.rawName || match.name).toLowerCase() : null;
}

function listTerrainNames(tileset: TilesetInfo): string {
  const names = new Set<string>();
  for (const terrain of tileset.terrainTypes) {
    for (const name of terrainLookupNames(terrain)) names.add(name);
  }
  return [...names].join(", ");
}

function groupFits(
  x: number,
  y: number,
  dimensions: TransformedGroupDimensions,
  areaWidth: number,
  areaHeight: number,
): boolean {
  return x >= 0 && y >= 0 && x + dimensions.columns <= areaWidth && y + dimensions.rows <= areaHeight;
}

function collectGroupPlacementWarnings(
  placements: TransformedGroupPlacement[],
  dimensions: TransformedGroupDimensions,
  grid: (TileGridEntry | null)[],
  areaWidth: number,
  areaHeight: number,
  tileset: TilesetInfo,
): string[] {
  const warnings: string[] = [];
  for (const placement of placements) {
    const isEdge =
      placement.localCol === 0 ||
      placement.localCol === dimensions.columns - 1 ||
      placement.localRow === 0 ||
      placement.localRow === dimensions.rows - 1;
    if (!isEdge) continue;

    const violations = validateTilePlacement(grid, placement.gx, placement.gy, areaWidth, areaHeight, tileset);
    if (violations.length > 0) {
      warnings.push(`(${placement.gx},${placement.gy}): ${violations.join("; ")}`);
    }
  }
  return warnings;
}

function applyGroupPlacementsToGrid(
  grid: (TileGridEntry | null)[],
  placements: TransformedGroupPlacement[],
  areaWidth: number,
): (TileGridEntry | null)[] {
  const nextGrid = grid.slice();
  for (const placement of placements) {
    nextGrid[placement.gy * areaWidth + placement.gx] = {
      tileId: placement.tileId,
      orientation: placement.orientation,
    };
  }
  return nextGrid;
}

export function registerPaintTools(server: McpServer): void {
  // ─── create_area ───────────────────────────────────────────────────────

  server.tool(
    "create_area",
    "Create a new area with default terrain tiles. Creates ARE, GIT, and GIC files, registers in module IFO.",
    {
      resref: z.string().describe("Area resref (filename, e.g. 'myarea')"),
      name: z.string().describe("Area display name"),
      width: z.string().describe("Area width in tiles (1-32)"),
      height: z.string().describe("Area height in tiles (1-32)"),
      tileset: z.string().describe("Tileset resref (e.g., 'ttf01' for forest)"),
      defaultTerrain: z.string().optional().describe("Default terrain type (defaults to tileset's first terrain)"),
      defaultFillMode: z
        .enum(["relaxed", "safe"])
        .optional()
        .describe(
          "'relaxed' (default) varies visually among compatible flat tile IDs; 'safe' uses strict uniform-terrain, no-crosser tiles only",
        ),
    },
    async ({
      resref,
      name,
      width: widthStr,
      height: heightStr,
      tileset: tilesetResref,
      defaultTerrain,
      defaultFillMode,
    }) => {
      const width = parseInt(widthStr, 10);
      const height = parseInt(heightStr, 10);
      if (Number.isNaN(width) || width < 1 || width > 32)
        return { content: [{ type: "text", text: "width must be 1-32" }] };
      if (Number.isNaN(height) || height < 1 || height > 32)
        return { content: [{ type: "text", text: "height must be 1-32" }] };
      const fillMode = parseDefaultFillMode(defaultFillMode);
      if (!fillMode) {
        return { content: [{ type: "text", text: "defaultFillMode must be 'relaxed' or 'safe'" }] };
      }
      const index = requireIndex();
      const resrefLower = resref.toLowerCase();
      const areKey = `${resrefLower}.are`;

      if (index.resources.has(areKey)) {
        return { content: [{ type: "text", text: `Area already exists: ${resrefLower}` }] };
      }

      const resmanOpts = await buildResmanOptions(index);
      const tileset = await getTilesetInfo(tilesetResref.toLowerCase(), resmanOpts, index);

      const defaultGrid = buildDefaultTileGrid(width, height, tileset, defaultTerrain, fillMode);
      if (!defaultGrid) {
        return {
          content: [
            {
              type: "text",
              text: `No suitable default tile found for terrain: ${defaultTerrain || tileset.defaultTerrain}`,
            },
          ],
        };
      }

      // Build Tile_List
      const tileList: GffObj[] = [];
      for (let i = 0; i < width * height; i++) {
        const defaultPlacement = defaultGrid.placements[i];
        tileList.push({
          __struct_id: i,
          Tile_ID: { type: "int", value: defaultPlacement.tileId },
          Tile_Orientation: { type: "int", value: defaultPlacement.orientation },
          Tile_Height: { type: "int", value: 0 },
          Tile_MainLight1: { type: "byte", value: 0 },
          Tile_MainLight2: { type: "byte", value: 0 },
          Tile_SrcLight1: { type: "byte", value: 0 },
          Tile_SrcLight2: { type: "byte", value: 0 },
          Tile_AnimLoop1: { type: "byte", value: 1 },
          Tile_AnimLoop2: { type: "byte", value: 1 },
          Tile_AnimLoop3: { type: "byte", value: 1 },
        });
      }

      // Build ARE document
      const areDoc: GffDocument = {
        __data_type: "ARE ",
        Name: { type: "cexolocstring", value: { "0": name } },
        Tag: { type: "cexostring", value: resrefLower },
        ResRef: { type: "resref", value: resrefLower },
        Width: { type: "int", value: width },
        Height: { type: "int", value: height },
        Tileset: { type: "resref", value: tilesetResref.toLowerCase() },
        Tile_List: { type: "list", value: tileList },
        Flags: { type: "dword", value: tileset.interior ? 1 : 0 },
        // Lighting defaults
        DynAmbientColor: { type: "dword", value: 6316128 },
        IsNight: { type: "byte", value: 0 },
        LightingScheme: { type: "byte", value: 0 },
        SunAmbientColor: { type: "dword", value: 6316128 },
        SunDiffuseColor: { type: "dword", value: 16777215 },
        SunFogColor: { type: "dword", value: 8421504 },
        SunFogAmount: { type: "byte", value: 0 },
        SunShadows: { type: "byte", value: 1 },
        MoonAmbientColor: { type: "dword", value: 2105440 },
        MoonDiffuseColor: { type: "dword", value: 4210816 },
        MoonFogColor: { type: "dword", value: 4210816 },
        MoonFogAmount: { type: "byte", value: 0 },
        MoonShadows: { type: "byte", value: 1 },
        FogClipDist: { type: "float", value: 45.0 },
        SkyBox: { type: "byte", value: tileset.interior ? 0 : 1 },
        WindPower: { type: "int", value: 0 },
        DayNightCycle: { type: "byte", value: 1 },
        ChanceLightning: { type: "int", value: 0 },
        ChanceRain: { type: "int", value: 0 },
        ChanceSnow: { type: "int", value: 0 },
        NoRest: { type: "byte", value: 0 },
        PlayerVsPlayer: { type: "byte", value: 0 },
        // Module events
        OnEnter: { type: "resref", value: "" },
        OnExit: { type: "resref", value: "" },
        OnHeartbeat: { type: "resref", value: "" },
        OnUserDefined: { type: "resref", value: "" },
        // Version
        Version: { type: "dword", value: 4 },
      };

      // Build GIT document (empty area instance)
      const gitDoc: GffDocument = {
        __data_type: "GIT ",
        "Creature List": { type: "list", value: [] },
        "Door List": { type: "list", value: [] },
        "Encounter List": { type: "list", value: [] },
        "Placeable List": { type: "list", value: [] },
        SoundList: { type: "list", value: [] },
        StoreList: { type: "list", value: [] },
        TriggerList: { type: "list", value: [] },
        WaypointList: { type: "list", value: [] },
        List: { type: "list", value: [] },
        AreaProperties: {
          type: "struct",
          value: {
            __struct_id: 0,
            AmbientSndDay: { type: "int", value: 0 },
            AmbientSndDayVol: { type: "int", value: 0 },
            AmbientSndNight: { type: "int", value: 0 },
            AmbientSndNitVol: { type: "int", value: 0 },
            MusicBattle: { type: "int", value: 0 },
            MusicDay: { type: "int", value: 0 },
            MusicDelay: { type: "int", value: 0 },
            MusicNight: { type: "int", value: 0 },
          },
        },
      };

      // Build GIC document (empty area comments)
      const gicDoc: GffDocument = {
        __data_type: "GIC ",
        "Creature List": { type: "list", value: [] },
        "Door List": { type: "list", value: [] },
        "Encounter List": { type: "list", value: [] },
        "Placeable List": { type: "list", value: [] },
        SoundList: { type: "list", value: [] },
        StoreList: { type: "list", value: [] },
        TriggerList: { type: "list", value: [] },
        WaypointList: { type: "list", value: [] },
      };

      // Write all 3 files
      const arePath = path.join(index.tempDir, `${resrefLower}.are`);
      const gitPath = path.join(index.tempDir, `${resrefLower}.git`);
      const gicPath = path.join(index.tempDir, `${resrefLower}.gic`);

      await jsonToGff(areDoc, arePath);
      await jsonToGff(gitDoc, gitPath);
      await jsonToGff(gicDoc, gicPath);

      // Register in index
      for (const [ext, doc, filePath] of [
        ["are", areDoc, arePath],
        ["git", gitDoc, gitPath],
        ["gic", gicDoc, gicPath],
      ] as [string, GffDocument, string][]) {
        const key = `${resrefLower}.${ext}`;
        const stat = await fs.stat(filePath);
        index.resources.set(key, {
          resref: resrefLower,
          extension: ext,
          filePath,
          sizeBytes: stat.size,
        });
        index.parsedGff.set(key, doc);
      }

      // Register area summary
      index.areas.set(resrefLower, {
        resref: resrefLower,
        name,
        width,
        height,
        tileset: tilesetResref.toLowerCase(),
        isInterior: tileset.interior,
        creatureCount: 0,
        placeableCount: 0,
        doorCount: 0,
        encounterCount: 0,
        triggerCount: 0,
        waypointCount: 0,
      });

      // Add to module IFO area list
      const ifo = index.parsedGff.get("module.ifo");
      if (ifo) {
        const ifoObj = ifo as GffObj;
        const areaList = getFieldList(ifoObj, "Mod_Area_list");
        areaList.push({
          __struct_id: areaList.length,
          Area_Name: { type: "resref", value: resrefLower },
        });
        // Write back IFO
        const ifoEntry = index.resources.get("module.ifo");
        if (ifoEntry) {
          await jsonToGff(ifo, ifoEntry.filePath);
        }
      }

      const nasherSync = await syncNasherSourceForIndex(index, { reason: "create_area" });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                success: true,
                area: resrefLower,
                name,
                width,
                height,
                tileset: tilesetResref.toLowerCase(),
                defaultTile: {
                  terrain: defaultGrid.terrain,
                  mode: defaultGrid.mode,
                  candidateCount: defaultGrid.candidates.length,
                  variantsUsed: summarizeDefaultFillUsage(defaultGrid.placements),
                },
                ...(defaultGrid.warnings.length > 0
                  ? { defaultFillWarnings: summarizeDefaultFillWarnings(defaultGrid.warnings) }
                  : {}),
                totalTiles: width * height,
                ...(nasherSync ? { nasherSync } : {}),
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  // ─── delete_area ───────────────────────────────────────────────────────

  server.tool(
    "delete_area",
    "Remove an area from the module. Deletes ARE, GIT, and GIC files and unregisters from module IFO. Cannot delete the module entry area. This action is irreversible (no undo support).",
    {
      area: z.string().describe("Area resref to delete"),
    },
    { destructiveHint: true },
    async ({ area }) => {
      const index = requireIndex();
      const areaResref = area.toLowerCase();

      if (!index.areas.has(areaResref)) {
        return { content: [{ type: "text", text: `Area not found: ${areaResref}` }] };
      }

      // Block deletion of module entry area
      const ifo = index.parsedGff.get("module.ifo");
      if (!ifo) {
        return { content: [{ type: "text", text: "module.ifo not found" }] };
      }
      const ifoObj = ifo as GffObj;
      const entryArea = getFieldStr(ifoObj, "Mod_Entry_Area").toLowerCase();
      if (areaResref === entryArea) {
        return {
          content: [
            { type: "text", text: `Cannot delete the module entry area '${areaResref}'. Change Mod_Entry_Area first.` },
          ],
        };
      }

      const deletedArea = index.areas.get(areaResref)!;
      const areaName = deletedArea.name;

      // Remove from IFO Mod_Area_list
      const areaList = getFieldList(ifoObj, "Mod_Area_list");
      const ifoIdx = areaList.findIndex((a) => getFieldStr(a, "Area_Name").toLowerCase() === areaResref);
      if (ifoIdx >= 0) {
        areaList.splice(ifoIdx, 1);
        // Re-index __struct_id
        for (let i = 0; i < areaList.length; i++) {
          (areaList[i] as GffObj).__struct_id = i;
        }
      }
      const ifoEntry = index.resources.get("module.ifo");
      if (ifoEntry) {
        await jsonToGff(ifo, ifoEntry.filePath);
      }

      // Delete files and clean caches
      for (const ext of ["are", "git", "gic"]) {
        const key = `${areaResref}.${ext}`;
        const entry = index.resources.get(key);
        if (entry) {
          await fs.unlink(entry.filePath).catch(() => {});
          index.resources.delete(key);
          index.parsedGff.delete(key);
        }
      }

      // Clean up index entries
      index.areas.delete(areaResref);
      index.creatures = index.creatures.filter((c) => c.area !== areaResref);

      const nasherSync = await syncNasherSourceForIndex(index, {
        reason: "delete_area",
        removeDeleted: true,
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                success: true,
                deleted: { resref: areaResref, name: areaName },
                remainingAreas: index.areas.size,
                ...(nasherSync ? { nasherSync } : {}),
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  // ─── paint_tiles ──────────────────────────────────────────────────────

  server.tool(
    "paint_tiles",
    "Set exact tile IDs on specific positions. Direct placement, no solving.",
    {
      area: z.string().describe("Area resref"),
      tiles: z.string().describe("JSON array: [{x, y, tileId, orientation?}]"),
    },
    { idempotentHint: true },
    async ({ area, tiles: tilesJson }) => {
      let tiles: Array<{ x: number; y: number; tileId: number; orientation?: number }>;
      try {
        tiles = JSON.parse(tilesJson);
        if (!Array.isArray(tiles)) throw new Error("tiles must be an array");
      } catch (e) {
        return { content: [{ type: "text", text: `Invalid tiles JSON: ${e}` }] };
      }

      const index = requireIndex();
      const areKey = `${area.toLowerCase()}.are`;
      const areDoc = index.parsedGff.get(areKey);
      if (!areDoc) {
        return { content: [{ type: "text", text: `Area not found: ${area}` }] };
      }

      const are = areDoc as GffObj;
      const areaWidth = getFieldNum(are, "Width");
      const areaHeight = getFieldNum(are, "Height");
      const tileList = getFieldList(are, "Tile_List");
      const tilesetResref = getFieldStr(are, "Tileset").toLowerCase();

      const resmanOpts = await buildResmanOptions(index);
      const tileset = await getTilesetInfo(tilesetResref, resmanOpts, index);

      // Build grid for validation
      const grid: (TileGridEntry | null)[] = [];
      for (let i = 0; i < areaWidth * areaHeight; i++) {
        const entry = tileList[i];
        if (entry) {
          grid.push({ tileId: getFieldNum(entry, "Tile_ID"), orientation: getFieldNum(entry, "Tile_Orientation") });
        } else {
          grid.push(null);
        }
      }

      const results: Array<{ x: number; y: number; tileId: number; orientation: number; warnings: string[] }> = [];

      for (const req of tiles) {
        const { x, y, tileId } = req;
        const ori = req.orientation ?? 0;
        const warnings: string[] = [];

        if (x < 0 || x >= areaWidth || y < 0 || y >= areaHeight) {
          results.push({
            x,
            y,
            tileId,
            orientation: ori,
            warnings: [`Out of bounds (area is ${areaWidth}x${areaHeight})`],
          });
          continue;
        }

        const idx = y * areaWidth + x;
        grid[idx] = { tileId, orientation: ori };

        // Validate against neighbors
        const violations = validateTilePlacement(grid, x, y, areaWidth, areaHeight, tileset);
        if (violations.length > 0) {
          warnings.push(...violations.map((v) => `Constraint violation: ${v}`));
        }

        // Update GFF
        const tileEntry = tileList[idx] as GffObj;
        setFieldNum(tileEntry, "Tile_ID", tileId, "int");
        setFieldNum(tileEntry, "Tile_Orientation", ori, "int");
        setFieldNum(tileEntry, "Tile_Height", 0, "int");

        results.push({ x, y, tileId, orientation: ori, warnings });
      }

      // Write back ARE
      const areEntry = index.resources.get(areKey);
      if (areEntry) {
        await jsonToGff(areDoc, areEntry.filePath);
      }

      const nasherSync = await syncNasherSourceForIndex(index, { reason: "paint_tiles" });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { success: true, area, placements: results, ...(nasherSync ? { nasherSync } : {}) },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  // ─── paint_terrain ────────────────────────────────────────────────────

  server.tool(
    "paint_terrain",
    "Paint a terrain type at tile positions, re-solving shared-corner neighbors like the NWN toolset terrain brush.",
    {
      area: z.string().describe("Area resref"),
      terrain: z.string().describe("Terrain type name from the area's tileset, e.g. 'pit' or 'forest'"),
      tiles: z.string().describe("JSON array of tile positions to paint: [{x, y}]"),
    },
    { idempotentHint: true },
    async ({ area, terrain, tiles: tilesJson }) => {
      let tiles: TerrainPaintTile[];
      try {
        tiles = parseTerrainPaintTiles(tilesJson);
      } catch (e) {
        return { content: [{ type: "text", text: `Invalid tiles JSON: ${e}` }] };
      }

      const index = requireIndex();
      const areaResref = area.toLowerCase();
      const areKey = `${areaResref}.are`;
      const areDoc = index.parsedGff.get(areKey);
      if (!areDoc) {
        return { content: [{ type: "text", text: `Area not found: ${area}` }] };
      }

      const are = areDoc as GffObj;
      const areaWidth = getFieldNum(are, "Width");
      const areaHeight = getFieldNum(are, "Height");
      const tileList = getFieldList(are, "Tile_List");
      const tilesetResref = getFieldStr(are, "Tileset").toLowerCase();

      const resmanOpts = await buildResmanOptions(index);
      const tileset = await getTilesetInfo(tilesetResref, resmanOpts, index);
      const resolvedTerrain = resolveTerrainName(tileset, terrain);
      if (!resolvedTerrain) {
        return {
          content: [
            {
              type: "text",
              text: `Terrain not found: ${terrain}. Available: ${listTerrainNames(tileset)}`,
            },
          ],
        };
      }

      const grid = buildTileGrid(tileList as GffObj[], areaWidth, areaHeight);
      const result = paintTerrainTiles(areaWidth, areaHeight, tileset, grid, resolvedTerrain, tiles);

      for (const placement of result.placements) {
        const areaIdx = placement.y * areaWidth + placement.x;
        const tileEntry = tileList[areaIdx] as GffObj;
        setFieldNum(tileEntry, "Tile_ID", placement.tileId, "int");
        setFieldNum(tileEntry, "Tile_Orientation", placement.orientation, "int");
        setFieldNum(tileEntry, "Tile_Height", 0, "int");
      }

      const areEntry = index.resources.get(areKey);
      if (areEntry) {
        await jsonToGff(areDoc, areEntry.filePath);
      }

      const nasherSync = await syncNasherSourceForIndex(index, { reason: "paint_terrain" });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                success: true,
                area: areaResref,
                terrain: resolvedTerrain,
                requestedTiles: tiles,
                placements: result.placements,
                warnings: result.warnings,
                ...(nasherSync ? { nasherSync } : {}),
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  // ─── paint_group ───────────────────────────────────────────────────────

  server.tool(
    "paint_group",
    "Place a multi-tile group (e.g. 'Temple_3x2', 'Lodge_2x2') at a grid position. Validates bounds and edge constraints.",
    {
      area: z.string().describe("Area resref"),
      feature: z
        .string()
        .describe("Group name (e.g. 'Temple_3x2', 'Lodge_2x2') — use get_tileset_details to see available groups"),
      x: z.string().describe("Bottom-left column of the feature (0-based)"),
      y: z.string().describe("Bottom-left row of the feature (0-based)"),
      transform: z
        .enum([...GROUP_TRANSFORMS, "random"])
        .optional()
        .describe("Whole-group transform: none (default), rotate90, rotate180, rotate270, or random"),
    },
    { idempotentHint: true },
    async ({ area, feature, x: xStr, y: yStr, transform: transformStr }) => {
      const x = parseInt(xStr, 10);
      const y = parseInt(yStr, 10);
      const transformRequest = parseGroupTransformRequest(transformStr);
      if (!transformRequest) {
        return {
          content: [
            {
              type: "text",
              text: `transform must be one of: ${[...GROUP_TRANSFORMS, "random"].join(", ")}`,
            },
          ],
        };
      }
      const index = requireIndex();
      const areKey = `${area.toLowerCase()}.are`;
      const areDoc = index.parsedGff.get(areKey);
      if (!areDoc) {
        return { content: [{ type: "text", text: `Area not found: ${area}` }] };
      }

      const are = areDoc as GffObj;
      const areaWidth = getFieldNum(are, "Width");
      const areaHeight = getFieldNum(are, "Height");
      const tileList = getFieldList(are, "Tile_List");
      const tilesetResref = getFieldStr(are, "Tileset").toLowerCase();

      const resmanOpts = await buildResmanOptions(index);
      const tileset = await getTilesetInfo(tilesetResref, resmanOpts, index);

      // Find the group by name (case-insensitive)
      const group = tileset.groups.find((g) => g.name.toLowerCase() === feature.toLowerCase());
      if (!group) {
        const available = tileset.groups.map((g) => `${g.name} (${g.columns}x${g.rows})`).join(", ");
        return { content: [{ type: "text", text: `Group not found: ${feature}. Available: ${available}` }] };
      }

      const baseGrid = buildTileGrid(tileList as GffObj[], areaWidth, areaHeight);
      const candidateTransforms = transformRequest === "random" ? [...GROUP_TRANSFORMS] : [transformRequest];
      const validTransforms: Array<{
        transform: GroupTransform;
        dimensions: TransformedGroupDimensions;
        placements: TransformedGroupPlacement[];
        warnings: string[];
      }> = [];

      for (const candidateTransform of candidateTransforms) {
        const dimensions = getGroupTransformDimensions(group, candidateTransform);
        if (!groupFits(x, y, dimensions, areaWidth, areaHeight)) continue;
        const candidatePlacements = getTransformedGroupPlacements(group, x, y, candidateTransform);
        const candidateGrid = applyGroupPlacementsToGrid(baseGrid, candidatePlacements, areaWidth);
        validTransforms.push({
          transform: candidateTransform,
          dimensions,
          placements: candidatePlacements,
          warnings: collectGroupPlacementWarnings(
            candidatePlacements,
            dimensions,
            candidateGrid,
            areaWidth,
            areaHeight,
            tileset,
          ),
        });
      }

      const selected =
        transformRequest === "random"
          ? (() => {
              const noWarning = validTransforms.filter((candidate) => candidate.warnings.length === 0);
              const pool = noWarning.length > 0 ? noWarning : validTransforms;
              const transform = pickRandomGroupTransform(pool.map((candidate) => candidate.transform));
              return pool.find((candidate) => candidate.transform === transform) ?? pool[0];
            })()
          : validTransforms[0];

      // Check bounds
      if (!selected) {
        const sizes = candidateTransforms
          .map((candidateTransform) => {
            const dimensions = getGroupTransformDimensions(group, candidateTransform);
            return `${candidateTransform}=${dimensions.columns}x${dimensions.rows}`;
          })
          .join(", ");
        return {
          content: [
            {
              type: "text",
              text: `Feature ${feature} doesn't fit at (${x},${y}) in ${areaWidth}x${areaHeight} area with transform '${transformRequest}' (${sizes})`,
            },
          ],
        };
      }

      // Place tiles — group tileIds are transformed as one rigid footprint.
      const placements = selected.placements;
      const warnings = [...selected.warnings];

      for (const p of placements) {
        const areaIdx = p.gy * areaWidth + p.gx;
        const tileEntry = tileList[areaIdx] as GffObj;
        setFieldNum(tileEntry, "Tile_ID", p.tileId, "int");
        setFieldNum(tileEntry, "Tile_Orientation", p.orientation, "int");
        setFieldNum(tileEntry, "Tile_Height", 0, "int");
      }

      // Write back ARE
      const areEntry = index.resources.get(areKey);
      if (areEntry) {
        await jsonToGff(areDoc, areEntry.filePath);
      }

      const nasherSync = await syncNasherSourceForIndex(index, { reason: "paint_group" });

      // Load walkmesh for painted tiles to report material data
      const surfacemat = index.twodaTables.get("surfacemat") as TwoDATable | undefined;
      const wokCacheDir = await ensureWokCacheDir();

      const tileMaterials: Array<{ gx: number; gy: number; dominantMaterial: string; walkablePercent: number }> = [];
      for (const p of placements) {
        const tile = p.tileId < tileset.tiles.length ? tileset.tiles[p.tileId] : null;
        if (tile) {
          try {
            const wok = await getWokForTile(tile.model, resmanOpts, wokCacheDir);
            if (wok) {
              const summary = computeTileWalkSummary(wok, surfacemat);
              tileMaterials.push({
                gx: p.gx,
                gy: p.gy,
                dominantMaterial: summary.dominantMaterial,
                walkablePercent: summary.walkablePercent,
              });
            }
          } catch {
            // Non-fatal
          }
        }
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                success: true,
                area,
                feature: group.name,
                position: { x, y },
                transform: selected.transform,
                size: { columns: selected.dimensions.columns, rows: selected.dimensions.rows },
                tilesPlaced: placements.length,
                tileMaterials,
                warnings,
                ...(nasherSync ? { nasherSync } : {}),
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  // ─── set_area_properties ───────────────────────────────────────────────

  server.tool(
    "set_area_properties",
    "Modify area properties: lighting, fog, music, ambient sounds, weather, skybox, day/night cycle. Music/ambient values are IDs from ambientmusic.2da / ambientsound.2da.",
    {
      area: z.string().describe("Area resref"),
      // Fog
      fogClipDist: z.string().optional().describe("Fog clip distance (float)"),
      sunFogColor: z.string().optional().describe("Sun fog color (dword, RGB packed)"),
      sunFogAmount: z.string().optional().describe("Sun fog amount (0-255)"),
      moonFogColor: z.string().optional().describe("Moon fog color (dword, RGB packed)"),
      moonFogAmount: z.string().optional().describe("Moon fog amount (0-255)"),
      // Lighting
      sunAmbientColor: z.string().optional().describe("Sun ambient color (dword, RGB packed)"),
      sunDiffuseColor: z.string().optional().describe("Sun diffuse color (dword, RGB packed)"),
      moonAmbientColor: z.string().optional().describe("Moon ambient color (dword, RGB packed)"),
      moonDiffuseColor: z.string().optional().describe("Moon diffuse color (dword, RGB packed)"),
      // Sky/weather
      skyBox: z.string().optional().describe("Skybox ID (0=none, 1=grass, etc.)"),
      windPower: z.string().optional().describe("Wind power (0=calm, 1=light, 2=strong)"),
      chanceRain: z.string().optional().describe("Rain chance % (0-100)"),
      chanceSnow: z.string().optional().describe("Snow chance % (0-100)"),
      chanceLightning: z.string().optional().describe("Lightning chance % (0-100)"),
      dayNightCycle: z.boolean().optional().describe("Enable day/night cycle"),
      isNight: z.boolean().optional().describe("Set area to nighttime"),
      // Music (in GIT AreaProperties)
      musicDay: z.string().optional().describe("Day music ID (from ambientmusic.2da)"),
      musicNight: z.string().optional().describe("Night music ID"),
      musicBattle: z.string().optional().describe("Battle music ID"),
      // Ambient sounds (in GIT AreaProperties)
      ambientSndDay: z.string().optional().describe("Day ambient sound ID (from ambientsound.2da)"),
      ambientSndDayVol: z.string().optional().describe("Day ambient volume (0-100)"),
      ambientSndNight: z.string().optional().describe("Night ambient sound ID"),
      ambientSndNightVol: z.string().optional().describe("Night ambient volume (0-100)"),
    },
    { idempotentHint: true },
    async (params) => {
      const index = requireIndex();
      const { area } = params;
      // Parse numeric string params
      const pf = (v: string | undefined) => (v !== undefined ? parseFloat(v) : undefined);
      const pi = (v: string | undefined) => (v !== undefined ? parseInt(v, 10) : undefined);
      const areKey = `${area.toLowerCase()}.are`;
      const gitKey = `${area.toLowerCase()}.git`;

      const areDoc = index.parsedGff.get(areKey);
      const gitDoc = index.parsedGff.get(gitKey);
      if (!areDoc) {
        return { content: [{ type: "text", text: `Area not found: ${area}` }] };
      }

      const are = areDoc as GffObj;
      const changes: string[] = [];

      // Helper to set an ARE field
      const setAre = (fieldName: string, value: number | undefined, gffType: string) => {
        if (value === undefined) return;
        const field = are[fieldName] as { type: string; value: number } | undefined;
        if (field) {
          field.value = value;
        } else {
          are[fieldName] = { type: gffType, value };
        }
        changes.push(`${fieldName} = ${value}`);
      };

      // ARE fields
      setAre("FogClipDist", pf(params.fogClipDist), "float");
      setAre("SunFogColor", pi(params.sunFogColor), "dword");
      setAre("SunFogAmount", pi(params.sunFogAmount), "byte");
      setAre("MoonFogColor", pi(params.moonFogColor), "dword");
      setAre("MoonFogAmount", pi(params.moonFogAmount), "byte");
      setAre("SunAmbientColor", pi(params.sunAmbientColor), "dword");
      setAre("SunDiffuseColor", pi(params.sunDiffuseColor), "dword");
      setAre("MoonAmbientColor", pi(params.moonAmbientColor), "dword");
      setAre("MoonDiffuseColor", pi(params.moonDiffuseColor), "dword");
      setAre("SkyBox", pi(params.skyBox), "byte");
      setAre("WindPower", pi(params.windPower), "int");
      setAre("ChanceRain", pi(params.chanceRain), "int");
      setAre("ChanceSnow", pi(params.chanceSnow), "int");
      setAre("ChanceLightning", pi(params.chanceLightning), "int");
      if (params.dayNightCycle !== undefined) setAre("DayNightCycle", params.dayNightCycle ? 1 : 0, "byte");
      if (params.isNight !== undefined) setAre("IsNight", params.isNight ? 1 : 0, "byte");

      // Write back ARE
      const areEntry = index.resources.get(areKey);
      if (areEntry) {
        await jsonToGff(areDoc, areEntry.filePath);
      }

      // GIT AreaProperties fields
      if (gitDoc) {
        const git = gitDoc as GffObj;
        const apField = git.AreaProperties as { type: string; value: GffObj } | undefined;
        if (apField?.value) {
          const ap = apField.value;
          const setAp = (fieldName: string, value: number | undefined, gffType: string) => {
            if (value === undefined) return;
            const field = ap[fieldName] as { type: string; value: number } | undefined;
            if (field) {
              field.value = value;
            } else {
              ap[fieldName] = { type: gffType, value };
            }
            changes.push(`AreaProperties.${fieldName} = ${value}`);
          };

          setAp("MusicDay", pi(params.musicDay), "int");
          setAp("MusicNight", pi(params.musicNight), "int");
          setAp("MusicBattle", pi(params.musicBattle), "int");
          setAp("AmbientSndDay", pi(params.ambientSndDay), "int");
          setAp("AmbientSndDayVol", pi(params.ambientSndDayVol), "int");
          setAp("AmbientSndNight", pi(params.ambientSndNight), "int");
          setAp("AmbientSndNitVol", pi(params.ambientSndNightVol), "int");

          // Write back GIT
          const gitEntry = index.resources.get(gitKey);
          if (gitEntry) {
            await jsonToGff(gitDoc, gitEntry.filePath);
          }
        }
      }

      if (changes.length === 0) {
        return { content: [{ type: "text", text: "No properties specified to change." }] };
      }

      const nasherSync = await syncNasherSourceForIndex(index, { reason: "set_area_properties" });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                success: true,
                area,
                changes,
                ...(nasherSync ? { nasherSync } : {}),
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );
}
