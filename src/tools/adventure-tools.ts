/**
 * Adventure creator MCP tools.
 *
 * Tools specific to the /create-adventure pipeline and autonomous module building.
 * These are separated from base tools to keep the two visions distinct:
 *   (a) Human-orchestrated editing — base tools
 *   (b) AI-driven adventure creation — this file
 *
 * Tools:
 * - adventure_create_transition: One-way portal (blue light → waypoint) with VFX
 * - adventure_find_walkable: Find guaranteed walkable coordinates in an area region
 * - adventure_generate_layout: Procedural layout generation (BSP rooms, corridors, features)
 * - adventure_apply_layout: Atomic application of a full layout (zones + crossers + features)
 * - adventure_list_features: List solver-compatible feature groups for a tileset + terrain
 */

import { z } from "zod";
import path from "path";
import fsPromises from "fs/promises";

import { numParam, optNumParam, toF, toI } from "../util/params.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { requireIndex, buildResmanOptions } from "../module-loader.js";
import { GIT_STRUCT_ID } from "../config.js";
import { resolveBlueprint, getGitDoc, writeBackGit, updateAreaCounts } from "../util/git-helpers.js";
import { getFieldStr, getFieldNum, getFieldList, setField, setFieldNum } from "../types/gff.js";
import type { GffObj, GffDocument } from "../types/gff.js";
import { snapshotGitForUndo } from "../util/undo.js";
import { compileScript, jsonToGff, erfPack } from "../nim-tools.js";
import { checkPlacementWalkable } from "../util/walkmesh.js";
import { getTilesetInfo } from "../util/tileset.js";
import { generateLayout, groupHasUnsupportedDoors, groupHasCrossers, groupMatchesTerrain, resolveFloorTerrain } from "../util/layout-generator.js";
import type { LayoutStyle, SuggestedFeature } from "../util/layout-generator.js";
import { solveArea } from "../util/zone-solver.js";
import type { TerrainZone, CrosserPath, FeatureTile } from "../util/zone-solver.js";

