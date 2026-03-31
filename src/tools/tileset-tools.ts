/**
 * Tileset discovery and area visualization MCP tools.
 *
 * Tools:
 * - list_tilesets: Discover all tilesets available via resman
 * - get_tileset_details: Full details of a tileset (terrains, crossers, groups, tiles)
 * - visualize_area: Spatial awareness JSON payload — tile grid, zones, objects, features
 * - export_area_report: Export single-area HTML visualization to disk (human debugging tool)
 * - export_module_report: Export full module HTML report to disk (human debugging tool)
 *
 * Architecture:
 *   visualize_area returns the canonical JSON spatial payload the LLM uses for reasoning.
 *   export_area_report / export_module_report are downstream HTML renderers for human inspection —
 *   they visualize exactly the same data the LLM sees. The MCP engine never depends on HTML output.
 */

import fs from "fs/promises";
import path from "path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { requireIndex } from "../module-loader.js";
import { buildResmanOptions } from "../module-loader.js";
import { MCP_FOLDER_USERREPORTS } from "../config.js";
import { listAllTilesets, getTilesetInfo, } from "../util/tileset.js";
import { loadAreaWalkmeshData, computeWalkableZones, } from "../util/walkmesh.js";
import type { AreaTransitionInfo } from "../util/walkmesh.js";
import type { ZoneInfo } from "../util/walkmesh.js";
import { buildAreaRenderData, extractAreaObjects } from "../util/area-data.js";
import type { TileRenderData } from "../util/area-data.js";
import { generateHtmlReportSingleArea, generateHtmlReportAllAreas } from "../util/area-html.js";
import type { AreaMapData, DoorLink, CreatureInfo } from "../util/area-html.js";
import { getFieldStr as gffGetStr, getFieldNum as gffGetNum, getFieldLocStr as gffGetLocStr, getFieldList as gffGetList } from "../types/gff.js";
import type { GffObj } from "../types/gff.js";
import type { ModuleIndex } from "../types/module.js";

