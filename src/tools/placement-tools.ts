/**
 * Area placement MCP tools.
 *
 * Tools:
 * - place_creature: Place a creature from a blueprint with walkmesh validation
 * - place_placeable: Place a placeable from a blueprint with correct Appearance
 * - place_waypoint: Place a waypoint with optional map note
 * - place_door: Place a door from a UTD blueprint
 * - place_trigger: Place a trigger from a UTT blueprint
 * - place_encounter: Place an encounter from a UTE blueprint
 * - place_sound: Place a sound from a UTS blueprint
 * - place_store: Place a store from a UTM blueprint
 */

import { z } from "zod";

import { numParam, optNumParam, toF } from "../util/params.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { requireIndex, buildResmanOptions } from "../module-loader.js";
import { GIT_STRUCT_ID } from "../config.js";
import { checkPositionWalkable, checkPlacementWalkable } from "../util/walkmesh.js";
import { resolveBlueprint, getGitDoc, writeBackGit, updateAreaCounts, degToRad } from "../util/git-helpers.js";
import { getFieldStr, getFieldNum, getFieldLocStr, getFieldList, setField } from "../types/gff.js";
import type { GffObj } from "../types/gff.js";
import { snapshotGitForUndo } from "../util/undo.js";

// ─── Collision detection helper ──────────────────────────────────────────────

interface CollisionResult {
  collision: boolean;
  nearbyTag?: string;
  distance?: number;
}

const COLLISION_LISTS = [
  { name: "Creature List", xField: "XPosition", yField: "YPosition" },
  { name: "Placeable List", xField: "X", yField: "Y" },
  { name: "Door List", xField: "X", yField: "Y" },
] as const;

/**
 * Check for nearby objects within `radius` meters across creature, placeable, and door lists.
 * Returns the closest collision if any.
 */
function checkCollision(git: GffObj, x: number, y: number, radius: number = 0.75): CollisionResult {
  let closestDist = Infinity;
  let closestTag: string | undefined;

  for (const { name, xField, yField } of COLLISION_LISTS) {
    const list = getFieldList(git, name);
    for (const obj of list) {
      const ox = getFieldNum(obj, xField);
      const oy = getFieldNum(obj, yField);
      if (ox === undefined || oy === undefined) continue;
      const dx = ox - x;
      const dy = oy - y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < radius && dist < closestDist) {
        closestDist = dist;
        closestTag = getFieldStr(obj, "Tag") || undefined;
      }
    }
  }

  if (closestDist < radius) {
    return { collision: true, nearbyTag: closestTag, distance: Math.round(closestDist * 100) / 100 };
  }
  return { collision: false };
}

