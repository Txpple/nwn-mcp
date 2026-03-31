/**
 * Area creation and tile painting MCP tools.
 *
 * Tools:
 * - create_area: Create a new area with default terrain tiles
 * - delete_area: Remove an area and its files from the module
 * - paint_terrain: Paint terrain zones + crosser paths (zone-based solver)
 * - paint_tiles: Set exact tile IDs (manual/direct placement)
 * - paint_feature: Place multi-tile groups (temples, lodges, etc.)
 * - set_area_properties: Modify area lighting, music, weather, etc.
 */

import { z } from "zod";
import path from "path";
import fs from "fs/promises";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { requireIndex, buildResmanOptions } from "../module-loader.js";
import { jsonToGff } from "../nim-tools.js";
import { getTilesetInfo } from "../util/tileset.js";
import { getRotatedCorners, getRotatedCrossers } from "../util/tileset.js";
import { validateTilePlacement, findDefaultTile } from "../util/tile-solver.js";
import type { TileGridEntry } from "../util/tile-solver.js";
import { solveArea } from "../util/zone-solver.js";
import type { TerrainZone, CrosserPath, FeatureTile } from "../util/zone-solver.js";
import { getFieldList, getFieldLocStr, getFieldNum, getFieldStr, setFieldNum } from "../types/gff.js";
import type { GffDocument, GffObj } from "../types/gff.js";
import { getWokForTile, computeTileWalkSummary, ensureWokCacheDir } from "../util/walkmesh.js";
import type { TwoDATable } from "../types/module.js";

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
    },
    async ({ resref, name, width: widthStr, height: heightStr, tileset: tilesetResref, defaultTerrain }) => {
      const width = parseInt(widthStr, 10);
      const height = parseInt(heightStr, 10);
      if (isNaN(width) || width < 1 || width > 32) return { content: [{ type: "text", text: "width must be 1-32" }] };
      if (isNaN(height) || height < 1 || height > 32) return { content: [{ type: "text", text: "height must be 1-32" }] };
      const index = requireIndex();
      const resrefLower = resref.toLowerCase();
      const areKey = `${resrefLower}.are`;

      if (index.resources.has(areKey)) {
        return { content: [{ type: "text", text: `Area already exists: ${resrefLower}` }] };
      }

      const resmanOpts = await buildResmanOptions(index);
      const tileset = await getTilesetInfo(tilesetResref.toLowerCase(), resmanOpts, index);

      // Find default tile
      const defaultPlacement = findDefaultTile(tileset, defaultTerrain);
      if (!defaultPlacement) {
        return { content: [{ type: "text", text: `No suitable default tile found for terrain: ${defaultTerrain || tileset.defaultTerrain}` }] };
      }

      // Build Tile_List
      const tileList: GffObj[] = [];
      for (let i = 0; i < width * height; i++) {
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
        "TriggerList": { type: "list", value: [] },
        WaypointList: { type: "list", value: [] },
        "List": { type: "list", value: [] },
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
        "TriggerList": { type: "list", value: [] },
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

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            area: resrefLower,
            name,
            width,
            height,
            tileset: tilesetResref.toLowerCase(),
            defaultTile: {
              tileId: defaultPlacement.tileId,
              orientation: defaultPlacement.orientation,
              terrain: defaultTerrain || tileset.defaultTerrain,
            },
            totalTiles: width * height,
          }, null, 2),
        }],
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
        return { content: [{ type: "text", text: `Cannot delete the module entry area '${areaResref}'. Change Mod_Entry_Area first.` }] };
      }

      const deletedArea = index.areas.get(areaResref)!;
      const areaName = deletedArea.name;

      // Remove from IFO Mod_Area_list
      const areaList = getFieldList(ifoObj, "Mod_Area_list");
      const ifoIdx = areaList.findIndex(a => getFieldStr(a, "Area_Name").toLowerCase() === areaResref);
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
      index.creatures = index.creatures.filter(c => c.area !== areaResref);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            deleted: { resref: areaResref, name: areaName },
            remainingAreas: index.areas.size,
          }, null, 2),
        }],
      };
    },
  );

  // ─── paint_terrain ─────────────────────────────────────────────────────

  server.tool(
    "paint_terrain",
    "Paint terrain zones and crosser paths onto an area. Specify regions of terrain (Water, Trees, etc.) and optional stream/road paths. The system automatically derives all tile assignments including transitions between zones. Feature tiles (placed with paint_feature) are preserved. Re-solves ALL non-feature tiles each call, so pass all zones (not just new ones). Tiles not in any zone get the area's default terrain.",
    {
      area: z.string().describe("Area resref"),
      zones: z.string().describe("JSON array of terrain zones: [{terrain: 'Water', tiles: [{x:0,y:0}, ...]}, ...]. Later zones override earlier at shared boundaries."),
      crossers: z.string().optional().describe("JSON array of crosser paths: [{type: 'Stream', path: [{x:0,y:0, edges:{top:true,bottom:true}}, ...]}]. Each tile specifies which edges carry the crosser."),
    },
    async ({ area, zones: zonesJson, crossers: crossersJson }) => {
      let zones: TerrainZone[];
      let crossers: CrosserPath[] = [];
      try {
        zones = JSON.parse(zonesJson);
        if (!Array.isArray(zones)) throw new Error("zones must be an array");
      } catch (e) {
        return { content: [{ type: "text", text: `Invalid zones JSON: ${e}` }] };
      }
      if (crossersJson) {
        try {
          crossers = JSON.parse(crossersJson);
          if (!Array.isArray(crossers)) throw new Error("crossers must be an array");
        } catch (e) {
          return { content: [{ type: "text", text: `Invalid crossers JSON: ${e}` }] };
        }
      }

      const index = requireIndex();
      const areKey = `${area.toLowerCase()}.are`;
      const areDoc = index.parsedGff.get(areKey);
      if (!areDoc) {
        return { content: [{ type: "text", text: `Area not found: ${area}. Available: ${[...index.areas.keys()].join(", ")}` }] };
      }

      const are = areDoc as GffObj;
      const areaWidth = getFieldNum(are, "Width");
      const areaHeight = getFieldNum(are, "Height");
      const tileList = getFieldList(are, "Tile_List");
      const tilesetResref = getFieldStr(are, "Tileset").toLowerCase();

      const resmanOpts = await buildResmanOptions(index);
      const tileset = await getTilesetInfo(tilesetResref, resmanOpts, index);

      // Detect feature tiles (group tiles already placed by paint_feature)
      const features: FeatureTile[] = [];
      for (let i = 0; i < areaWidth * areaHeight; i++) {
        const entry = tileList[i];
        if (!entry) continue;
        const tileId = getFieldNum(entry, "Tile_ID");
        const tile = tileset.tiles[tileId];
        if (tile && tile.groupId !== null) {
          const x = i % areaWidth;
          const y = Math.floor(i / areaWidth);
          features.push({ x, y, tileId, orientation: getFieldNum(entry, "Tile_Orientation") });
        }
      }

      // Solve the entire area
      const result = solveArea(areaWidth, areaHeight, tileset.defaultTerrain, tileset, zones, crossers, features);

      // Write placements to GFF
      for (const p of result.placements) {
        const idx = p.y * areaWidth + p.x;
        const tileEntry = tileList[idx] as GffObj;
        setFieldNum(tileEntry, "Tile_ID", p.tileId, "int");
        setFieldNum(tileEntry, "Tile_Orientation", p.orientation, "int");
        setFieldNum(tileEntry, "Tile_Height", 0, "int");
      }

      // Write back ARE
      const areEntry = index.resources.get(areKey);
      if (areEntry) {
        await jsonToGff(areDoc, areEntry.filePath);
      }

      // Load walkmesh data for material reporting
      const surfacemat = index.twodaTables.get("surfacemat") as TwoDATable | undefined;
      const wokCacheDir = await ensureWokCacheDir();

      const placementResults: Array<{
        x: number; y: number; tileId: number; orientation: number;
        terrain: string; dominantMaterial: string; walkablePercent: number;
      }> = [];

      for (const p of result.placements) {
        const tile = tileset.tiles[p.tileId];
        let terrainName = "";
        let dominantMaterial = "Unknown";
        let walkablePercent = 0;

        if (tile) {
          const corners = getRotatedCorners(tile, p.orientation);
          const all = [corners.topLeft, corners.topRight, corners.bottomLeft, corners.bottomRight];
          const counts = new Map<string, number>();
          for (const t of all) counts.set(t, (counts.get(t) ?? 0) + 1);
          let best = ""; let max = 0;
          for (const [t, n] of counts) { if (n > max) { max = n; best = t; } }
          terrainName = best;

          try {
            const wok = await getWokForTile(tile.model, resmanOpts, wokCacheDir);
            if (wok) {
              const summary = computeTileWalkSummary(wok, surfacemat);
              dominantMaterial = summary.dominantMaterial;
              walkablePercent = summary.walkablePercent;
            }
          } catch { /* non-fatal */ }
        }

        placementResults.push({
          x: p.x, y: p.y, tileId: p.tileId, orientation: p.orientation,
          terrain: terrainName, dominantMaterial, walkablePercent,
        });
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            area,
            tilesResolved: result.placements.length,
            featuresPreserved: features.length,
            warnings: result.warnings,
            placements: placementResults,
          }, null, 2),
        }],
      };
    },
  );

  // ─── paint_tiles ──────────────────────────────────────────────────────
  // Simplified: exact tile ID placement only (no terrain solver).
  // Use paint_terrain for zone-based terrain painting.

  server.tool(
    "paint_tiles",
    "Set exact tile IDs on specific positions. For manual overrides only — use paint_terrain for terrain zone painting.",
    {
      area: z.string().describe("Area resref"),
      tiles: z.string().describe("JSON array: [{x, y, tileId, orientation?}]"),
    },
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
          results.push({ x, y, tileId, orientation: ori, warnings: [`Out of bounds (area is ${areaWidth}x${areaHeight})`] });
          continue;
        }

        const idx = y * areaWidth + x;
        grid[idx] = { tileId, orientation: ori };

        // Validate against neighbors
        const violations = validateTilePlacement(grid, x, y, areaWidth, areaHeight, tileset);
        if (violations.length > 0) {
          warnings.push(...violations.map(v => `Constraint violation: ${v}`));
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

      return {
        content: [{
          type: "text",
          text: JSON.stringify({ success: true, area, placements: results }, null, 2),
        }],
      };
    },
  );

  // ─── paint_feature ─────────────────────────────────────────────────────

  server.tool(
    "paint_feature",
    "Place a multi-tile group feature (e.g. 'Temple_3x2', 'Lodge_2x2') at a grid position. Validates bounds and edge constraints.",
    {
      area: z.string().describe("Area resref"),
      feature: z.string().describe("Group name (e.g. 'Temple_3x2', 'Lodge_2x2') — use get_tileset_details to see available groups"),
      x: z.string().describe("Bottom-left column of the feature (0-based)"),
      y: z.string().describe("Bottom-left row of the feature (0-based)"),
    },
    async ({ area, feature, x: xStr, y: yStr }) => {
      const x = parseInt(xStr, 10);
      const y = parseInt(yStr, 10);
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
      const group = tileset.groups.find(g => g.name.toLowerCase() === feature.toLowerCase());
      if (!group) {
        const available = tileset.groups.map(g => `${g.name} (${g.columns}x${g.rows})`).join(", ");
        return { content: [{ type: "text", text: `Group not found: ${feature}. Available: ${available}` }] };
      }

      // Check bounds
      if (x < 0 || x + group.columns > areaWidth || y < 0 || y + group.rows > areaHeight) {
        return { content: [{ type: "text", text: `Feature ${feature} (${group.columns}x${group.rows}) doesn't fit at (${x},${y}) in ${areaWidth}x${areaHeight} area` }] };
      }

      // Place tiles — group tileIds are in row-major order, bottom-to-top
      // Group tile index: row * columns + col
      const placements: Array<{ gx: number; gy: number; tileId: number }> = [];
      const warnings: string[] = [];

      for (let gr = 0; gr < group.rows; gr++) {
        for (let gc = 0; gc < group.columns; gc++) {
          const groupTileIdx = gr * group.columns + gc;
          const tileId = group.tileIds[groupTileIdx];
          if (tileId < 0) continue; // empty slot in group

          const gx = x + gc;
          const gy = y + gr;
          const areaIdx = gy * areaWidth + gx;

          // Update tile list
          const tileEntry = tileList[areaIdx] as GffObj;
          setFieldNum(tileEntry, "Tile_ID", tileId, "int");
          setFieldNum(tileEntry, "Tile_Orientation", 0, "int");
          setFieldNum(tileEntry, "Tile_Height", 0, "int");

          placements.push({ gx, gy, tileId });
        }
      }

      // Validate edge tiles against neighbors outside the feature
      const grid: (TileGridEntry | null)[] = [];
      for (let i = 0; i < areaWidth * areaHeight; i++) {
        const entry = tileList[i];
        if (entry) {
          grid.push({
            tileId: getFieldNum(entry, "Tile_ID"),
            orientation: getFieldNum(entry, "Tile_Orientation"),
          });
        } else {
          grid.push(null);
        }
      }

      for (const p of placements) {
        // Only check edges that border non-feature tiles
        const isEdge = p.gx === x || p.gx === x + group.columns - 1 || p.gy === y || p.gy === y + group.rows - 1;
        if (isEdge) {
          const violations = validateTilePlacement(grid, p.gx, p.gy, areaWidth, areaHeight, tileset);
          if (violations.length > 0) {
            warnings.push(`(${p.gx},${p.gy}): ${violations.join("; ")}`);
          }
        }
      }

      // Write back ARE
      const areEntry = index.resources.get(areKey);
      if (areEntry) {
        await jsonToGff(areDoc, areEntry.filePath);
      }

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
              tileMaterials.push({ gx: p.gx, gy: p.gy, dominantMaterial: summary.dominantMaterial, walkablePercent: summary.walkablePercent });
            }
          } catch {
            // Non-fatal
          }
        }
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            area,
            feature: group.name,
            position: { x, y },
            size: { columns: group.columns, rows: group.rows },
            tilesPlaced: placements.length,
            tileMaterials,
            warnings,
          }, null, 2),
        }],
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
    async (params) => {
      const index = requireIndex();
      const { area } = params;
      // Parse numeric string params
      const pf = (v: string | undefined) => v !== undefined ? parseFloat(v) : undefined;
      const pi = (v: string | undefined) => v !== undefined ? parseInt(v, 10) : undefined;
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

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            area,
            changes,
          }, null, 2),
        }],
      };
    },
  );
}