export function registerTilesetTools(server: McpServer): void {

  // ─── list_tilesets ──────────────────────────────────────────────────────

  server.tool(
    "list_tilesets",
    "List all tilesets available via resman. Returns resref, display name, interior/exterior, terrain types, crosser types, group count, and tile count for each.",
    {},
    async () => {
      const index = requireIndex();
      const resmanOpts = await buildResmanOptions(index);
      const tilesetResrefs = await listAllTilesets(resmanOpts);

      const results: Array<{
        resref: string;
        displayName: string;
        interior: boolean;
        terrainTypes: string[];
        crosserTypes: string[];
        groupCount: number;
        tileCount: number;
      }> = [];

      for (const resref of tilesetResrefs) {
        try {
          const info = await getTilesetInfo(resref, resmanOpts, index);
          results.push({
            resref: info.resref,
            displayName: info.displayName,
            interior: info.interior,
            terrainTypes: info.terrainTypes.map(t => t.name),
            crosserTypes: info.crosserTypes.map(c => c.name),
            groupCount: info.groups.length,
            tileCount: info.tiles.length,
          });
        } catch (e) {
          results.push({
            resref,
            displayName: `(error: ${e instanceof Error ? e.message : e})`,
            interior: false,
            terrainTypes: [],
            crosserTypes: [],
            groupCount: 0,
            tileCount: 0,
          });
        }
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify(results, null, 2),
        }],
      };
    },
  );

  // ─── get_tileset_details ────────────────────────────────────────────────

  server.tool(
    "get_tileset_details",
    "Get full details for a tileset: terrain types, crosser types, primary rules, all groups with dimensions and tile IDs, and a summary of the tile catalog organized by terrain patterns.",
    {
      tileset: z.string().describe("Tileset resref (e.g., 'ttf01' for forest, 'tdc01' for crypt)"),
    },
    async ({ tileset }) => {
      const index = requireIndex();
      const resmanOpts = await buildResmanOptions(index);
      const info = await getTilesetInfo(tileset.toLowerCase(), resmanOpts, index);

      // Organize tiles by terrain corner pattern for easier browsing
      const tilesByPattern = new Map<string, Array<{ id: number; model: string; crossers: string; group: string | null; doorPlacements?: Array<{ x: number; y: number; z: number; orientation: number; type: number }> }>>();
      for (const tile of info.tiles) {
        const c = tile.corners;
        const pattern = `${c.topLeft}/${c.topRight}/${c.bottomLeft}/${c.bottomRight}`;
        const crosserStr = [
          tile.crossers.top ? `T:${tile.crossers.top}` : "",
          tile.crossers.right ? `R:${tile.crossers.right}` : "",
          tile.crossers.bottom ? `B:${tile.crossers.bottom}` : "",
          tile.crossers.left ? `L:${tile.crossers.left}` : "",
        ].filter(Boolean).join(",") || "none";

        if (!tilesByPattern.has(pattern)) tilesByPattern.set(pattern, []);
        const entry: { id: number; model: string; crossers: string; group: string | null; doorPlacements?: Array<{ x: number; y: number; z: number; orientation: number; type: number }> } = {
          id: tile.id,
          model: tile.model,
          crossers: crosserStr,
          group: tile.groupName,
        };
        if (tile.doorPlacements.length > 0) {
          entry.doorPlacements = tile.doorPlacements.map(dp => ({ x: dp.x, y: dp.y, z: dp.z, orientation: dp.orientation, type: dp.type }));
        }
        tilesByPattern.get(pattern)!.push(entry);
      }

      const result = {
        resref: info.resref,
        displayName: info.displayName,
        interior: info.interior,
        hasHeightTransition: info.hasHeightTransition,
        defaultTerrain: info.defaultTerrain,
        terrainTypes: info.terrainTypes,
        crosserTypes: info.crosserTypes,
        // primaryRules/secondaryRules are parsed but NOT used by the tile solver.
        // Tile adjacency is determined entirely by corner terrains, corner heights,
        // and crosser matching on the tile entries themselves.
        groups: info.groups.map(g => ({
          name: g.name,
          rows: g.rows,
          columns: g.columns,
          tileIds: g.tileIds,
        })),
        tileCatalog: Object.fromEntries(
          [...tilesByPattern.entries()].map(([pattern, tiles]) => [pattern, tiles]),
        ),
        totalTiles: info.tiles.length,
      };

      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2),
        }],
      };
    },
  );

  // ─── visualize_area ─────────────────────────────────────────────────────

  server.tool(
    "visualize_area",
    "Get the spatial awareness payload for an area: tile grid with terrain, materials, crossers, walkability, and features; walkable zones with connectivity and area transition analysis; all placed objects (creatures, placeables, doors, waypoints, triggers, encounters, sounds, stores) with world positions and full properties. Use this for spatial reasoning, quest design, object placement, and area analysis. To generate a human-readable HTML visualization, use export_area_report.",
    {
      area: z.string().describe("Area resref (e.g., 'area001')"),
    },
    async ({ area }) => {
      const index = requireIndex();
      const resmanOpts = await buildResmanOptions(index);

      const areDoc = index.parsedGff.get(`${area}.are`);
      if (!areDoc) {
        return { content: [{ type: "text", text: `Error: Area '${area}' not found. Available areas: ${[...index.areas.keys()].join(", ")}` }] };
      }

      const are = areDoc as GffObj;
      const tilesetResref = ((are.Tileset as { value?: string })?.value ?? "").toLowerCase();
      const areaTag = gffGetStr(are, "Tag") || area;

      const tileset = await getTilesetInfo(tilesetResref, resmanOpts, index);
      const walkData = await loadAreaWalkmeshData(area, index, resmanOpts);

      // Build transition data so zones can report which areas they connect to
      const tagToArea = buildTagToAreaMap(index);
      const transitions = buildAreaTransitions(index, area, tagToArea);
      const zones = await computeWalkableZones(area, index, resmanOpts, walkData, transitions);

      const { grid, features, width, height, areaName } = buildAreaRenderData(area, index, tileset, walkData);
      const objects = extractAreaObjects(index, area);

      const payload = serializeAreaPayload(area, areaName, areaTag, width, height, tileset.displayName, grid, features, zones, objects);

      return {
        content: [{
          type: "text",
          text: JSON.stringify(payload, null, 2),
        }],
      };
    },
  );

  // ─── export_area_report ─────────────────────────────────────────────────

  server.tool(
    "export_area_report",
    "Export a self-contained HTML visualization of a single area to disk. This is a human debugging tool that renders the same spatial data returned by visualize_area — tile walkmesh geometry, material colors, object markers, zone connectivity, creature/placeable cards, and area transitions. Returns the file path to open in a browser.",
    {
      area: z.string().describe("Area resref (e.g., 'area001')"),
    },
    async ({ area }) => {
      const index = requireIndex();
      const resmanOpts = await buildResmanOptions(index);

      const areDoc = index.parsedGff.get(`${area}.are`);
      if (!areDoc) {
        return { content: [{ type: "text", text: `Error: Area '${area}' not found. Available areas: ${[...index.areas.keys()].join(", ")}` }] };
      }

      const are = areDoc as GffObj;
      const tilesetResref = ((are.Tileset as { value?: string })?.value ?? "").toLowerCase();
      const areaTag = gffGetStr(are, "Tag") || area;

      const tileset = await getTilesetInfo(tilesetResref, resmanOpts, index);
      const walkData = await loadAreaWalkmeshData(area, index, resmanOpts);
      const tagToArea = buildTagToAreaMap(index);
      const transitions = buildAreaTransitions(index, area, tagToArea);
      const zones = await computeWalkableZones(area, index, resmanOpts, walkData, transitions);
      const { grid, features, width, height, areaName } = buildAreaRenderData(area, index, tileset, walkData);
      const objects = extractAreaObjects(index, area);

      const htmlContent = generateHtmlReportSingleArea({
        resref: area, name: areaName, tag: areaTag, width, height,
        tilesetName: tileset.displayName, grid, features, zones, objects,
      });

      const reportDir = MCP_FOLDER_USERREPORTS || index.tempDir;
      if (MCP_FOLDER_USERREPORTS) await fs.mkdir(MCP_FOLDER_USERREPORTS, { recursive: true });
      const outPath = path.join(reportDir, `area-${area}.html`);
      await fs.writeFile(outPath, htmlContent, "utf8");

      return { content: [{ type: "text", text: `Area report written to: ${outPath}` }] };
    },
  );

  // ─── export_module_report ───────────────────────────────────────────────

  server.tool(
    "export_module_report",
    "Export a self-contained HTML report of the entire module to disk. This is a human debugging tool that visualizes the spatial data for all areas: module summary, area transitions overview, and per-area interactive maps with walkmesh geometry, object markers, creature/placeable cards, and zone connectivity. Writes to module-report.html in the module temp dir. Returns the file path.",
    {},
    async () => {
      const index = requireIndex();
      const resmanOpts = await buildResmanOptions(index);

      const tagToArea = buildTagToAreaMap(index);

      // Gather transitions (doors + triggers with LinkedToFlags=1) per area
      const areaTransitions = new Map<string, AreaTransitionInfo[]>();
      const doorLinks: DoorLink[] = [];
      const seenLinks = new Set<string>();

      for (const [resref] of index.areas) {
        const transitions = buildAreaTransitions(index, resref, tagToArea);
        areaTransitions.set(resref, transitions);

        // Also collect DoorLinks for the module transitions overview
        const gitDoc = index.parsedGff.get(`${resref}.git`);
        if (!gitDoc) continue;
        const git = gitDoc as GffObj;

        for (const door of gffGetList(git, "Door List")) {
          const tag = gffGetStr(door, "Tag");
          const linkedTo = gffGetStr(door, "LinkedTo");
          const linkedToFlags = gffGetNum(door, "LinkedToFlags");
          if (!linkedTo || linkedToFlags !== 1) continue;

          const toArea = tagToArea.get(linkedTo);
          if (!toArea || toArea === resref) continue;

          const key = `${[resref, toArea].sort().join("|")}|${[tag, linkedTo].sort().join("|")}`;
          if (!seenLinks.has(key)) {
            seenLinks.add(key);
            doorLinks.push({
              fromArea: resref, fromTag: tag, toArea, toTag: linkedTo,
              locked: gffGetNum(door, "Locked") === 1,
              keyName: gffGetStr(door, "KeyName"),
              lockDC: gffGetNum(door, "OpenLockDC"),
            });
          }
        }
      }

      // Build map data for each area
      const areaMapDatas: AreaMapData[] = [];
      for (const [resref] of index.areas) {
        const areDoc = index.parsedGff.get(`${resref}.are`);
        if (!areDoc) continue;
        const are = areDoc as GffObj;
        const tilesetResref = ((are.Tileset as { value?: string })?.value ?? "").toLowerCase();

        const tileset = await getTilesetInfo(tilesetResref, resmanOpts, index);
        const walkData = await loadAreaWalkmeshData(resref, index, resmanOpts);
        const zones = await computeWalkableZones(resref, index, resmanOpts, walkData, areaTransitions.get(resref));
        const { grid, features, width, height, areaName } = buildAreaRenderData(resref, index, tileset, walkData);
        const objects = extractAreaObjects(index, resref);
        const areaTag = gffGetStr(are, "Tag") || resref;

        areaMapDatas.push({
          resref, name: areaName, tag: areaTag, width, height,
          tilesetName: tileset.displayName,
          grid, features, zones, objects,
        });
      }

      // Gather creature info
      const creatures: CreatureInfo[] = [];
      for (const [resref] of index.areas) {
        const gitDoc = index.parsedGff.get(`${resref}.git`);
        if (!gitDoc) continue;
        const git = gitDoc as GffObj;
        for (const c of gffGetList(git, "Creature List")) {
          const name = gffGetLocStr(c, "FirstName") || gffGetStr(c, "Tag") || "Unknown";
          const tag = gffGetStr(c, "Tag");
          const cr = gffGetNum(c, "ChallengeRating");
          const hp = gffGetNum(c, "MaxHitPoints") || gffGetNum(c, "HitPoints") || gffGetNum(c, "CurrentHitPoints");
          const factionId = gffGetNum(c, "FactionID");
          const conversation = gffGetStr(c, "Conversation");

          const classList = gffGetList(c, "ClassList");
          const classNames: string[] = [];
          for (const cl of classList) {
            const classId = gffGetNum(cl, "Class");
            const level = gffGetNum(cl, "ClassLevel");
            classNames.push(`class${classId}/lv${level}`);
          }

          creatures.push({
            name, tag, cr, hp,
            classes: classNames.join(", ") || "unknown",
            area: resref,
            hostile: factionId === 1,
            hasDialog: !!conversation,
          });
        }
      }

      const ifoDoc = index.parsedGff.get("module.ifo");
      const moduleName = ifoDoc
        ? (gffGetLocStr(ifoDoc as GffObj, "Mod_Name") || "Unknown Module")
        : "Unknown Module";

      const htmlContent = generateHtmlReportAllAreas({
        moduleName,
        areas: areaMapDatas,
        doorLinks,
        creatures,
        itemCount: index.items.length,
        scriptCount: [...index.resources.values()].filter(r => r.extension === "nss").length,
        dialogCount: [...index.resources.values()].filter(r => r.extension === "dlg").length,
      });

      const reportDir = MCP_FOLDER_USERREPORTS || index.tempDir;
      if (MCP_FOLDER_USERREPORTS) await fs.mkdir(MCP_FOLDER_USERREPORTS, { recursive: true });
      const outPath = path.join(reportDir, "module-report.html");
      await fs.writeFile(outPath, htmlContent, "utf8");

      return { content: [{ type: "text", text: `Module report written to: ${outPath}\n\nOpen this file in a browser to view the interactive report.` }] };
    },
  );
}