export function registerPlacementTools(server: McpServer): void {

  // ─── place_creature ────────────────────────────────────────────────────

  server.tool(
    "place_creature",
    "Place a creature in an area from a UTC blueprint (module or base game). Validates position against walkmesh.",
    {
      area: z.string().describe("Area resref"),
      blueprint: z.string().describe("UTC blueprint resref (module or base game, e.g. 'nw_dog', 'salino')"),
      x: numParam("World X position"),
      y: numParam("World Y position"),
      z: optNumParam("World Z position (default 0.0)"),
      bearing: optNumParam("Facing direction in degrees (default 0)"),
      collisionRadius: optNumParam("Collision detection radius in meters (default 0.75). Set to 0 to disable."),
    },
    { idempotentHint: true },
    async ({ area, blueprint, x, y, z: zPos, bearing, collisionRadius }) => {
      const xN = toF(x), yN = toF(y), zN = toF(zPos), bearingN = toF(bearing);
      const index = requireIndex();
      const resmanOpts = await buildResmanOptions(index);

      // Walkmesh + buffer validation
      const walkCheck = await checkPlacementWalkable(xN, yN, area.toLowerCase(), index, resmanOpts);
      if (!walkCheck.ok) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              error: "Position is not safe for placement",
              position: { x: xN, y: yN },
              detail: walkCheck.reason,
            }, null, 2),
          }],
        };
      }

      // Resolve blueprint
      const utc = await resolveBlueprint(index, blueprint, "utc", resmanOpts);
      if (!utc) {
        return { content: [{ type: "text", text: `Blueprint not found: ${blueprint}.utc` }] };
      }

      const obj = utc as GffObj;

      // Strip __data_type, set __struct_id for GIT list entry
      delete obj.__data_type;
      obj.__struct_id = GIT_STRUCT_ID.CREATURE;

      // Set position — use walkmesh Z height for accurate ground placement
      const placeZ = walkCheck.z ?? zN;
      obj.XPosition = { type: "float", value: xN };
      obj.YPosition = { type: "float", value: yN };
      obj.ZPosition = { type: "float", value: placeZ };

      // Set facing
      const rad = degToRad(bearingN);
      obj.XOrientation = { type: "float", value: Math.sin(rad) };
      obj.YOrientation = { type: "float", value: Math.cos(rad) };

      // Append to GIT Creature List
      const { doc: gitDoc, obj: git } = getGitDoc(index, area);

      // Collision detection (warning, not blocking)
      const colRadius = collisionRadius !== undefined ? toF(collisionRadius) : undefined;
      const collision = colRadius === 0 ? { collision: false } as const : checkCollision(git, xN, yN, colRadius);

      snapshotGitForUndo(gitDoc, area, "place_creature", `Place creature ${blueprint}`);
      const creatureList = getFieldList(git, "Creature List");
      creatureList.push(obj);

      await writeBackGit(index, area, gitDoc);
      updateAreaCounts(index, area);

      const name = getFieldLocStr(obj, "FirstName") || getFieldStr(obj, "Tag") || blueprint;

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            area,
            creature: name,
            blueprint,
            position: { x: xN, y: yN, z: zN },
            bearing: bearingN,
            ...(collision.collision && {
              collisionWarning: `Object '${collision.nearbyTag}' is ${collision.distance}m away — objects may overlap`,
            }),
          }, null, 2),
        }],
      };
    },
  );

  // ─── place_placeable ───────────────────────────────────────────────────

  server.tool(
    "place_placeable",
    "Place a placeable in an area from a UTP blueprint. Appearance field comes from the blueprint (not defaulted to 0). By default strips event scripts and clears Useable/HasInventory — pass stripScripts='false' to keep blueprint defaults. Use add_items_to_container to enable inventory on placed containers. Enforces 1m collision check — placement fails if another object is within 1m.",
    {
      area: z.string().describe("Area resref"),
      blueprint: z.string().describe("UTP blueprint resref (module or base game)"),
      x: numParam("World X position"),
      y: numParam("World Y position"),
      z: optNumParam("World Z position (default 0.0)"),
      bearing: optNumParam("Facing direction in degrees (default 0)"),
      stripScripts: z.string().optional().describe("Strip all event scripts from the blueprint (default 'true'). Set to 'false' to keep blueprint scripts."),
    },
    { idempotentHint: true },
    async ({ area, blueprint, x, y, z: zPos, bearing, stripScripts }) => {
      const xN = toF(x), yN = toF(y), zN = toF(zPos), bearingN = toF(bearing);
      const index = requireIndex();
      const resmanOpts = await buildResmanOptions(index);

      // Walkmesh + buffer validation (blocking)
      const walkCheck = await checkPlacementWalkable(xN, yN, area.toLowerCase(), index, resmanOpts);
      if (!walkCheck.ok) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              error: "Position is not safe for placement",
              position: { x: xN, y: yN },
              detail: walkCheck.reason,
            }, null, 2),
          }],
        };
      }

      // Resolve blueprint
      const utp = await resolveBlueprint(index, blueprint, "utp", resmanOpts);
      if (!utp) {
        return { content: [{ type: "text", text: `Blueprint not found: ${blueprint}.utp` }] };
      }

      const obj = utp as GffObj;

      // Strip __data_type, set __struct_id for GIT list entry
      delete obj.__data_type;
      obj.__struct_id = GIT_STRUCT_ID.PLACEABLE;

      // Strip blueprint event scripts by default (base game blueprints carry
      // treasure-gen and toggle scripts that are unwanted for placed objects)
      const shouldStrip = stripScripts !== "false";
      if (shouldStrip) {
        const utpScriptFields = [
          "OnClick", "OnClosed", "OnDamaged", "OnDeath", "OnDisarm",
          "OnHeartbeat", "OnInvDisturbed", "OnLock", "OnMeleeAttacked",
          "OnOpen", "OnSpellCastAt", "OnTrapTriggered", "OnUnlock",
          "OnUsed", "OnUserDefined",
        ];
        for (const field of utpScriptFields) {
          if (obj[field]) {
            (obj[field] as { type: string; value: string }).value = "";
          }
        }

        // Also clear Useable and HasInventory — base game containers come with
        // these enabled plus treasure-gen scripts.  Downstream skills (affordances,
        // rewards) explicitly enable them when they stock inventory.
        setField(obj, "Useable", "byte", 0);
        setField(obj, "HasInventory", "byte", 0);
      }

      // Placeables use different position field names — use walkmesh Z
      const placeZ = walkCheck.z ?? zN;
      obj.X = { type: "float", value: xN };
      obj.Y = { type: "float", value: yN };
      obj.Z = { type: "float", value: placeZ };
      obj.Bearing = { type: "float", value: degToRad(bearingN) };

      // Verify Appearance is present from blueprint
      const appearance = getFieldNum(obj, "Appearance");

      // Append to GIT Placeable List
      const { doc: gitDoc, obj: git } = getGitDoc(index, area);

      // Collision detection — mandatory 1m radius, blocks placement
      const collision = checkCollision(git, xN, yN, 1.0);
      if (collision.collision) {
        return {
          content: [{
            type: "text",
            text: `Placement blocked: '${collision.nearbyTag}' is ${collision.distance}m away (minimum 1m). Choose a different position.`,
          }],
        };
      }

      snapshotGitForUndo(gitDoc, area, "place_placeable", `Place placeable ${blueprint}`);
      const placeableList = getFieldList(git, "Placeable List");
      placeableList.push(obj);

      await writeBackGit(index, area, gitDoc);
      updateAreaCounts(index, area);

      const name = getFieldLocStr(obj, "LocName") || getFieldStr(obj, "Tag") || blueprint;

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            area,
            placeable: name,
            blueprint,
            appearance,
            position: { x: xN, y: yN, z: zN },
            bearing: bearingN,
          }, null, 2),
        }],
      };
    },
  );

  // ─── place_waypoint ────────────────────────────────────────────────────

  server.tool(
    "place_waypoint",
    "Place a waypoint in an area with optional map note.",
    {
      area: z.string().describe("Area resref"),
      tag: z.string().describe("Waypoint tag"),
      name: z.string().describe("Waypoint display name"),
      x: numParam("World X position"),
      y: numParam("World Y position"),
      z: optNumParam("World Z position (default 0.0)"),
      bearing: optNumParam("Facing direction in degrees (default 0)"),
      mapNote: z.string().optional().describe("Map note text (enables map pin if provided)"),
      mapNoteEnabled: z.boolean().optional().describe("Show map note pin (default true if mapNote provided)"),
    },
    { idempotentHint: true },
    async ({ area, tag, name, x, y, z: zPos, bearing, mapNote, mapNoteEnabled }) => {
      const xN = toF(x), yN = toF(y), zN = toF(zPos), bearingN = toF(bearing);
      const index = requireIndex();
      const resmanOpts = await buildResmanOptions(index);

      // Walkmesh + buffer validation (blocking)
      const walkCheck = await checkPlacementWalkable(xN, yN, area.toLowerCase(), index, resmanOpts);
      if (!walkCheck.ok) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              error: "Position is not safe for placement",
              position: { x: xN, y: yN },
              detail: walkCheck.reason,
            }, null, 2),
          }],
        };
      }

      const rad = degToRad(bearingN);
      const hasNote = !!mapNote;
      const noteEnabled = mapNoteEnabled ?? hasNote;

      const waypoint: GffObj = {
        __struct_id: GIT_STRUCT_ID.WAYPOINT,
        Appearance: { type: "byte", value: 1 },
        Description: { type: "cexolocstring", value: {} },
        HasMapNote: { type: "byte", value: hasNote ? 1 : 0 },
        LinkedTo: { type: "cexostring", value: "" },
        LocalizedName: { type: "cexolocstring", value: { "0": name } },
        MapNote: { type: "cexolocstring", value: mapNote ? { "0": mapNote } : {} },
        MapNoteEnabled: { type: "byte", value: noteEnabled ? 1 : 0 },
        Tag: { type: "cexostring", value: tag },
        TemplateResRef: { type: "resref", value: "" },
        XPosition: { type: "float", value: xN },
        YPosition: { type: "float", value: yN },
        ZPosition: { type: "float", value: walkCheck.z ?? zN },
        XOrientation: { type: "float", value: Math.sin(rad) },
        YOrientation: { type: "float", value: Math.cos(rad) },
      };

      const { doc: gitDoc, obj: git } = getGitDoc(index, area);
      snapshotGitForUndo(gitDoc, area, "place_waypoint", `Place waypoint ${tag}`);
      const wpList = getFieldList(git, "WaypointList");
      wpList.push(waypoint);

      await writeBackGit(index, area, gitDoc);
      updateAreaCounts(index, area);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            area,
            tag,
            name,
            position: { x: xN, y: yN, z: zN },
            mapNote: mapNote || null,
          }, null, 2),
        }],
      };
    },
  );

  // ─── place_door ───────────────────────────────────────────────────────

  server.tool(
    "place_door",
    "Place a door in an area from a UTD blueprint (module or base game).",
    {
      area: z.string().describe("Area resref"),
      blueprint: z.string().describe("UTD blueprint resref (module or base game, e.g. 'nw_door_strong')"),
      x: numParam("World X position"),
      y: numParam("World Y position"),
      z: optNumParam("World Z position (default 0.0)"),
      bearing: optNumParam("Facing direction in degrees (default 0)"),
    },
    { idempotentHint: true },
    async ({ area, blueprint, x, y, z: zPos, bearing }) => {
      const xN = toF(x), yN = toF(y), zN = toF(zPos), bearingN = toF(bearing);
      const index = requireIndex();
      const resmanOpts = await buildResmanOptions(index);

      // Surface material check (informational)
      const walkResult = await checkPositionWalkable(xN, yN, area.toLowerCase(), index, resmanOpts);

      const utd = await resolveBlueprint(index, blueprint, "utd", resmanOpts);
      if (!utd) {
        return { content: [{ type: "text", text: `Blueprint not found: ${blueprint}.utd` }] };
      }

      const obj = utd as GffObj;
      delete obj.__data_type;
      obj.__struct_id = GIT_STRUCT_ID.DOOR;

      obj.X = { type: "float", value: xN };
      obj.Y = { type: "float", value: yN };
      obj.Z = { type: "float", value: walkResult.z ?? zN };
      obj.Bearing = { type: "float", value: degToRad(bearingN) };

      const { doc: gitDoc, obj: git } = getGitDoc(index, area);
      snapshotGitForUndo(gitDoc, area, "place_door", `Place door ${blueprint}`);
      const doorList = getFieldList(git, "Door List");
      doorList.push(obj);

      await writeBackGit(index, area, gitDoc);
      updateAreaCounts(index, area);

      const name = getFieldLocStr(obj, "LocName") || getFieldStr(obj, "Tag") || blueprint;

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            area,
            door: name,
            blueprint,
            position: { x: xN, y: yN, z: zN },
            bearing: bearingN,
            surface: walkResult.material,
            surfaceWalkable: walkResult.walkable,
          }, null, 2),
        }],
      };
    },
  );

  // ─── place_trigger ──────────────────────────────────────────────────────

  server.tool(
    "place_trigger",
    "Place a trigger in an area from a UTT blueprint (module or base game). The blueprint's geometry defines the trigger shape.",
    {
      area: z.string().describe("Area resref"),
      blueprint: z.string().describe("UTT blueprint resref (module or base game)"),
      x: numParam("World X position (trigger center)"),
      y: numParam("World Y position (trigger center)"),
      z: optNumParam("World Z position (default 0.0)"),
    },
    { idempotentHint: true },
    async ({ area, blueprint, x, y, z: zPos }) => {
      const xN = toF(x), yN = toF(y), zN = toF(zPos);
      const index = requireIndex();
      const resmanOpts = await buildResmanOptions(index);

      // Walkmesh + buffer validation (blocking)
      const walkCheck = await checkPlacementWalkable(xN, yN, area.toLowerCase(), index, resmanOpts);
      if (!walkCheck.ok) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              error: "Position is not safe for placement",
              position: { x: xN, y: yN },
              detail: walkCheck.reason,
            }, null, 2),
          }],
        };
      }

      const utt = await resolveBlueprint(index, blueprint, "utt", resmanOpts);
      if (!utt) {
        return { content: [{ type: "text", text: `Blueprint not found: ${blueprint}.utt` }] };
      }

      const obj = utt as GffObj;
      delete obj.__data_type;
      obj.__struct_id = GIT_STRUCT_ID.TRIGGER;

      obj.XPosition = { type: "float", value: xN };
      obj.YPosition = { type: "float", value: yN };
      obj.ZPosition = { type: "float", value: walkCheck.z ?? zN };

      // Ensure trigger has geometry — blueprints don't include it, but placed
      // instances require it for the engine to detect entry and the toolset to render.
      if (!obj.Geometry) {
        const s = 2.0; // half-size of default 4m square
        obj.Geometry = {
          type: "list",
          value: [
            { __struct_id: 0, PointX: { type: "float", value: -s }, PointY: { type: "float", value: -s }, PointZ: { type: "float", value: 0.025 } },
            { __struct_id: 0, PointX: { type: "float", value:  s }, PointY: { type: "float", value: -s }, PointZ: { type: "float", value: 0.025 } },
            { __struct_id: 0, PointX: { type: "float", value:  s }, PointY: { type: "float", value:  s }, PointZ: { type: "float", value: 0.025 } },
            { __struct_id: 0, PointX: { type: "float", value: -s }, PointY: { type: "float", value:  s }, PointZ: { type: "float", value: 0.025 } },
          ],
        };
      }

      const { doc: gitDoc, obj: git } = getGitDoc(index, area);
      snapshotGitForUndo(gitDoc, area, "place_trigger", `Place trigger ${blueprint}`);
      const triggerList = getFieldList(git, "TriggerList");
      triggerList.push(obj);

      await writeBackGit(index, area, gitDoc);
      updateAreaCounts(index, area);

      const name = getFieldLocStr(obj, "LocalizedName") || getFieldStr(obj, "Tag") || blueprint;

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            area,
            trigger: name,
            blueprint,
            position: { x: xN, y: yN, z: zN },
          }, null, 2),
        }],
      };
    },
  );

  // ─── place_encounter ────────────────────────────────────────────────────

  server.tool(
    "place_encounter",
    "Place an encounter in an area from a UTE blueprint (module or base game). The blueprint's geometry defines the spawn region.",
    {
      area: z.string().describe("Area resref"),
      blueprint: z.string().describe("UTE blueprint resref (module or base game)"),
      x: numParam("World X position (encounter center)"),
      y: numParam("World Y position (encounter center)"),
      z: optNumParam("World Z position (default 0.0)"),
    },
    { idempotentHint: true },
    async ({ area, blueprint, x, y, z: zPos }) => {
      const xN = toF(x), yN = toF(y), zN = toF(zPos);
      const index = requireIndex();
      const resmanOpts = await buildResmanOptions(index);

      // Walkmesh + buffer validation (blocking)
      const walkCheck = await checkPlacementWalkable(xN, yN, area.toLowerCase(), index, resmanOpts);
      if (!walkCheck.ok) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              error: "Position is not safe for placement",
              position: { x: xN, y: yN },
              detail: walkCheck.reason,
            }, null, 2),
          }],
        };
      }

      const ute = await resolveBlueprint(index, blueprint, "ute", resmanOpts);
      if (!ute) {
        return { content: [{ type: "text", text: `Blueprint not found: ${blueprint}.ute` }] };
      }

      const obj = ute as GffObj;
      delete obj.__data_type;
      obj.__struct_id = GIT_STRUCT_ID.ENCOUNTER;

      obj.XPosition = { type: "float", value: xN };
      obj.YPosition = { type: "float", value: yN };
      obj.ZPosition = { type: "float", value: walkCheck.z ?? zN };

      // Ensure encounter has geometry — blueprints don't include it, but placed
      // instances require it for the engine to define the spawn region.
      if (!obj.Geometry) {
        const s = 5.0; // half-size of default 10m square
        obj.Geometry = {
          type: "list",
          value: [
            { __struct_id: 0, X: { type: "float", value: -s }, Y: { type: "float", value: -s }, Z: { type: "float", value: 0.0 } },
            { __struct_id: 0, X: { type: "float", value:  s }, Y: { type: "float", value: -s }, Z: { type: "float", value: 0.0 } },
            { __struct_id: 0, X: { type: "float", value:  s }, Y: { type: "float", value:  s }, Z: { type: "float", value: 0.0 } },
            { __struct_id: 0, X: { type: "float", value: -s }, Y: { type: "float", value:  s }, Z: { type: "float", value: 0.0 } },
          ],
        };
      }

      const { doc: gitDoc, obj: git } = getGitDoc(index, area);
      snapshotGitForUndo(gitDoc, area, "place_encounter", `Place encounter ${blueprint}`);
      const encounterList = getFieldList(git, "Encounter List");
      encounterList.push(obj);

      await writeBackGit(index, area, gitDoc);
      updateAreaCounts(index, area);

      const name = getFieldLocStr(obj, "LocalizedName") || getFieldStr(obj, "Tag") || blueprint;

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            area,
            encounter: name,
            blueprint,
            position: { x: xN, y: yN, z: zN },
          }, null, 2),
        }],
      };
    },
  );

  // ─── place_sound ────────────────────────────────────────────────────────

  server.tool(
    "place_sound",
    "Place a sound object in an area from a UTS blueprint (module or base game).",
    {
      area: z.string().describe("Area resref"),
      blueprint: z.string().describe("UTS blueprint resref (module or base game)"),
      x: numParam("World X position"),
      y: numParam("World Y position"),
      z: optNumParam("World Z position (default 0.0)"),
    },
    { idempotentHint: true },
    async ({ area, blueprint, x, y, z: zPos }) => {
      const xN = toF(x), yN = toF(y), zN = toF(zPos);
      const index = requireIndex();
      const resmanOpts = await buildResmanOptions(index);

      // Surface material check (informational)
      const walkResult = await checkPositionWalkable(xN, yN, area.toLowerCase(), index, resmanOpts);

      const uts = await resolveBlueprint(index, blueprint, "uts", resmanOpts);
      if (!uts) {
        return { content: [{ type: "text", text: `Blueprint not found: ${blueprint}.uts` }] };
      }

      const obj = uts as GffObj;
      delete obj.__data_type;
      obj.__struct_id = GIT_STRUCT_ID.SOUND;

      obj.XPosition = { type: "float", value: xN };
      obj.YPosition = { type: "float", value: yN };
      obj.ZPosition = { type: "float", value: walkResult.z ?? zN };

      const { doc: gitDoc, obj: git } = getGitDoc(index, area);
      snapshotGitForUndo(gitDoc, area, "place_sound", `Place sound ${blueprint}`);
      const soundList = getFieldList(git, "SoundList");
      soundList.push(obj);

      await writeBackGit(index, area, gitDoc);

      const name = getFieldLocStr(obj, "LocName") || getFieldStr(obj, "Tag") || blueprint;

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            area,
            sound: name,
            blueprint,
            position: { x: xN, y: yN, z: zN },
            surface: walkResult.material,
            surfaceWalkable: walkResult.walkable,
          }, null, 2),
        }],
      };
    },
  );

  // ─── place_store ────────────────────────────────────────────────────────

  server.tool(
    "place_store",
    "Place a store in an area from a UTM blueprint (module or base game). Stores are typically opened via scripts on NPCs/placeables.",
    {
      area: z.string().describe("Area resref"),
      blueprint: z.string().describe("UTM blueprint resref (module or base game)"),
      x: numParam("World X position"),
      y: numParam("World Y position"),
      z: optNumParam("World Z position (default 0.0)"),
    },
    { idempotentHint: true },
    async ({ area, blueprint, x, y, z: zPos }) => {
      const xN = toF(x), yN = toF(y), zN = toF(zPos);
      const index = requireIndex();
      const resmanOpts = await buildResmanOptions(index);

      // Walkmesh + buffer validation (blocking)
      const walkCheck = await checkPlacementWalkable(xN, yN, area.toLowerCase(), index, resmanOpts);
      if (!walkCheck.ok) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              error: "Position is not safe for placement",
              position: { x: xN, y: yN },
              detail: walkCheck.reason,
            }, null, 2),
          }],
        };
      }

      const utm = await resolveBlueprint(index, blueprint, "utm", resmanOpts);
      if (!utm) {
        return { content: [{ type: "text", text: `Blueprint not found: ${blueprint}.utm` }] };
      }

      const obj = utm as GffObj;
      delete obj.__data_type;
      obj.__struct_id = GIT_STRUCT_ID.STORE;

      obj.XPosition = { type: "float", value: xN };
      obj.YPosition = { type: "float", value: yN };
      obj.ZPosition = { type: "float", value: walkCheck.z ?? zN };

      const { doc: gitDoc, obj: git } = getGitDoc(index, area);
      snapshotGitForUndo(gitDoc, area, "place_store", `Place store ${blueprint}`);
      const storeList = getFieldList(git, "StoreList");
      storeList.push(obj);

      await writeBackGit(index, area, gitDoc);

      const name = getFieldLocStr(obj, "LocName") || getFieldStr(obj, "Tag") || blueprint;

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            area,
            store: name,
            blueprint,
            position: { x: xN, y: yN, z: zN },
          }, null, 2),
        }],
      };
    },
  );

  // ─── add_items_to_container ────────────────────────────────────────────

  server.tool(
    "add_items_to_container",
    "Add items to a placeable container's inventory. Resolves item blueprints from module or base game.",
    {
      area: z.string().describe("Area resref"),
      containerTag: z.string().describe("Tag of the placeable container"),
      items: z.string().describe("JSON array: [{\"resref\": \"nw_it_mpotion001\", \"quantity\": 1}]"),
    },
    { idempotentHint: true },
    async ({ area, containerTag, items: itemsJson }) => {
      const index = requireIndex();
      const resmanOpts = await buildResmanOptions(index);

      let itemsArr: Array<{ resref: string; quantity?: number }>;
      try {
        itemsArr = JSON.parse(itemsJson);
      } catch {
        return { content: [{ type: "text", text: "Invalid JSON for items parameter." }] };
      }

      const { doc: gitDoc, obj: git } = getGitDoc(index, area);
      const placeableList = getFieldList(git, "Placeable List");

      // Find container by tag
      const container = placeableList.find(p => getFieldStr(p, "Tag") === containerTag);
      if (!container) {
        const available = placeableList.map(p => getFieldStr(p, "Tag")).filter(Boolean).join(", ");
        return { content: [{ type: "text", text: `Container '${containerTag}' not found. Available: ${available}` }] };
      }

      snapshotGitForUndo(gitDoc, area, "add_items_to_container", `Add ${itemsArr.length} item(s) to ${containerTag}`);

      // Ensure container is useable and has inventory
      setField(container, "HasInventory", "byte", 1);
      setField(container, "Useable", "byte", 1);

      // Get or create ItemList
      let itemList = getFieldList(container, "ItemList");
      if (!container.ItemList) {
        container.ItemList = { type: "list", value: [] };
        itemList = (container.ItemList as { value: GffObj[] }).value;
      }

      const startSlot = itemList.length;
      const added: Array<{ resref: string; name: string }> = [];
      const failed: string[] = [];

      for (let i = 0; i < itemsArr.length; i++) {
        const { resref, quantity } = itemsArr[i];
        const itemDoc = await resolveBlueprint(index, resref, "uti", resmanOpts);
        if (!itemDoc) {
          failed.push(resref);
          continue;
        }

        const itemObj = itemDoc as GffObj;
        delete itemObj.__data_type;
        itemObj.__struct_id = 0;

        // Auto-assign inventory grid position (6-column grid)
        const slot = startSlot + added.length;
        setField(itemObj, "Repos_PosX", "word", slot % 6);
        setField(itemObj, "Repos_Posy", "word", Math.floor(slot / 6));
        setField(itemObj, "Identified", "byte", 1);

        if (quantity && quantity > 1) {
          setField(itemObj, "StackSize", "word", quantity);
        }

        itemList.push(itemObj);
        added.push({
          resref,
          name: getFieldLocStr(itemObj, "LocalizedName") || getFieldLocStr(itemObj, "LocName") || resref,
        });
      }

      await writeBackGit(index, area, gitDoc);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            area,
            container: containerTag,
            added,
            failed: failed.length > 0 ? failed : undefined,
            totalInventory: itemList.length,
          }, null, 2),
        }],
      };
    },
  );

  // ─── remove_items_from_container ──────────────────────────────────────

  server.tool(
    "remove_items_from_container",
    "Remove items from a placeable container's inventory by resref (all matching) or by index.",
    {
      area: z.string().describe("Area resref"),
      containerTag: z.string().describe("Tag of the placeable container"),
      itemResref: z.string().optional().describe("Remove all items matching this resref"),
      index: optNumParam("Remove a specific item by 0-based index"),
    },
    { destructiveHint: true },
    async ({ area, containerTag, itemResref, index: indexStr }) => {
      if (!itemResref && indexStr === undefined) {
        return { content: [{ type: "text", text: "Provide either itemResref or index." }] };
      }

      const moduleIndex = requireIndex();
      const { doc: gitDoc, obj: git } = getGitDoc(moduleIndex, area);
      const placeableList = getFieldList(git, "Placeable List");

      const container = placeableList.find(p => getFieldStr(p, "Tag") === containerTag);
      if (!container) {
        return { content: [{ type: "text", text: `Container '${containerTag}' not found in ${area}.` }] };
      }

      const itemList = getFieldList(container, "ItemList");
      if (itemList.length === 0) {
        return { content: [{ type: "text", text: `Container '${containerTag}' has no items.` }] };
      }

      snapshotGitForUndo(gitDoc, area, "remove_items_from_container", `Remove item(s) from ${containerTag}`);

      let removedCount = 0;

      if (indexStr !== undefined) {
        const removeIdx = toF(indexStr);
        if (removeIdx < 0 || removeIdx >= itemList.length) {
          return { content: [{ type: "text", text: `Index ${removeIdx} out of range (${itemList.length} items)` }] };
        }
        itemList.splice(removeIdx, 1);
        removedCount = 1;
      } else if (itemResref) {
        const resrefLower = itemResref.toLowerCase();
        // Remove in reverse to preserve indices
        for (let i = itemList.length - 1; i >= 0; i--) {
          const r = (getFieldStr(itemList[i], "InventoryRes") || getFieldStr(itemList[i], "TemplateResRef")).toLowerCase();
          if (r === resrefLower) {
            itemList.splice(i, 1);
            removedCount++;
          }
        }
      }

      await writeBackGit(moduleIndex, area, gitDoc);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            area,
            container: containerTag,
            removedCount,
            remainingItems: itemList.length,
          }, null, 2),
        }],
      };
    },
  );
}
