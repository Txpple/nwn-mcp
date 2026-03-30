/**
 * Object management MCP tools.
 *
 * Tools:
 * - link_doors: Link two doors for area transitions
 * - remove_object: Remove an object from an area's GIT by tag or index
 * - move_object: Move an object to a new position in an area
 */

import { z } from "zod";
import path from "path";
import fsPromises from "fs/promises";

import { numParam, optNumParam, toF, toI } from "../util/params.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { requireIndex, buildResmanOptions } from "../module-loader.js";
import { GIT_STRUCT_ID } from "../config.js";
import { resolveBlueprint, getGitDoc, writeBackGit, updateAreaCounts, degToRad } from "../util/git-helpers.js";
import { getFieldStr, getFieldNum, getFieldLocStr, getFieldList, setField } from "../types/gff.js";
import type { GffObj } from "../types/gff.js";
import { snapshotGitForUndo } from "../util/undo.js";
import { compileScript } from "../nim-tools.js";
import { checkPlacementWalkable } from "../util/walkmesh.js";

/** List names excluded from walkability validation (doors sit on walls, sounds are ambient) */
const WALK_CHECK_SKIP_LISTS = new Set(["Door List", "SoundList"]);

export function registerObjectMgmtTools(server: McpServer): void {

  // ─── link_doors ────────────────────────────────────────────────────────

  server.tool(
    "link_doors",
    "Link two doors for area transitions. Sets LinkedTo and LinkedToFlags on both doors bidirectionally.",
    {
      area1: z.string().describe("First area resref"),
      door1Tag: z.string().describe("Tag of the door in area1"),
      area2: z.string().describe("Second area resref"),
      door2Tag: z.string().describe("Tag of the door in area2"),
    },
    async ({ area1, door1Tag, area2, door2Tag }) => {
      const index = requireIndex();

      // Find door1
      const { doc: gitDoc1, obj: git1 } = getGitDoc(index, area1);
      const doorList1 = getFieldList(git1, "Door List");
      const door1 = doorList1.find(d => getFieldStr(d, "Tag") === door1Tag);
      if (!door1) {
        const available = doorList1.map(d => getFieldStr(d, "Tag")).filter(Boolean).join(", ");
        return { content: [{ type: "text", text: `Door '${door1Tag}' not found in ${area1}. Available: ${available}` }] };
      }

      // Find door2
      const { doc: gitDoc2, obj: git2 } = getGitDoc(index, area2);
      const doorList2 = getFieldList(git2, "Door List");
      const door2 = doorList2.find(d => getFieldStr(d, "Tag") === door2Tag);
      if (!door2) {
        const available = doorList2.map(d => getFieldStr(d, "Tag")).filter(Boolean).join(", ");
        return { content: [{ type: "text", text: `Door '${door2Tag}' not found in ${area2}. Available: ${available}` }] };
      }

      // Snapshot for undo before linking
      snapshotGitForUndo(gitDoc1, area1, "link_doors", `Link ${door1Tag} ↔ ${door2Tag}`);
      if (area1.toLowerCase() !== area2.toLowerCase()) {
        snapshotGitForUndo(gitDoc2, area2, "link_doors", `Link ${door2Tag} ↔ ${door1Tag}`);
      }

      // Link door1 → door2
      setField(door1, "LinkedTo", "cexostring", door2Tag);
      setField(door1, "LinkedToFlags", "byte", 1);

      // Link door2 → door1
      setField(door2, "LinkedTo", "cexostring", door1Tag);
      setField(door2, "LinkedToFlags", "byte", 1);

      // Write back both GITs
      await writeBackGit(index, area1, gitDoc1);
      if (area1.toLowerCase() !== area2.toLowerCase()) {
        await writeBackGit(index, area2, gitDoc2);
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            door1: { area: area1, tag: door1Tag, linkedTo: door2Tag },
            door2: { area: area2, tag: door2Tag, linkedTo: door1Tag },
          }, null, 2),
        }],
      };
    },
  );

  // ─── create_area_transition ─────────────────────────────────────────────

  server.tool(
    "create_area_transition",
    "Create a one-way area transition: trigger in source area → waypoint in target area. For two-way transitions, call twice with swapped source/target. Writes and compiles a transition script, places the waypoint, places the trigger, and sets LinkedTo metadata for connectivity checks.",
    {
      sourceArea: z.string().describe("Area resref where the trigger is placed"),
      sourceX: numParam("Trigger X position in source area"),
      sourceY: numParam("Trigger Y position in source area"),
      sourceZ: optNumParam("Trigger Z position (default 0.0)"),
      targetArea: z.string().describe("Area resref where the waypoint is placed"),
      targetX: numParam("Waypoint X position in target area"),
      targetY: numParam("Waypoint Y position in target area"),
      targetZ: optNumParam("Waypoint Z position (default 0.0)"),
      tag: z.string().describe("Base tag for naming. Max 11 chars to avoid script resref truncation collisions. Trigger tag = 'tr_<tag>' (32-char limit), waypoint tag = 'wp_<tag>' (32-char limit), script resref = 'a_tr_<tag>' (16-char resref limit — this is the constraint). Use short abbreviated tags like 'vil_inn', 'cave_vil'."),
      triggerBlueprint: z.string().optional().describe("UTT blueprint resref for the trigger (default: 'nw_yourfeet' or generic trigger)"),
    },
    async ({ sourceArea, sourceX, sourceY, sourceZ, targetArea, targetX, targetY, targetZ, tag, triggerBlueprint }) => {
      const sxN = toF(sourceX), syN = toF(sourceY), szN = toF(sourceZ);
      const txN = toF(targetX), tyN = toF(targetY), tzN = toF(targetZ);
      const index = requireIndex();
      const resmanOpts = await buildResmanOptions(index);

      // Walkmesh + buffer validation for both source trigger and target waypoint
      const srcWalk = await checkPlacementWalkable(sxN, syN, sourceArea.toLowerCase(), index, resmanOpts);
      if (!srcWalk.ok) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              error: "Source trigger position is not safe for placement",
              area: sourceArea,
              position: { x: sxN, y: syN },
              detail: srcWalk.reason,
            }, null, 2),
          }],
        };
      }
      const tgtWalk = await checkPlacementWalkable(txN, tyN, targetArea.toLowerCase(), index, resmanOpts);
      if (!tgtWalk.ok) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              error: "Target waypoint position is not safe for placement",
              area: targetArea,
              position: { x: txN, y: tyN },
              detail: tgtWalk.reason,
            }, null, 2),
          }],
        };
      }

      const trigTag = `tr_${tag}`.substring(0, 32); // Tags can be 32 chars
      const wpTag = `wp_${tag}`.substring(0, 32);
      const scriptResref = `a_tr_${tag}`.substring(0, 16); // NWN 16-char resref limit

      // Check for resref collision — two different tags can truncate to the same 16-char script
      const existingScript = index.resources.get(`${scriptResref}.nss`);
      if (existingScript) {
        // Read the existing script to check if it points to a different waypoint
        const existingSource = await fsPromises.readFile(existingScript.filePath, "utf-8");
        if (!existingSource.includes(`"${wpTag}"`)) {
          return {
            content: [{
              type: "text",
              text: `Script resref collision: '${scriptResref}' already exists for a different transition. Use a shorter tag (max ${16 - 5} chars for the tag portion, e.g., 'vil_to_inn' instead of 'village_to_inn').`,
            }],
          };
        }
      }

      // 1. Write transition script
      const scriptSource = [
        "void main() {",
        "    object oPC = GetEnteringObject();",
        "    if (!GetIsPC(oPC)) return;",
        `    object oWP = GetWaypointByTag("${wpTag}");`,
        "    AssignCommand(oPC, JumpToObject(oWP));",
        "}",
      ].join("\n");

      const nssPath = path.join(index.tempDir, `${scriptResref}.nss`);
      await fsPromises.writeFile(nssPath, scriptSource, "utf-8");

      const nssStat = await fsPromises.stat(nssPath);
      index.resources.set(`${scriptResref}.nss`, {
        resref: scriptResref,
        extension: "nss",
        filePath: nssPath,
        sizeBytes: nssStat.size,
      });

      // Compile
      const ncsPath = nssPath.replace(/\.nss$/i, ".ncs");
      const compResult = await compileScript(nssPath, ncsPath, { resman: resmanOpts });
      if (compResult.success) {
        try {
          const ncsStat = await fsPromises.stat(ncsPath);
          index.resources.set(`${scriptResref}.ncs`, {
            resref: scriptResref,
            extension: "ncs",
            filePath: ncsPath,
            sizeBytes: ncsStat.size,
          });
        } catch {
          // .ncs file may not exist if compiler is mocked
        }
      }

      // 2. Place waypoint in target area
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
        ZPosition: { type: "float", value: tzN },
        XOrientation: { type: "float", value: 0 },
        YOrientation: { type: "float", value: 1 },
      };

      const { doc: targetGitDoc, obj: targetGit } = getGitDoc(index, targetArea);
      snapshotGitForUndo(targetGitDoc, targetArea, "create_area_transition", `Place waypoint ${wpTag}`);
      const wpList = getFieldList(targetGit, "WaypointList");
      wpList.push(waypoint);
      await writeBackGit(index, targetArea, targetGitDoc);
      updateAreaCounts(index, targetArea);

      // 3. Place trigger in source area
      const bpResref = triggerBlueprint || "nw_yourfeet";
      let triggerObj: GffObj;

      const utt = await resolveBlueprint(index, bpResref, "utt", resmanOpts);
      if (utt) {
        triggerObj = utt as GffObj;
        delete triggerObj.__data_type;
      } else {
        // Minimal trigger if blueprint not found
        triggerObj = {
          Tag: { type: "cexostring", value: trigTag },
          LocalizedName: { type: "cexolocstring", value: { "0": `Transition: ${tag}` } },
          TemplateResRef: { type: "resref", value: "" },
          AutoRemoveKey: { type: "byte", value: 0 },
          Faction: { type: "dword", value: 0 },
          Type: { type: "int", value: 0 },
        };
      }

      triggerObj.__struct_id = GIT_STRUCT_ID.TRIGGER;
      setField(triggerObj, "Tag", "cexostring", trigTag);
      triggerObj.XPosition = { type: "float", value: sxN };
      triggerObj.YPosition = { type: "float", value: syN };
      triggerObj.ZPosition = { type: "float", value: szN };

      // Assign transition script
      setField(triggerObj, "ScriptOnEnter", "resref", scriptResref);

      // Set LinkedTo metadata so check_area_connectivity detects this transition
      setField(triggerObj, "LinkedTo", "cexostring", wpTag);
      setField(triggerObj, "LinkedToFlags", "byte", 1);

      const { doc: sourceGitDoc, obj: sourceGit } = getGitDoc(index, sourceArea);
      snapshotGitForUndo(sourceGitDoc, sourceArea, "create_area_transition", `Place trigger ${trigTag}`);
      const triggerList = getFieldList(sourceGit, "Trigger List");
      triggerList.push(triggerObj);
      await writeBackGit(index, sourceArea, sourceGitDoc);
      updateAreaCounts(index, sourceArea);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            transition: {
              source: { area: sourceArea, triggerTag: trigTag, position: { x: sxN, y: syN, z: szN } },
              target: { area: targetArea, waypointTag: wpTag, position: { x: txN, y: tyN, z: tzN } },
              script: scriptResref,
              compiled: compResult.success,
              ...(compResult.success ? {} : { compilerOutput: compResult.output }),
            },
          }, null, 2),
        }],
      };
    },
  );

  // ─── remove_object ─────────────────────────────────────────────────────

  server.tool(
    "remove_object",
    "Remove an object from an area's GIT by tag or list index.",
    {
      area: z.string().describe("Area resref"),
      listName: z.string().describe("GIT list name: 'Creature List', 'Placeable List', 'WaypointList', 'Door List', 'Trigger List', 'Encounter List', 'SoundList', 'StoreList'"),
      tag: z.string().optional().describe("Tag of the object to remove (first match)"),
      index: optNumParam("0-based index in the list"),
    },
    async ({ area, listName, tag, index: removeIndex }) => {
      if (tag === undefined && removeIndex === undefined) {
        return { content: [{ type: "text", text: "Must provide either 'tag' or 'index'" }] };
      }
      const removeIndexN = removeIndex !== undefined ? toI(removeIndex) : undefined;

      const moduleIndex = requireIndex();
      const { doc: gitDoc, obj: git } = getGitDoc(moduleIndex, area);
      const list = getFieldList(git, listName);

      if (list.length === 0) {
        return { content: [{ type: "text", text: `List '${listName}' is empty in area ${area}` }] };
      }

      let targetIdx: number;
      if (tag !== undefined) {
        targetIdx = list.findIndex(entry => getFieldStr(entry, "Tag") === tag);
        if (targetIdx < 0) {
          const available = list.map(e => getFieldStr(e, "Tag")).filter(Boolean).join(", ");
          return { content: [{ type: "text", text: `Tag '${tag}' not found in ${listName}. Available: ${available}` }] };
        }
      } else {
        targetIdx = removeIndexN!;
        if (targetIdx < 0 || targetIdx >= list.length) {
          return { content: [{ type: "text", text: `Index ${targetIdx} out of range (list has ${list.length} entries)` }] };
        }
      }

      snapshotGitForUndo(gitDoc, area, "remove_object", `Remove ${tag || `index ${targetIdx}`} from ${listName}`);
      const removed = list[targetIdx];
      const removedTag = getFieldStr(removed, "Tag");
      const removedName = getFieldLocStr(removed, "FirstName") || getFieldLocStr(removed, "LocalizedName") || getFieldLocStr(removed, "LocName") || removedTag;

      list.splice(targetIdx, 1);

      await writeBackGit(moduleIndex, area, gitDoc);
      updateAreaCounts(moduleIndex, area);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            area,
            listName,
            removed: { tag: removedTag, name: removedName, index: targetIdx },
            remainingCount: list.length,
          }, null, 2),
        }],
      };
    },
  );

  // ─── move_object ──────────────────────────────────────────────────────

  server.tool(
    "move_object",
    "Move an object to a new position in an area. Finds the object by tag (first match) or list index.",
    {
      area: z.string().describe("Area resref"),
      listName: z.string().describe("GIT list name: 'Creature List', 'Placeable List', 'WaypointList', 'Door List', 'Trigger List', 'Encounter List', 'SoundList', 'StoreList'"),
      tag: z.string().optional().describe("Tag of the object to move (first match)"),
      index: optNumParam("0-based index in the list"),
      x: numParam("New X position"),
      y: numParam("New Y position"),
      z: optNumParam("New Z position (keeps current if omitted)"),
    },
    async ({ area, listName, tag, index: moveIndex, x, y, z: zPos }) => {
      if (tag === undefined && moveIndex === undefined) {
        return { content: [{ type: "text", text: "Must provide either 'tag' or 'index'" }] };
      }
      const xN = toF(x), yN = toF(y);
      const zN = zPos !== undefined ? toF(zPos) : undefined;
      const moveIndexN = moveIndex !== undefined ? toI(moveIndex) : undefined;

      const moduleIndex = requireIndex();
      const { doc: gitDoc, obj: git } = getGitDoc(moduleIndex, area);
      const list = getFieldList(git, listName);

      if (list.length === 0) {
        return { content: [{ type: "text", text: `List '${listName}' is empty in area ${area}` }] };
      }

      let targetIdx: number;
      if (tag !== undefined) {
        targetIdx = list.findIndex(entry => getFieldStr(entry, "Tag") === tag);
        if (targetIdx < 0) {
          const available = list.map(e => getFieldStr(e, "Tag")).filter(Boolean).join(", ");
          return { content: [{ type: "text", text: `Tag '${tag}' not found in ${listName}. Available: ${available}` }] };
        }
      } else {
        targetIdx = moveIndexN!;
        if (targetIdx < 0 || targetIdx >= list.length) {
          return { content: [{ type: "text", text: `Index ${targetIdx} out of range (list has ${list.length} entries)` }] };
        }
      }

      const obj = list[targetIdx];
      const objTag = getFieldStr(obj, "Tag");
      const objName = getFieldLocStr(obj, "FirstName") || getFieldLocStr(obj, "LocalizedName") || getFieldLocStr(obj, "LocName") || objTag;

      // Position fields differ by object type
      const usesXYZ = listName === "Placeable List" || listName === "Door List";
      const xField = usesXYZ ? "X" : "XPosition";
      const yField = usesXYZ ? "Y" : "YPosition";
      const zField = usesXYZ ? "Z" : "ZPosition";

      const oldPosition = {
        x: getFieldNum(obj, xField),
        y: getFieldNum(obj, yField),
        z: getFieldNum(obj, zField),
      };

      // Walkmesh + buffer validation (skip doors and sounds)
      if (!WALK_CHECK_SKIP_LISTS.has(listName)) {
        const resmanOpts = await buildResmanOptions(moduleIndex);
        const walkCheck = await checkPlacementWalkable(xN, yN, area.toLowerCase(), moduleIndex, resmanOpts);
        if (!walkCheck.ok) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                error: "Target position is not safe for placement",
                position: { x: xN, y: yN },
                detail: walkCheck.reason,
              }, null, 2),
            }],
          };
        }
      }

      snapshotGitForUndo(gitDoc, area, "move_object", `Move ${objTag || `index ${targetIdx}`} in ${listName}`);

      obj[xField] = { type: "float", value: xN };
      obj[yField] = { type: "float", value: yN };
      if (zN !== undefined) {
        obj[zField] = { type: "float", value: zN };
      }

      await writeBackGit(moduleIndex, area, gitDoc);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            area,
            listName,
            object: { tag: objTag, name: objName, index: targetIdx },
            oldPosition,
            newPosition: { x: xN, y: yN, z: zN ?? oldPosition.z },
          }, null, 2),
        }],
      };
    },
  );
}