// ─── Shared transition helpers ───────────────────────────────────────────────

/** Cached tag→area map, invalidated on module change or GIT mutation */
let cachedTagToArea: Map<string, string> | null = null;
let cachedTagToAreaModPath = "";

/** Invalidate the tag→area cache (call after GIT mutations like place/remove/link) */
export function invalidateTagToAreaCache(): void {
  cachedTagToArea = null;
}

/** Build a tag → area resref lookup for all doors and waypoints across the module (cached) */
export function buildTagToAreaMap(index: ModuleIndex): Map<string, string> {
  if (cachedTagToArea && cachedTagToAreaModPath === index.modPath) return cachedTagToArea;

  const tagToArea = new Map<string, string>();
  for (const [resref] of index.areas) {
    const gitDoc = index.parsedGff.get(`${resref}.git`);
    if (!gitDoc) continue;
    const git = gitDoc as GffObj;
    for (const door of gffGetList(git, "Door List")) {
      const tag = gffGetStr(door, "Tag");
      if (tag) tagToArea.set(tag, resref);
    }
    for (const wp of gffGetList(git, "WaypointList")) {
      const tag = gffGetStr(wp, "Tag");
      if (tag) tagToArea.set(tag, resref);
    }
  }

  cachedTagToArea = tagToArea;
  cachedTagToAreaModPath = index.modPath;
  return tagToArea;
}