export function registerAdventureTools(server: McpServer): void {

  // ─── adventure_create_transition ───────────────────────────────────────

  server.tool(
    "adventure_create_transition",
    "Create a one-way area transition for adventure modules: places a useable blue shaft of light (plc_solblue) in the source area and a waypoint in the target area. The light's OnUsed script plays VFX_FNF_SUMMON_MONSTER_2, then jumps the PC to the destination waypoint after 2 seconds. For two-way transitions, call twice with swapped source/target.",
    {
      sourceArea: z.string().describe("Area resref where the blue light is placed"),
      sourceX: numParam("Light X position in source area"),
      sourceY: numParam("Light Y position in source area"),
      sourceZ: optNumParam("Light Z position (default: walkmesh height)"),
      targetArea: z.string().describe("Area resref where the waypoint is placed"),
      targetX: numParam("Waypoint X position in target area"),
      targetY: numParam("Waypoint Y position in target area"),
      targetZ: optNumParam("Waypoint Z position (default: walkmesh height)"),
      tag: z.string().describe("Base tag for naming. Max 11 chars. Light tag = 'at_<tag>', waypoint tag = 'wp_<tag>', script resref = 'a_at_<tag>' (16-char limit)."),
    },
    async ({ sourceArea, sourceX, sourceY, sourceZ, targetArea, targetX, targetY, targetZ, tag }) => {
      const sxN = toF(sourceX), syN = toF(sourceY), szN = toF(sourceZ);
      const txN = toF(targetX), tyN = toF(targetY), tzN = toF(targetZ);
      const index = requireIndex();
      const resmanOpts = await buildResmanOptions(index);

      // Walkmesh validation for both positions
      const srcWalk = await checkPlacementWalkable(sxN, syN, sourceArea.toLowerCase(), index, resmanOpts);
      if (!srcWalk.ok) {
        return { content: [{ type: "text", text: JSON.stringify({ error: "Source position not safe", area: sourceArea, position: { x: sxN, y: syN }, detail: srcWalk.reason }, null, 2) }] };
      }
      const tgtWalk = await checkPlacementWalkable(txN, tyN, targetArea.toLowerCase(), index, resmanOpts);
      if (!tgtWalk.ok) {
        return { content: [{ type: "text", text: JSON.stringify({ error: "Target position not safe", area: targetArea, position: { x: txN, y: tyN }, detail: tgtWalk.reason }, null, 2) }] };
      }

      const lightTag = `at_${tag}`.substring(0, 32);
      const wpTag = `wp_${tag}`.substring(0, 32);
      const scriptResref = `a_at_${tag}`.substring(0, 16);
      const dlgResref = `d_at_${tag}`.substring(0, 16);

      // 1. Write transition script with VFX + delayed jump
      const scriptSource = [
        "void main() {",
        "    object oPC = GetPCSpeaker();",
        "    if (!GetIsPC(oPC)) return;",
        `    object oWP = GetWaypointByTag("${wpTag}");`,
        "    ApplyEffectToObject(DURATION_TYPE_INSTANT, EffectVisualEffect(VFX_FNF_SUMMON_MONSTER_2), oPC);",
        "    DelayCommand(2.0, AssignCommand(oPC, JumpToObject(oWP)));",
        "}",
      ].join("\n");

      const nssPath = path.join(index.tempDir, `${scriptResref}.nss`);
      await fsPromises.writeFile(nssPath, scriptSource, "utf-8");
      const nssStat = await fsPromises.stat(nssPath);
      index.resources.set(`${scriptResref}.nss`, { resref: scriptResref, extension: "nss", filePath: nssPath, sizeBytes: nssStat.size });

      const ncsPath = nssPath.replace(/\.nss$/i, ".ncs");
      const compResult = await compileScript(nssPath, ncsPath, { resman: resmanOpts });
      if (compResult.success) {
        try {
          const ncsStat = await fsPromises.stat(ncsPath);
          index.resources.set(`${scriptResref}.ncs`, { resref: scriptResref, extension: "ncs", filePath: ncsPath, sizeBytes: ncsStat.size });
        } catch { /* ncs may not exist if compiler mocked */ }
      }

      // 2. Create dialog: NPC asks "Enter the portal?", PC chooses yes (fires script) or no
      const dlgDoc: GffDocument = {
        __data_type: "DLG ",
        DelayEntry: { type: "dword", value: 0 },
        DelayReply: { type: "dword", value: 0 },
        EndConverAbort: { type: "resref", value: "" },
        EndConversation: { type: "resref", value: "" },
        NumWords: { type: "dword", value: 0 },
        PreventZoomIn: { type: "byte", value: 1 },
        StartingList: { type: "list", value: [
          { __struct_id: 0, Index: { type: "dword", value: 0 }, Active: { type: "resref", value: "" }, IsChild: { type: "byte", value: 0 } },
        ]},
        EntryList: { type: "list", value: [
          // Entry 0: NPC prompt
          {
            __struct_id: 0,
            Animation: { type: "dword", value: 0 },
            AnimLoop: { type: "byte", value: 1 },
            Comment: { type: "cexostring", value: "" },
            Delay: { type: "dword", value: 4294967295 },
            Quest: { type: "cexostring", value: "" },
            Script: { type: "resref", value: "" },
            Sound: { type: "resref", value: "" },
            Speaker: { type: "cexostring", value: "" },
            Text: { type: "cexolocstring", value: { "0": "A shimmering portal beckons you forward. Do you wish to step through?" } },
            RepliesList: { type: "list", value: [
              { __struct_id: 0, Index: { type: "dword", value: 0 }, Active: { type: "resref", value: "" }, IsChild: { type: "byte", value: 0 } },
              { __struct_id: 0, Index: { type: "dword", value: 1 }, Active: { type: "resref", value: "" }, IsChild: { type: "byte", value: 0 } },
            ]},
          },
        ]},
        ReplyList: { type: "list", value: [
          // Reply 0: Yes — fires transition script
          {
            __struct_id: 0,
            Animation: { type: "dword", value: 0 },
            AnimLoop: { type: "byte", value: 1 },
            Comment: { type: "cexostring", value: "" },
            Delay: { type: "dword", value: 4294967295 },
            Quest: { type: "cexostring", value: "" },
            Script: { type: "resref", value: scriptResref },
            Sound: { type: "resref", value: "" },
            Text: { type: "cexolocstring", value: { "0": "[Step through the portal]" } },
            EntriesList: { type: "list", value: [] },
          },
          // Reply 1: No — ends conversation
          {
            __struct_id: 0,
            Animation: { type: "dword", value: 0 },
            AnimLoop: { type: "byte", value: 1 },
            Comment: { type: "cexostring", value: "" },
            Delay: { type: "dword", value: 4294967295 },
            Quest: { type: "cexostring", value: "" },
            Script: { type: "resref", value: "" },
            Sound: { type: "resref", value: "" },
            Text: { type: "cexolocstring", value: { "0": "[Turn away]" } },
            EntriesList: { type: "list", value: [] },
          },
        ]},
      };

      const dlgPath = path.join(index.tempDir, `${dlgResref}.dlg`);
      await jsonToGff(dlgDoc, dlgPath);
      const dlgStat = await fsPromises.stat(dlgPath);
      index.resources.set(`${dlgResref}.dlg`, { resref: dlgResref, extension: "dlg", filePath: dlgPath, sizeBytes: dlgStat.size });
      index.parsedGff.set(`${dlgResref}.dlg`, dlgDoc);

      // 3. Place waypoint in target area
      const waypoint: GffObj = {
        __struct_id: GIT_STRUCT_ID.WAYPOINT,
        Appearance: { type: "byte", value: 1 },
        Description: { type: "cexolocstring", value: {} },
        HasMapNote: { type: "byte", value: 0 },
        LinkedTo: { type: "cexostring", value: "" },
        LocalizedName: { type: "cexolocstring", value: { "0": `Transition: ${tag}` } },
        MapNote: { type: "cexolocstring", value: {} },
        MapNoteEnabled: { type: "byte", value: 0 },
        Tag: { type: "cexostring", value: wpTag },
        TemplateResRef: { type: "resref", value: "" },
        XPosition: { type: "float", value: txN },
        YPosition: { type: "float", value: tyN },
        ZPosition: { type: "float", value: tgtWalk.z ?? tzN },
        XOrientation: { type: "float", value: 0 },
        YOrientation: { type: "float", value: 1 },
      };

      const { doc: targetGitDoc, obj: targetGit } = getGitDoc(index, targetArea);
      snapshotGitForUndo(targetGitDoc, targetArea, "adventure_create_transition", `Place waypoint ${wpTag}`);
      const wpList = getFieldList(targetGit, "WaypointList");
      wpList.push(waypoint);
      await writeBackGit(index, targetArea, targetGitDoc);
      updateAreaCounts(index, targetArea);

      // 4. Place useable blue shaft of light in source area
      const plcBlueprint = await resolveBlueprint(index, "plc_solblue", "utp", resmanOpts);
      let lightObj: GffObj;
      if (plcBlueprint) {
        lightObj = plcBlueprint as GffObj;
        delete lightObj.__data_type;
      } else {
        lightObj = {};
      }
      lightObj.__struct_id = GIT_STRUCT_ID.PLACEABLE;
      setField(lightObj, "Tag", "cexostring", lightTag);
      setField(lightObj, "TemplateResRef", "resref", "");
      // Placeables use LocName (not LocalizedName) for display name
      lightObj.LocName = { type: "cexolocstring", value: { "0": "Area Transition" } };
      lightObj.LocalizedName = { type: "cexolocstring", value: { "0": "Area Transition" } };
      lightObj.X = { type: "float", value: sxN };
      lightObj.Y = { type: "float", value: syN };
      lightObj.Z = { type: "float", value: srcWalk.z ?? szN };
      lightObj.Bearing = { type: "float", value: 0 };

      // Make it interactive — plot, useable, not static
      setField(lightObj, "Static", "byte", 0);
      setField(lightObj, "Useable", "byte", 1);
      setField(lightObj, "Conversation", "resref", dlgResref);
      setField(lightObj, "HasInventory", "byte", 0);
      setField(lightObj, "Plot", "byte", 1);

      // OnUsed script that begins the conversation
      const onUsedResref = `u_at_${tag}`.substring(0, 16);
      const onUsedSource = [
        "void main() {",
        `    BeginConversation("${dlgResref}", GetLastUsedBy());`,
        "}",
      ].join("\n");
      const onUsedNssPath = path.join(index.tempDir, `${onUsedResref}.nss`);
      await fsPromises.writeFile(onUsedNssPath, onUsedSource, "utf-8");
      const onUsedStat = await fsPromises.stat(onUsedNssPath);
      index.resources.set(`${onUsedResref}.nss`, { resref: onUsedResref, extension: "nss", filePath: onUsedNssPath, sizeBytes: onUsedStat.size });
      const onUsedNcsPath = onUsedNssPath.replace(/\.nss$/i, ".ncs");
      const onUsedComp = await compileScript(onUsedNssPath, onUsedNcsPath, { resman: resmanOpts });
      if (onUsedComp.success) {
        try {
          const ncsStat = await fsPromises.stat(onUsedNcsPath);
          index.resources.set(`${onUsedResref}.ncs`, { resref: onUsedResref, extension: "ncs", filePath: onUsedNcsPath, sizeBytes: ncsStat.size });
        } catch { /* ncs may not exist if compiler mocked */ }
      }
      setField(lightObj, "OnUsed", "resref", onUsedResref);

      // Set LinkedTo metadata for connectivity checks
      setField(lightObj, "LinkedTo", "cexostring", wpTag);

      const { doc: sourceGitDoc, obj: sourceGit } = getGitDoc(index, sourceArea);
      snapshotGitForUndo(sourceGitDoc, sourceArea, "adventure_create_transition", `Place light ${lightTag}`);
      const placeableList = getFieldList(sourceGit, "Placeable List");
      placeableList.push(lightObj);
      await writeBackGit(index, sourceArea, sourceGitDoc);
      updateAreaCounts(index, sourceArea);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            transition: {
              source: { area: sourceArea, lightTag, position: { x: sxN, y: syN, z: srcWalk.z ?? szN } },
              target: { area: targetArea, waypointTag: wpTag, position: { x: txN, y: tyN, z: tgtWalk.z ?? tzN } },
              dialog: dlgResref,
              script: scriptResref,
              compiled: compResult.success,
              ...(compResult.success ? {} : { compilerOutput: compResult.output }),
            },
          }, null, 2),
        }],
      };
    },
  );

  // ─── adventure_find_walkable ────────────────────────────────────────────

  server.tool(
    "adventure_find_walkable",
    "Find guaranteed walkable coordinates in an area. Returns positions validated against the walkmesh with correct Z height. Use region to constrain the search to a part of the area.",
    {
      area: z.string().describe("Area resref"),
      region: z.string().optional().describe("Region to search: 'north', 'south', 'east', 'west', 'center', 'NE', 'NW', 'SE', 'SW', or a bounding box 'x1,y1,x2,y2' in world coordinates. Defaults to 'center'."),
      count: z.string().optional().describe("Number of positions to return (default 1, max 10)"),
      avoidEdges: z.string().optional().describe("If 'true' (default), uses 2m buffer from non-walkable surfaces instead of 1m"),
    },
    { readOnlyHint: true, idempotentHint: true },
    async ({ area, region, count: countStr, avoidEdges }) => {
      const index = requireIndex();
      const areKey = `${area.toLowerCase()}.are`;
      const areDoc = index.parsedGff.get(areKey);
      if (!areDoc) {
        return { content: [{ type: "text", text: `Area not found: ${area}. Available: ${[...index.areas.keys()].join(", ")}` }] };
      }
      const are = areDoc as GffObj;
      const areaWidth = getFieldNum(are, "Width");
      const areaHeight = getFieldNum(are, "Height");
      const worldW = areaWidth * 10;
      const worldH = areaHeight * 10;

      const maxCount = Math.min(Math.max(1, countStr ? toI(countStr) : 1), 10);
      const resmanOpts = await buildResmanOptions(index);

      // Parse region into a bounding box (world coordinates)
      let x1: number, y1: number, x2: number, y2: number;
      const reg = (region ?? "center").toLowerCase().trim();

      if (reg.includes(",")) {
        // Explicit bounding box: x1,y1,x2,y2
        const parts = reg.split(",").map(Number);
        if (parts.length !== 4 || parts.some(isNaN)) {
          return { content: [{ type: "text", text: "Invalid bounding box. Use 'x1,y1,x2,y2' format." }] };
        }
        [x1, y1, x2, y2] = parts;
      } else {
        // Named region — divide area into thirds
        const thirdW = worldW / 3;
        const thirdH = worldH / 3;
        switch (reg) {
          case "north":  x1 = thirdW; y1 = thirdH * 2; x2 = thirdW * 2; y2 = worldH; break;
          case "south":  x1 = thirdW; y1 = 0; x2 = thirdW * 2; y2 = thirdH; break;
          case "east":   x1 = thirdW * 2; y1 = thirdH; x2 = worldW; y2 = thirdH * 2; break;
          case "west":   x1 = 0; y1 = thirdH; x2 = thirdW; y2 = thirdH * 2; break;
          case "center": x1 = thirdW; y1 = thirdH; x2 = thirdW * 2; y2 = thirdH * 2; break;
          case "ne":     x1 = thirdW * 2; y1 = thirdH * 2; x2 = worldW; y2 = worldH; break;
          case "nw":     x1 = 0; y1 = thirdH * 2; x2 = thirdW; y2 = worldH; break;
          case "se":     x1 = thirdW * 2; y1 = 0; x2 = worldW; y2 = thirdH; break;
          case "sw":     x1 = 0; y1 = 0; x2 = thirdW; y2 = thirdH; break;
          default:
            return { content: [{ type: "text", text: `Unknown region '${reg}'. Use north/south/east/west/center/NE/NW/SE/SW or x1,y1,x2,y2.` }] };
        }
      }

      // Clamp to area bounds (leave 1 tile margin from edges)
      x1 = Math.max(x1, 10); y1 = Math.max(y1, 10);
      x2 = Math.min(x2, worldW - 10); y2 = Math.min(y2, worldH - 10);

      if (x1 >= x2 || y1 >= y2) {
        return { content: [{ type: "text", text: "Region is too small or outside area bounds after clamping." }] };
      }

      // Scan tile centers in the region, test each for walkability
      const positions: Array<{ x: number; y: number; z: number }> = [];
      const startCol = Math.floor(x1 / 10);
      const endCol = Math.ceil(x2 / 10);
      const startRow = Math.floor(y1 / 10);
      const endRow = Math.ceil(y2 / 10);

      // Spiral from center of region outward for best positions
      const centerX = (x1 + x2) / 2;
      const centerY = (y1 + y2) / 2;

      // Build candidate list sorted by distance from region center
      const candidates: Array<{ x: number; y: number }> = [];
      for (let col = startCol; col < endCol; col++) {
        for (let row = startRow; row < endRow; row++) {
          const wx = col * 10 + 5;
          const wy = row * 10 + 5;
          if (wx >= x1 && wx <= x2 && wy >= y1 && wy <= y2) {
            candidates.push({ x: wx, y: wy });
          }
        }
      }
      candidates.sort((a, b) => {
        const da = (a.x - centerX) ** 2 + (a.y - centerY) ** 2;
        const db = (b.x - centerX) ** 2 + (b.y - centerY) ** 2;
        return da - db;
      });

      // Collect ALL walkable candidates, then sort by Z descending (prefer
      // higher ground — avoids returning depressed terrain like tree roots
      // when clearings at Z~0 are also available in the region)
      const allWalkable: Array<{ x: number; y: number; z: number }> = [];
      for (const { x, y } of candidates) {
        const check = await checkPlacementWalkable(x, y, area.toLowerCase(), index, resmanOpts);
        if (check.ok) {
          allWalkable.push({ x, y, z: check.z ?? 0 });
        }
      }
      allWalkable.sort((a, b) => b.z - a.z);
      for (const pos of allWalkable) {
        if (positions.length >= maxCount) break;
        positions.push(pos);
      }

      if (positions.length === 0) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              error: "No walkable positions found in region",
              area,
              region: reg,
              searchBounds: { x1, y1, x2, y2 },
              candidatesTested: candidates.length,
            }, null, 2),
          }],
        };
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            area,
            region: reg,
            positions,
            searchBounds: { x1, y1, x2, y2 },
            candidatesTested: candidates.length,
          }, null, 2),
        }],
      };
    },
  );

  // ─── adventure_generate_layout ──────────────────────────────────────────────

  server.tool(
    "adventure_generate_layout",
    "Generate a procedural area layout with terrain zones, crosser paths, and transition points. Returns data ready to pass to adventure_apply_layout. Encodes all layout rules: perimeter encapsulation, room separation, adjacency validation, walkable ratio. Styles: dungeon (varied rooms + corridors, some L-shapes), cave (smaller rooms, more corridors, maze-like), dwelling (quadrant rooms, fewer corridors, building interior), forest (clearings separated by trees, winding roads), rural (farmland/village, spine roads), city (urban cobblestone, grid roads), plains (open terrain, sparse clearings), desert (arid, cliff borders), castle (fortified exterior, castle walls), tundra (frozen, snow/camp clearings). Returns suggestedFeatures array with pre-validated feature placements.",
    {
      tileset: z.string().describe("Tileset resref (e.g., 'tdc01' for crypt, 'ttf01' for forest)"),
      width: z.string().describe("Area width in tiles (8-32)"),
      height: z.string().describe("Area height in tiles (8-32)"),
      style: z.string().describe("JSON style object: {type: 'dungeon'|'cave'|'dwelling'|'forest'|'rural'|'city'|'plains'|'desert'|'castle'|'tundra', rooms?: number, clearings?: number, corridorStyle?: 'straight'|'zigzag', roadStyle?: 'spine'|'grid'|'winding', preferredFeatures?: string[]} — preferredFeatures is an array of tileset group names (from get_tileset_details) to prioritize when placing features. Preferred groups are tried first before falling back to random selection."),
      transitionCount: z.string().optional().describe("Number of transition points to generate (default 1)"),
      transitionDirections: z.string().optional().describe("JSON array of directions: ['south', 'north', 'east', 'west']"),
    },
    { readOnlyHint: true, idempotentHint: true },
    async ({ tileset: tilesetResref, width: widthStr, height: heightStr, style: styleJson, transitionCount: tcStr, transitionDirections: tdJson }) => {
      const w = toI(widthStr);
      const h = toI(heightStr);

      if (w < 4 || w > 32 || h < 4 || h > 32) {
        return { content: [{ type: "text", text: "Width and height must be between 4 and 32." }] };
      }

      let styleObj: LayoutStyle;
      try {
        styleObj = JSON.parse(styleJson);
      } catch (e) {
        return { content: [{ type: "text", text: `Invalid style JSON: ${e}` }] };
      }

      const tc = tcStr ? toI(tcStr) : undefined;
      let td: string[] | undefined;
      if (tdJson) {
        try {
          td = JSON.parse(tdJson);
          if (!Array.isArray(td)) throw new Error("must be array");
        } catch (e) {
          return { content: [{ type: "text", text: `Invalid transitionDirections JSON: ${e}` }] };
        }
      }

      const index = requireIndex();
      const resmanOpts = await buildResmanOptions(index);
      const tileset = await getTilesetInfo(tilesetResref.toLowerCase(), resmanOpts, index);

      const result = generateLayout(tileset, w, h, styleObj, tc, td);

      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2),
        }],
      };
    },
  );

  // ─── adventure_apply_layout ──────────────────────────────────────────────────────

  server.tool(
    "adventure_apply_layout",
    "Apply a complete area layout atomically. Takes the full output of adventure_generate_layout (zones, crossers, suggestedFeatures) and paints everything in one call — terrain zones via the zone solver, crosser paths, and multi-tile feature groups.",
    {
      area: z.string().describe("Area resref"),
      layout: z.string().describe("JSON LayoutResult from adventure_generate_layout. Must contain zones, crossers, and suggestedFeatures arrays."),
      autoRepack: z.string().optional().describe("If 'true', automatically repacks the module after painting."),
    },
    { idempotentHint: true },
    async ({ area, layout: layoutJson, autoRepack: autoRepackStr }) => {
      const shouldRepack = autoRepackStr?.toLowerCase() === "true";

      // Parse the layout result
      let zones: TerrainZone[];
      let crossers: CrosserPath[];
      let suggestedFeatures: SuggestedFeature[];
      try {
        const layout = JSON.parse(layoutJson);
        zones = layout.zones ?? [];
        crossers = layout.crossers ?? [];
        suggestedFeatures = layout.suggestedFeatures ?? [];
        if (!Array.isArray(zones)) throw new Error("zones must be an array");
        if (!Array.isArray(crossers)) throw new Error("crossers must be an array");
        if (!Array.isArray(suggestedFeatures)) throw new Error("suggestedFeatures must be an array");
      } catch (e) {
        return { content: [{ type: "text", text: `Invalid layout JSON: ${e}` }] };
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

      // Resolve suggestedFeatures → FeatureTile[]
      const featureTiles: FeatureTile[] = [];
      const featureWarnings: string[] = [];
      const featureGroups: string[] = [];

      // Build a tile→terrain lookup from zones for per-feature floor terrain resolution
      const tileTerrainMap = new Map<string, string>();
      for (const z of zones as TerrainZone[]) {
        for (const t of z.tiles) {
          tileTerrainMap.set(`${t.x},${t.y}`, z.terrain.toLowerCase());
        }
      }

      for (const sf of suggestedFeatures) {
        const group = tileset.groups.find(g => g.name.toLowerCase() === sf.feature.toLowerCase());
        if (!group) {
          featureWarnings.push(`Group not found: ${sf.feature}`);
          continue;
        }
        // Determine the floor terrain from the zone this feature sits in
        const featureFloor = tileTerrainMap.get(`${sf.x},${sf.y}`) ?? tileset.defaultTerrain.toLowerCase();
        // Reject groups whose door tiles sit on terrain transitions or crosser edges
        if (groupHasUnsupportedDoors(group, tileset, featureFloor)) {
          featureWarnings.push(`${sf.feature}: skipped (door tiles on terrain transition or crosser edge)`);
          continue;
        }
        // Reject groups that contain crosser references — crossers on feature tiles
        // conflict with the solver's crosser grid and create edge mismatches
        const hasCrossers = group.tileIds.some(id => {
          if (id < 0) return false;
          const t = tileset.tiles[id];
          return t && !!(t.crossers.top || t.crossers.right || t.crossers.bottom || t.crossers.left);
        });
        if (hasCrossers) {
          featureWarnings.push(`${sf.feature}: skipped (contains crosser tiles — causes edge mismatches)`);
          continue;
        }
        // Reject groups whose tile corners don't match the surrounding zone terrain.
        // Look up what terrain the zone solver will paint at this position.
        const featureZoneTerrain = (() => {
          // Last zone covering this position wins (zones apply in order)
          let terrain = "";
          for (const z of zones) {
            if (z.tiles.some((t: { x: number; y: number }) => t.x === sf.x && t.y === sf.y)) {
              terrain = z.terrain.toLowerCase();
            }
          }
          return terrain;
        })();
        if (featureZoneTerrain) {
          const terrainMismatch = group.tileIds.some(id => {
            if (id < 0) return false;
            const t = tileset.tiles[id];
            if (!t) return false;
            return t.corners.topLeft.toLowerCase() !== featureZoneTerrain ||
                   t.corners.topRight.toLowerCase() !== featureZoneTerrain ||
                   t.corners.bottomLeft.toLowerCase() !== featureZoneTerrain ||
                   t.corners.bottomRight.toLowerCase() !== featureZoneTerrain;
          });
          if (terrainMismatch) {
            featureWarnings.push(`${sf.feature}: skipped (tile corners don't match zone terrain '${featureZoneTerrain}')`);
            continue;
          }
        }
        // Validate dimensions match
        if (sf.columns !== group.columns || sf.rows !== group.rows) {
          featureWarnings.push(`${sf.feature}: layout says ${sf.columns}x${sf.rows} but tileset group is ${group.columns}x${group.rows}`);
          continue;
        }
        // Validate bounds
        if (sf.x < 0 || sf.x + group.columns > areaWidth || sf.y < 0 || sf.y + group.rows > areaHeight) {
          featureWarnings.push(`${sf.feature} at (${sf.x},${sf.y}) out of bounds for ${areaWidth}x${areaHeight} area`);
          continue;
        }
        // Resolve group tiles (row-major, bottom-to-top, orientation 0)
        for (let gr = 0; gr < group.rows; gr++) {
          for (let gc = 0; gc < group.columns; gc++) {
            const tileId = group.tileIds[gr * group.columns + gc];
            if (tileId < 0) continue; // empty slot
            featureTiles.push({ x: sf.x + gc, y: sf.y + gr, tileId, orientation: 0 });
          }
        }
        featureGroups.push(sf.feature);
      }

      // Solve terrain with features locked in
      const result = solveArea(areaWidth, areaHeight, tileset.defaultTerrain, tileset, zones, crossers, featureTiles);

      // Write feature tiles to GFF
      for (const ft of featureTiles) {
        const idx = ft.y * areaWidth + ft.x;
        const tileEntry = tileList[idx] as GffObj;
        setFieldNum(tileEntry, "Tile_ID", ft.tileId, "int");
        setFieldNum(tileEntry, "Tile_Orientation", ft.orientation, "int");
        setFieldNum(tileEntry, "Tile_Height", 0, "int");
      }

      // Write solver placements to GFF
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

      // Auto-repack if requested
      let repacked = false;
      if (shouldRepack) {
        try {
          const modPath = index.modPath;
          if (modPath) {
            await erfPack(index.tempDir, modPath);
            repacked = true;
          }
        } catch { /* non-fatal */ }
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            area,
            tilesResolved: result.placements.length,
            featuresPlaced: featureTiles.length,
            featureGroups,
            ...(featureWarnings.length > 0 ? { featureWarnings } : {}),
            ...(result.warnings.length > 0 ? { solverWarnings: result.warnings } : {}),
            ...(shouldRepack ? { repacked } : {}),
          }, null, 2),
        }],
      };
    },
  );

  // ─── adventure_list_features ──────────────────────────────────────────

  server.tool(
    "adventure_list_features",
    "List feature groups from a tileset that are compatible with the layout solver. Automatically resolves the floor terrain from the style type (same logic as adventure_generate_layout), then filters out groups with doors, crosser edges, or mismatched terrain corners. Returns only groups safe to pass as preferredFeatures.",
    {
      tileset: z.string().describe("Tileset resref (e.g., 'ttr01', 'tdm01')"),
      style: z.string().describe("Layout style type: dungeon, cave, dwelling, forest, rural, city, plains, desert, castle, tundra"),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async ({ tileset: tilesetResref, style }) => {
      const index = requireIndex();
      const resmanOpts = await buildResmanOptions(index);
      const tilesetInfo = await getTilesetInfo(tilesetResref, resmanOpts, index);

      const floorTerrain = resolveFloorTerrain(tilesetInfo, style);
      if (!floorTerrain) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              error: `Cannot resolve floor terrain for style '${style}' on tileset '${tilesetResref}'`,
            }),
          }],
        };
      }

      const allowed = tilesetInfo.groups
        .filter(g =>
          g.tileIds.some(id => id >= 0) &&
          !groupHasUnsupportedDoors(g, tilesetInfo, floorTerrain) &&
          !groupHasCrossers(g, tilesetInfo) &&
          groupMatchesTerrain(g, tilesetInfo, floorTerrain))
        .map(g => ({ name: g.name, columns: g.columns, rows: g.rows }));

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            tileset: tilesetResref,
            style,
            floorTerrain,
            features: allowed,
            count: allowed.length,
          }, null, 2),
        }],
      };
    },
  );
}
