import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { requireIndex } from "../module-loader.js";
import { jsonToGff } from "../nim-tools.js";
import { getFieldStr, getFieldNum, getFieldLocStr, getFieldList, setField } from "../types/gff.js";
import type { GffObj } from "../types/gff.js";

export function registerAreaTools(server: McpServer): void {

  server.tool(
    "list_areas",
    "List all areas in the module with dimensions and object counts.",
    {},
    async () => {
      const index = requireIndex();
      const areas = [...index.areas.values()];
      return { content: [{ type: "text", text: JSON.stringify(areas, null, 2) }] };
    }
  );

  server.tool(
    "get_area_details",
    "Get full details for an area including properties, lighting, weather, and music.",
    { area: z.string().describe("Area resref (e.g., 'forest')") },
    async ({ area }) => {
      const index = requireIndex();
      const areDoc = index.parsedGff.get(`${area}.are`);
      const gitDoc = index.parsedGff.get(`${area}.git`);

      if (!areDoc) return { content: [{ type: "text", text: `Area not found: ${area}` }] };

      const are = areDoc as GffObj;
      const git = gitDoc as GffObj | undefined;

      const details: GffObj = {
        resref: area,
        name: getFieldLocStr(are, "Name"),
        width: getFieldNum(are, "Width"),
        height: getFieldNum(are, "Height"),
        tileset: getFieldStr(are, "Tileset"),
        isInterior: (getFieldNum(are, "Flags") & 1) !== 0,
        dayNightCycle: getFieldNum(are, "DayNightCycle"),
        isNight: getFieldNum(are, "IsNight"),
        lightingScheme: getFieldNum(are, "LightingScheme"),
        fogClipDist: getFieldNum(are, "FogClipDist"),
        weather: {
          chanceRain: getFieldNum(are, "ChanceRain"),
          chanceSnow: getFieldNum(are, "ChanceSnow"),
          chanceLightning: getFieldNum(are, "ChanceLightning"),
        },
        noRest: getFieldNum(are, "NoRest"),
      };

      if (git) {
        const props = git.AreaProperties as { value?: GffObj } | undefined;
        const propsObj = props?.value as GffObj | undefined;
        if (propsObj) {
          details.music = {
            musicDay: getFieldNum(propsObj, "MusicDay"),
            musicNight: getFieldNum(propsObj, "MusicNight"),
            musicBattle: getFieldNum(propsObj, "MusicBattle"),
          };
          details.ambientSound = {
            day: getFieldNum(propsObj, "AmbientSndDay"),
            dayVolume: getFieldNum(propsObj, "AmbientSndDayVol"),
            night: getFieldNum(propsObj, "AmbientSndNight"),
            nightVolume: getFieldNum(propsObj, "AmbientSndNitVol"),
          };
        }

        details.objectCounts = {
          creatures: getFieldList(git, "Creature List").length,
          placeables: getFieldList(git, "Placeable List").length,
          doors: getFieldList(git, "Door List").length,
          triggers: getFieldList(git, "Trigger List").length,
          encounters: getFieldList(git, "Encounter List").length,
          waypoints: getFieldList(git, "WaypointList").length,
          sounds: getFieldList(git, "SoundList").length,
          stores: getFieldList(git, "StoreList").length,
        };
      }

      return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }] };
    }
  );

  server.tool(
    "get_area_creatures",
    "List all creatures placed in a specific area with their stats.",
    { area: z.string().describe("Area resref") },
    async ({ area }) => {
      const index = requireIndex();
      const areaCreatures = index.creatures.filter(c => c.area === area);
      return { content: [{ type: "text", text: JSON.stringify(areaCreatures, null, 2) }] };
    }
  );

  server.tool(
    "get_area_placeables",
    "List all placeables in a specific area.",
    { area: z.string().describe("Area resref") },
    async ({ area }) => {
      const index = requireIndex();
      const gitDoc = index.parsedGff.get(`${area}.git`);
      if (!gitDoc) return { content: [{ type: "text", text: `Area GIT not found: ${area}` }] };

      const git = gitDoc as GffObj;
      const placeables = getFieldList(git, "Placeable List").map(p => {
        const hasInventory = getFieldNum(p, "HasInventory") === 1;
        const inventory = hasInventory
          ? getFieldList(p, "ItemList").map(item => ({
              resref: getFieldStr(item, "InventoryRes") || getFieldStr(item, "TemplateResRef"),
              name: getFieldLocStr(item, "LocalizedName") || getFieldLocStr(item, "LocName"),
              baseItem: getFieldNum(item, "BaseItem"),
              stackSize: getFieldNum(item, "StackSize") || 1,
            }))
          : [];
        return {
          tag: getFieldStr(p, "Tag"),
          name: getFieldLocStr(p, "LocName"),
          templateResRef: getFieldStr(p, "TemplateResRef"),
          position: {
            x: getFieldNum(p, "X"),
            y: getFieldNum(p, "Y"),
            z: getFieldNum(p, "Z"),
          },
          hasInventory,
          inventory,
          useable: getFieldNum(p, "Useable") === 1,
          static: getFieldNum(p, "Static") === 1,
          hp: getFieldNum(p, "CurrentHP"),
        };
      });

      return { content: [{ type: "text", text: JSON.stringify(placeables, null, 2) }] };
    }
  );

  server.tool(
    "get_area_items",
    "List all items placed on the ground in a specific area.",
    { area: z.string().describe("Area resref") },
    async ({ area }) => {
      const index = requireIndex();
      const gitDoc = index.parsedGff.get(`${area}.git`);
      if (!gitDoc) return { content: [{ type: "text", text: `Area GIT not found: ${area}` }] };

      const git = gitDoc as GffObj;
      const itemList = getFieldList(git, "List");
      const items = itemList.map(item => ({
        tag: getFieldStr(item, "Tag"),
        name: getFieldLocStr(item, "LocalizedName") || getFieldLocStr(item, "LocName"),
        templateResRef: getFieldStr(item, "TemplateResRef"),
        position: {
          x: getFieldNum(item, "X") ?? getFieldNum(item, "XPosition"),
          y: getFieldNum(item, "Y") ?? getFieldNum(item, "YPosition"),
          z: getFieldNum(item, "Z") ?? getFieldNum(item, "ZPosition"),
        },
        stackSize: getFieldNum(item, "StackSize") || 1,
        identified: getFieldNum(item, "Identified") === 1,
        dropable: getFieldNum(item, "Dropable") === 1,
      }));

      return { content: [{ type: "text", text: JSON.stringify(items, null, 2) }] };
    }
  );

  server.tool(
    "get_area_doors",
    "List all doors in a specific area with lock status and destinations.",
    { area: z.string().describe("Area resref") },
    async ({ area }) => {
      const index = requireIndex();
      const gitDoc = index.parsedGff.get(`${area}.git`);
      if (!gitDoc) return { content: [{ type: "text", text: `Area GIT not found: ${area}` }] };

      const git = gitDoc as GffObj;
      const doors = getFieldList(git, "Door List").map(d => ({
        tag: getFieldStr(d, "Tag"),
        name: getFieldLocStr(d, "LocName"),
        templateResRef: getFieldStr(d, "TemplateResRef"),
        linkedTo: getFieldStr(d, "LinkedTo"),
        linkedToFlags: getFieldNum(d, "LinkedToFlags"),
        locked: getFieldNum(d, "Locked") === 1,
        lockable: getFieldNum(d, "Lockable") === 1,
        keyRequired: getFieldNum(d, "KeyRequired") === 1,
        keyName: getFieldStr(d, "KeyName"),
        openLockDC: getFieldNum(d, "OpenLockDC"),
        hardness: getFieldNum(d, "Hardness"),
        hp: getFieldNum(d, "CurrentHP"),
      }));

      return { content: [{ type: "text", text: JSON.stringify(doors, null, 2) }] };
    }
  );

  // ─── set_area_scripts ─────────────────────────────────────���─────────────

  server.tool(
    "set_area_scripts",
    "Set event scripts on an area's ARE file. Pass empty string to clear a script.",
    {
      area: z.string().describe("Area resref"),
      onEnter: z.string().optional().describe("OnEnter script resref"),
      onExit: z.string().optional().describe("OnExit script resref"),
      onHeartbeat: z.string().optional().describe("OnHeartbeat script resref"),
      onUserDefined: z.string().optional().describe("OnUserDefined script resref"),
    },
    async ({ area, onEnter, onExit, onHeartbeat, onUserDefined }) => {
      const index = requireIndex();
      const areKey = `${area.toLowerCase()}.are`;
      const areDoc = index.parsedGff.get(areKey);
      if (!areDoc) return { content: [{ type: "text", text: `Area not found: ${area}` }] };

      const areEntry = index.resources.get(areKey);
      if (!areEntry) return { content: [{ type: "text", text: `Area resource not found: ${areKey}` }] };

      const are = areDoc as GffObj;
      const changes: string[] = [];

      const FIELD_MAP: Record<string, string> = {
        onEnter: "OnEnter",
        onExit: "OnExit",
        onHeartbeat: "OnHeartbeat",
        onUserDefined: "OnUserDefined",
      };

      const params: Record<string, string | undefined> = { onEnter, onExit, onHeartbeat, onUserDefined };
      for (const [paramName, fieldName] of Object.entries(FIELD_MAP)) {
        const value = params[paramName];
        if (value !== undefined) {
          setField(are, fieldName, "resref", value);
          changes.push(`${fieldName} = "${value}"`);
        }
      }

      if (changes.length === 0) {
        return { content: [{ type: "text", text: "No scripts provided. Pass at least one of: onEnter, onExit, onHeartbeat, onUserDefined." }] };
      }

      await jsonToGff(areDoc, areEntry.filePath);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({ success: true, area, changes }, null, 2),
        }],
      };
    },
  );

  // ─── set_module_scripts ─────────────────────────────────────────────────

  server.tool(
    "set_module_scripts",
    "Set event scripts on the module IFO. Pass empty string to clear a script.",
    {
      Mod_OnAcquirItem: z.string().optional().describe("OnAcquireItem script"),
      Mod_OnActvtItem: z.string().optional().describe("OnActivateItem script"),
      Mod_OnClientEntr: z.string().optional().describe("OnClientEnter script"),
      Mod_OnClientLeav: z.string().optional().describe("OnClientLeave script"),
      Mod_OnCutsnAbort: z.string().optional().describe("OnCutsceneAbort script"),
      Mod_OnHeartbeat: z.string().optional().describe("OnHeartbeat script"),
      Mod_OnModLoad: z.string().optional().describe("OnModuleLoad script"),
      Mod_OnModStart: z.string().optional().describe("OnModuleStart script"),
      Mod_OnPlrChat: z.string().optional().describe("OnPlayerChat script"),
      Mod_OnPlrDeath: z.string().optional().describe("OnPlayerDeath script"),
      Mod_OnPlrDying: z.string().optional().describe("OnPlayerDying script"),
      Mod_OnPlrEqItm: z.string().optional().describe("OnPlayerEquipItem script"),
      Mod_OnPlrLvlUp: z.string().optional().describe("OnPlayerLevelUp script"),
      Mod_OnPlrRest: z.string().optional().describe("OnPlayerRest script"),
      Mod_OnPlrUnEqItm: z.string().optional().describe("OnPlayerUnEquipItem script"),
      Mod_OnSpawnBtnDn: z.string().optional().describe("OnSpawnButtonDown script"),
      Mod_OnUnAqreItem: z.string().optional().describe("OnUnAcquireItem script"),
      Mod_OnUsrDefined: z.string().optional().describe("OnUserDefined script"),
    },
    async (params) => {
      const index = requireIndex();
      const ifoDoc = index.parsedGff.get("module.ifo");
      if (!ifoDoc) return { content: [{ type: "text", text: "Module IFO not found" }] };

      const ifoEntry = index.resources.get("module.ifo");
      if (!ifoEntry) return { content: [{ type: "text", text: "Module IFO resource not found" }] };

      const ifo = ifoDoc as GffObj;
      const changes: string[] = [];

      for (const [fieldName, value] of Object.entries(params)) {
        if (value !== undefined && fieldName.startsWith("Mod_On")) {
          setField(ifo, fieldName, "resref", value);
          changes.push(`${fieldName} = "${value}"`);
        }
      }

      if (changes.length === 0) {
        return { content: [{ type: "text", text: "No scripts provided." }] };
      }

      await jsonToGff(ifoDoc, ifoEntry.filePath);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({ success: true, changes }, null, 2),
        }],
      };
    },
  );
}