/** Get all area transitions (doors with LinkedToFlags=1, triggers with LinkedToFlags=1 or 2) for a single area */
export function buildAreaTransitions(index: ModuleIndex, areaResref: string, tagToArea: Map<string, string>): AreaTransitionInfo[] {
  const gitDoc = index.parsedGff.get(`${areaResref}.git`);
  if (!gitDoc) return [];
  const git = gitDoc as GffObj;
  const transitions: AreaTransitionInfo[] = [];

  for (const door of gffGetList(git, "Door List")) {
    const linkedTo = gffGetStr(door, "LinkedTo");
    const linkedToFlags = gffGetNum(door, "LinkedToFlags");
    if (!linkedTo || linkedToFlags !== 1) continue;
    const toArea = tagToArea.get(linkedTo);
    if (!toArea || toArea === areaResref) continue;
    transitions.push({ x: gffGetNum(door, "X"), y: gffGetNum(door, "Y"), targetArea: toArea });
  }

  for (const trigger of gffGetList(git, "TriggerList")) {
    const linkedTo = gffGetStr(trigger, "LinkedTo");
    const linkedToFlags = gffGetNum(trigger, "LinkedToFlags");
    if (!linkedTo || (linkedToFlags !== 1 && linkedToFlags !== 2)) continue;
    const toArea = tagToArea.get(linkedTo);
    if (!toArea || toArea === areaResref) continue;
    transitions.push({ x: gffGetNum(trigger, "XPosition"), y: gffGetNum(trigger, "YPosition"), targetArea: toArea });
  }

  // Also check placeables with LinkedTo (adventure transition lights)
  for (const plc of gffGetList(git, "Placeable List")) {
    const linkedTo = gffGetStr(plc, "LinkedTo");
    if (!linkedTo) continue;
    const toArea = tagToArea.get(linkedTo);
    if (!toArea || toArea === areaResref) continue;
    transitions.push({ x: gffGetNum(plc, "X"), y: gffGetNum(plc, "Y"), targetArea: toArea });
  }

  return transitions;
}

