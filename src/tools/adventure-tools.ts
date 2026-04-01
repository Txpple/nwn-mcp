/**
 * Adventure creator MCP tools.
 *
 * Tools specific to the /create-adventure pipeline and autonomous module building.
 * These are separated from base tools to keep the two visions distinct:
 *   (a) Human-orchestrated editing — base tools
 *   (b) AI-driven adventure creation — this file
 *
 * Tools:
 * - create_adventure_transition: One-way portal (blue light → waypoint) with VFX
 * - find_walkable_position: Find guaranteed walkable coordinates in an area region
 */

import { z } from "zod";
import path from "path";
import fsPromises from "fs/promises";

import { numParam, optNumParam, toF, toI } from "../util/params.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { requireIndex, buildResmanOptions } from "../module-loader.js";
import { GIT_STRUCT_ID } from "../config.js";
import { resolveBlueprint, getGitDoc, writeBackGit, updateAreaCounts } from "../util/git-helpers.js";
import { getFieldStr, getFieldNum, getFieldList, setField } from "../types/gff.js";
import type { GffObj, GffDocument } from "../types/gff.js";
import { snapshotGitForUndo } from "../util/undo.js";
import { compileScript, jsonToGff } from "../nim-tools.js";
import { checkPlacementWalkable } from "../util/walkmesh.js";
import { getTilesetInfo } from "../util/tileset.js";
import { generateLayout } from "../util/layout-generator.js";
import type { LayoutStyle } from "../util/layout-generator.js";

export function registerAdventureTools(server: McpServer): void {

  // ─── create_adventure_transition ───────────────────────────────────────

  server.tool(
    "create_adventure_transition",
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
      snapshotGitForUndo(targetGitDoc, targetArea, "create_adventure_transition", `Place waypoint ${wpTag}`);
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
      snapshotGitForUndo(sourceGitDoc, sourceArea, "create_adventure_transition", `Place light ${lightTag}`);
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

  // ─── find_walkable_position ────────────────────────────────────────────

  server.tool(
    "find_walkable_position",
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

      for (const { x, y } of candidates) {
        if (positions.length >= maxCount) break;
        const check = await checkPlacementWalkable(x, y, area.toLowerCase(), index, resmanOpts);
        if (check.ok) {
          positions.push({ x, y, z: check.z ?? 0 });
        }
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

  // ─── generate_area_layout ──────────────────────────────────────────────

  server.tool(
    "generate_area_layout",
    "Generate a procedural area layout with terrain zones, crosser paths, and transition points. Returns data ready to pass to paint_terrain. Encodes all layout rules: perimeter encapsulation, room separation, adjacency validation, walkable ratio. Styles: dungeon (varied rooms + corridors, some L-shapes), cave (smaller rooms, more corridors, maze-like), dwelling (quadrant rooms, fewer corridors, building interior), forest_clearing (exterior clearings separated by trees), village (buildings along a road).",
    {
      tileset: z.string().describe("Tileset resref (e.g., 'tdc01' for crypt, 'ttf01' for forest)"),
      width: z.string().describe("Area width in tiles (8-18)"),
      height: z.string().describe("Area height in tiles (8-18)"),
      style: z.string().describe("JSON style object: {type: 'dungeon'|'cave'|'dwelling'|'forest_clearing'|'village', rooms?: number, clearings?: number, buildings?: number, corridorStyle?: 'straight'|'zigzag', hasWater?: boolean, hasRoad?: boolean}"),
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
}
