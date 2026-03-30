import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { requireIndex } from "../module-loader.js";
import { getFieldStr, getFieldNum, getFieldLocStr, getFieldList } from "../types/gff.js";
import type { GffObj } from "../types/gff.js";

export function registerEncounterTools(server: McpServer): void {

  server.tool(
    "get_area_triggers",
    "List all triggers in a specific area with type, scripts, and linked destination.",
    { area: z.string().describe("Area resref") },
    async ({ area }) => {
      const index = requireIndex();
      const gitDoc = index.parsedGff.get(`${area}.git`);
      if (!gitDoc) return { content: [{ type: "text", text: `Area not found: ${area}` }] };

      const triggerList = getFieldList(gitDoc as GffObj, "Trigger List");
      const triggers = triggerList.map(t => ({
        tag: getFieldStr(t, "Tag"),
        name: getFieldLocStr(t, "LocalizedName"),
        type: getFieldNum(t, "Type"),
        linkedTo: getFieldStr(t, "LinkedTo"),
        linkedToFlags: getFieldNum(t, "LinkedToFlags"),
        scripts: {
          onEnter: getFieldStr(t, "OnEnter") || getFieldStr(t, "ScriptOnEnter"),
          onExit: getFieldStr(t, "OnExit") || getFieldStr(t, "ScriptOnExit"),
          onClick: getFieldStr(t, "OnClick"),
          onDisarm: getFieldStr(t, "OnDisarm"),
          onTrapTriggered: getFieldStr(t, "OnTrapTriggered"),
          heartbeat: getFieldStr(t, "ScriptHeartbeat"),
          userDefined: getFieldStr(t, "ScriptUserDefine"),
        },
        position: {
          x: getFieldNum(t, "XPosition"),
          y: getFieldNum(t, "YPosition"),
          z: getFieldNum(t, "ZPosition"),
        },
      }));

      return { content: [{ type: "text", text: JSON.stringify(triggers, null, 2) }] };
    }
  );

  server.tool(
    "get_area_encounters",
    "List all encounters in a specific area with creature list and spawn conditions.",
    { area: z.string().describe("Area resref") },
    async ({ area }) => {
      const index = requireIndex();
      const gitDoc = index.parsedGff.get(`${area}.git`);
      if (!gitDoc) return { content: [{ type: "text", text: `Area not found: ${area}` }] };

      const encounterList = getFieldList(gitDoc as GffObj, "Encounter List");
      const encounters = encounterList.map(e => {
        const creatureList = getFieldList(e, "CreatureList").map(c => ({
          resref: getFieldStr(c, "Resref"),
          appearance: getFieldNum(c, "Appearance"),
          cr: getFieldNum(c, "CR"),
          singleSpawn: getFieldNum(c, "SingleSpawn"),
        }));

        return {
          tag: getFieldStr(e, "Tag"),
          name: getFieldLocStr(e, "LocalizedName"),
          active: getFieldNum(e, "Active"),
          difficulty: getFieldNum(e, "DifficultyIndex"),
          maxCreatures: getFieldNum(e, "MaxCreatures"),
          recCreatures: getFieldNum(e, "RecCreatures"),
          respawns: getFieldNum(e, "Respawns"),
          respawnTime: getFieldNum(e, "RespawnTime"),
          creatures: creatureList,
          scripts: {
            onEntered: getFieldStr(e, "OnEntered"),
            onExhausted: getFieldStr(e, "OnExhausted"),
            onExit: getFieldStr(e, "OnExit"),
            heartbeat: getFieldStr(e, "ScriptHeartbeat"),
            userDefined: getFieldStr(e, "ScriptUserDefine"),
          },
          position: {
            x: getFieldNum(e, "XPosition"),
            y: getFieldNum(e, "YPosition"),
            z: getFieldNum(e, "ZPosition"),
          },
        };
      });

      return { content: [{ type: "text", text: JSON.stringify(encounters, null, 2) }] };
    }
  );

  server.tool(
    "list_stores",
    "List all stores in the module with name and markup.",
    {},
    async () => {
      const index = requireIndex();
      const stores: unknown[] = [];

      for (const [key, entry] of index.resources) {
        if (entry.extension === "utm") {
          const doc = index.parsedGff.get(key);
          if (doc) {
            const obj = doc as GffObj;
            stores.push({
              resref: entry.resref,
              tag: getFieldStr(obj, "Tag"),
              name: getFieldLocStr(obj, "LocName"),
              markUp: getFieldNum(obj, "MarkUp"),
              markDown: getFieldNum(obj, "MarkDown"),
              blackMarket: getFieldNum(obj, "BlackMarket"),
              identifyPrice: getFieldNum(obj, "IdentifyPrice"),
              maxBuyPrice: getFieldNum(obj, "MaxBuyPrice"),
              storeGold: getFieldNum(obj, "StoreGold"),
            });
          }
        }
      }

      return { content: [{ type: "text", text: JSON.stringify(stores, null, 2) }] };
    }
  );

  server.tool(
    "get_store_details",
    "Get full details for a store including inventory and pricing.",
    { resref: z.string().describe("Store resref") },
    async ({ resref }) => {
      const index = requireIndex();
      const doc = index.parsedGff.get(`${resref}.utm`);
      if (!doc) return { content: [{ type: "text", text: `Store not found: ${resref}` }] };

      const obj = doc as GffObj;

      // Stores have inventory in StoreList (list of item categories)
      const storeList = getFieldList(obj, "StoreList");
      const inventory = storeList.map((category, i) => {
        const items = getFieldList(category, "ItemList").map(item => ({
          resref: getFieldStr(item, "InventoryRes"),
          name: getFieldLocStr(item, "LocalizedName") || getFieldLocStr(item, "LocName"),
          infinite: getFieldNum(item, "Infinite"),
        }));
        return { categoryIndex: i, items };
      });

      const details = {
        resref,
        tag: getFieldStr(obj, "Tag"),
        name: getFieldLocStr(obj, "LocName"),
        markUp: getFieldNum(obj, "MarkUp"),
        markDown: getFieldNum(obj, "MarkDown"),
        blackMarket: getFieldNum(obj, "BlackMarket"),
        identifyPrice: getFieldNum(obj, "IdentifyPrice"),
        maxBuyPrice: getFieldNum(obj, "MaxBuyPrice"),
        storeGold: getFieldNum(obj, "StoreGold"),
        inventory,
        scripts: {
          onOpen: getFieldStr(obj, "OnOpenStore") || getFieldStr(obj, "OnStorOpen"),
          onClose: getFieldStr(obj, "OnClosStore"),
        },
      };

      return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }] };
    }
  );

  server.tool(
    "get_area_waypoints",
    "List all waypoints in a specific area with tag, position, and map note.",
    { area: z.string().describe("Area resref") },
    async ({ area }) => {
      const index = requireIndex();
      const gitDoc = index.parsedGff.get(`${area}.git`);
      if (!gitDoc) return { content: [{ type: "text", text: `Area not found: ${area}` }] };

      const waypointList = getFieldList(gitDoc as GffObj, "WaypointList");
      const waypoints = waypointList.map(w => ({
        tag: getFieldStr(w, "Tag"),
        name: getFieldLocStr(w, "LocalizedName"),
        description: getFieldLocStr(w, "Description"),
        hasMapNote: getFieldNum(w, "HasMapNote"),
        mapNote: getFieldLocStr(w, "MapNote"),
        mapNoteEnabled: getFieldNum(w, "MapNoteEnabled"),
        position: {
          x: getFieldNum(w, "XPosition"),
          y: getFieldNum(w, "YPosition"),
          z: getFieldNum(w, "ZPosition"),
        },
      }));

      return { content: [{ type: "text", text: JSON.stringify(waypoints, null, 2) }] };
    }
  );

  server.tool(
    "get_area_sounds",
    "List all sound objects in a specific area.",
    { area: z.string().describe("Area resref") },
    async ({ area }) => {
      const index = requireIndex();
      const gitDoc = index.parsedGff.get(`${area}.git`);
      if (!gitDoc) return { content: [{ type: "text", text: `Area not found: ${area}` }] };

      const soundList = getFieldList(gitDoc as GffObj, "SoundList");
      const sounds = soundList.map(s => ({
        tag: getFieldStr(s, "Tag"),
        name: getFieldLocStr(s, "LocName"),
        active: getFieldNum(s, "Active"),
        continuous: getFieldNum(s, "Continuous"),
        looping: getFieldNum(s, "Looping"),
        volume: getFieldNum(s, "Volume"),
        volumeVrtn: getFieldNum(s, "VolumeVrtn"),
        maxDistance: getFieldNum(s, "MaxDistance"),
        position: {
          x: getFieldNum(s, "XPosition"),
          y: getFieldNum(s, "YPosition"),
          z: getFieldNum(s, "ZPosition"),
        },
      }));

      return { content: [{ type: "text", text: JSON.stringify(sounds, null, 2) }] };
    }
  );

  server.tool(
    "get_faction_details",
    "List factions and reputation relationships from the module's .fac file.",
    {},
    async () => {
      const index = requireIndex();

      // Find the .fac file (usually repute.fac)
      let facDoc: GffObj | null = null;
      for (const [key, entry] of index.resources) {
        if (entry.extension === "fac") {
          const doc = index.parsedGff.get(key);
          if (doc) {
            facDoc = doc as GffObj;
            break;
          }
        }
      }

      if (!facDoc) {
        return { content: [{ type: "text", text: "No faction file (.fac) found in module." }] };
      }

      const factionList = getFieldList(facDoc, "FactionList");
      const factions = factionList.map((f, i) => ({
        id: i,
        name: getFieldStr(f, "FactionName"),
        parentId: getFieldNum(f, "FactionParentID"),
        global: getFieldNum(f, "FactionGlobal"),
      }));

      const repList = getFieldList(facDoc, "RepList");
      const reputations = repList.map(r => ({
        factionId1: getFieldNum(r, "FactionID1"),
        factionId2: getFieldNum(r, "FactionID2"),
        reputation: getFieldNum(r, "FactionRep"),
      }));

      return {
        content: [{
          type: "text",
          text: JSON.stringify({ factions, reputations }, null, 2),
        }],
      };
    }
  );

  server.tool(
    "get_faction_creatures",
    "List all creatures that belong to a specific faction.",
    {
      factionId: z.coerce.number().describe("Faction ID to filter by"),
    },
    async ({ factionId }) => {
      const index = requireIndex();
      const matching = index.creatures
        .filter(c => c.faction === factionId)
        .map(c => ({
          tag: c.tag,
          name: `${c.firstName} ${c.lastName}`.trim(),
          area: c.area,
          cr: c.cr,
          hp: c.hp,
          classes: c.classes,
        }));

      return { content: [{ type: "text", text: JSON.stringify(matching, null, 2) }] };
    }
  );
}