// ─── Spatial payload serialization ──────────────────────────────────────────

/** Serialize the rich TileRenderData grid to a JSON-safe payload.
 *  - materials Map → percentage Record (drops raw face counts)
 *  - triangles excluded (SVG rendering data, not semantic)
 *  - cornerHeights removed (height solving scoped out)
 */
function serializeAreaPayload(
  resref: string,
  name: string,
  tag: string,
  width: number,
  height: number,
  tilesetName: string,
  grid: TileRenderData[][],
  features: Array<{ name: string; col: number; row: number; cols: number; rows: number }>,
  zones: ZoneInfo[],
  objects: ReturnType<typeof extractAreaObjects>,
) {
  const tileGrid = grid.flat().map(t => {
    // Convert materials Map to percentage object
    const totalFaces = [...t.materials.values()].reduce((a, b) => a + b, 0);
    const materials: Record<string, number> = {};
    for (const [mat, count] of t.materials) {
      materials[mat] = totalFaces > 0 ? Math.round((count / totalFaces) * 100) : 0;
    }

    return {
      col: t.col,
      row: t.row,
      tileId: t.tileId,
      orientation: t.orientation,
      terrain: t.dominantTerrain,
      cornerTerrains: t.cornerTerrains,
      crossers: t.crossers,
      walkablePercent: t.walkablePercent,
      dominantMaterial: t.dominantMaterial,
      materials,
      hasWater: t.hasWater,
      groupName: t.groupName,
      tileModel: t.tileModel,
    };
  });

  const serializedZones = zones.map(z => ({
    id: z.id,
    tileCount: z.tiles.size,
    walkablePercent: z.walkablePercent,
    connected: z.connected,
    description: z.description,
    transitionsOut: z.transitionsOut ?? [],
  }));

  return {
    area: { resref, name, tag, width, height, tileset: tilesetName },
    tileGrid,
    zones: serializedZones,
    features,
    objects,
  };
}
