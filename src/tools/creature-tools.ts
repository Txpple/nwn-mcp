import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { requireIndex, buildResmanOptions } from "../module-loader.js";
import { resolveBlueprint, getGitDoc, writeBackGit } from "../util/git-helpers.js";
import { getFieldStr, getFieldNum, getFieldLocStr, getFieldList, setField } from "../types/gff.js";
import type { GffObj } from "../types/gff.js";
import { EQUIP_SLOT_MAP, EQUIP_SLOT_NAMES } from "../util/equip-slots.js";
import { snapshotGitForUndo } from "../util/undo.js";

export function registerCreatureTools(server: McpServer): void {

  server.tool(
    "list_creatures",
    "List all creatures in the module, optionally filtered by area.",
    { area: z.string().optional().describe("Filter by area resref") },
    { readOnlyHint: true, idempotentHint: true },
    async ({ area }) => {
      const index = requireIndex();
      let creatures = index.creatures;
      if (area) {
        creatures = creatures.filter(c => c.area === area);
      }
      return { content: [{ type: "text", text: JSON.stringify(creatures, null, 2) }] };
    }
  );

  server.tool(
    "get_creature_details",
    "Get full details for a specific creature including stats, feats, equipment, and scripts.",
    {
      tag: z.string().optional().describe("Creature tag to find"),
      area: z.string().optional().describe("Area resref (required with index)"),
      index: z.coerce.number().optional().describe("Creature index in area's creature list"),
    },
    { readOnlyHint: true, idempotentHint: true },
    async ({ tag, area, index: creatureIndex }) => {
      const moduleIndex = requireIndex();

      let creatureData: GffObj | null = null;
      let foundArea = "";

      if (tag) {
        // Find by tag — search all area GITs
        for (const [areaResref] of moduleIndex.areas) {
          const gitDoc = moduleIndex.parsedGff.get(`${areaResref}.git`);
          if (!gitDoc) continue;
          const creatures = getFieldList(gitDoc as GffObj, "Creature List");
          const match = creatures.find(c => getFieldStr(c, "Tag") === tag);
          if (match) {
            creatureData = match;
            foundArea = areaResref;
            break;
          }
        }
      } else if (area && creatureIndex !== undefined) {
        const gitDoc = moduleIndex.parsedGff.get(`${area}.git`);
        if (gitDoc) {
          const creatures = getFieldList(gitDoc as GffObj, "Creature List");
          if (creatureIndex >= 0 && creatureIndex < creatures.length) {
            creatureData = creatures[creatureIndex];
            foundArea = area;
          }
        }
      }

      if (!creatureData) {
        return { content: [{ type: "text", text: "Creature not found" }] };
      }

      const c = creatureData;
      const classList = getFieldList(c, "ClassList").map(cls => ({
        classId: getFieldNum(cls, "Class"),
        level: getFieldNum(cls, "ClassLevel"),
      }));

      const featList = getFieldList(c, "FeatList").map(f => getFieldNum(f, "Feat"));

      const skillList = getFieldList(c, "SkillList").map(s => getFieldNum(s, "Rank"));

      // Equipment is in Equip_ItemList — each struct's __struct_id is a bitmask for the slot
      const EQUIP_SLOTS: Record<number, string> = {
        1: "Head", 2: "Chest", 4: "Boots", 8: "Arms",
        16: "RightHand", 32: "LeftHand", 64: "Cloak",
        128: "LeftRing", 256: "RightRing", 512: "Neck",
        1024: "Belt", 2048: "Arrows", 4096: "Bullets",
        8192: "Bolts", 16384: "CreWeaponR", 32768: "CreWeaponL",
        65536: "CreWeaponB",
      };
      const equipList: GffObj = {};
      const equipItems = getFieldList(c, "Equip_ItemList");
      for (const item of equipItems) {
        const structId = (item as GffObj).__struct_id as number;
        const slotName = EQUIP_SLOTS[structId] || `Slot_${structId}`;
        equipList[slotName] = {
          resref: getFieldStr(item, "EquippedRes"),
          name: getFieldLocStr(item, "LocalizedName") || getFieldLocStr(item, "LocName"),
          baseItem: getFieldNum(item, "BaseItem"),
        };
      }

      // Parse carried (non-equipped) inventory
      const inventoryItems = getFieldList(c, "ItemList").map(item => ({
        resref: getFieldStr(item, "InventoryRes") || getFieldStr(item, "TemplateResRef"),
        name: getFieldLocStr(item, "LocalizedName") || getFieldLocStr(item, "LocName"),
        baseItem: getFieldNum(item, "BaseItem"),
        stackSize: getFieldNum(item, "StackSize") || 1,
        identified: getFieldNum(item, "Identified") === 1,
      }));

      const details = {
        area: foundArea,
        tag: getFieldStr(c, "Tag"),
        firstName: getFieldLocStr(c, "FirstName"),
        lastName: getFieldLocStr(c, "LastName"),
        description: getFieldLocStr(c, "Description"),
        race: getFieldNum(c, "Race"),
        gender: getFieldNum(c, "Gender"),
        appearance: getFieldNum(c, "Appearance_Type"),
        challengeRating: getFieldNum(c, "ChallengeRating"),
        stats: {
          str: getFieldNum(c, "Str"),
          dex: getFieldNum(c, "Dex"),
          con: getFieldNum(c, "Con"),
          int: getFieldNum(c, "Int"),
          wis: getFieldNum(c, "Wis"),
          cha: getFieldNum(c, "Cha"),
        },
        hp: {
          current: getFieldNum(c, "CurrentHitPoints"),
          max: getFieldNum(c, "MaxHitPoints"),
          base: getFieldNum(c, "BaseHP"),
        },
        ac: {
          natural: getFieldNum(c, "NaturalAC"),
        },
        classes: classList,
        feats: featList,
        skills: skillList,
        equipment: equipList,
        inventory: inventoryItems,
        factionId: getFieldNum(c, "FactionID"),
        conversation: getFieldStr(c, "Conversation"),
        scripts: {
          heartbeat: getFieldStr(c, "ScriptHeartbeat"),
          onNotice: getFieldStr(c, "ScriptOnNotice"),
          spellAt: getFieldStr(c, "ScriptSpellAt"),
          attacked: getFieldStr(c, "ScriptAttacked"),
          damaged: getFieldStr(c, "ScriptDamaged"),
          death: getFieldStr(c, "ScriptDeath"),
          disturbed: getFieldStr(c, "ScriptDisturbed"),
          endRound: getFieldStr(c, "ScriptEndRound"),
          dialogue: getFieldStr(c, "ScriptDialogue"),
          spawn: getFieldStr(c, "ScriptSpawn"),
          rested: getFieldStr(c, "ScriptRested"),
          userDefined: getFieldStr(c, "ScriptUserDefine"),
        },
        position: {
          x: getFieldNum(c, "XPosition"),
          y: getFieldNum(c, "YPosition"),
          z: getFieldNum(c, "ZPosition"),
        },
      };

      return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }] };
    }
  );

  // ─── set_creature_equipment ───────────────────────────────────────────

  server.tool(
    "set_creature_equipment",
    "Set equipment on a placed creature in an area. Merges with existing equipment by default; use replace=true to clear first.",
    {
      area: z.string().describe("Area resref"),
      tag: z.string().describe("Creature tag"),
      equipment: z.string().describe("JSON object: {\"righthand\": \"nw_wswls001\", \"chest\": \"nw_cloth001\"}"),
      replace: z.boolean().optional().default(false).describe("Replace all equipment (true) or merge (false, default)"),
    },
    { idempotentHint: true },
    async ({ area, tag, equipment: equipJson, replace }) => {
      const index = requireIndex();
      const resmanOpts = await buildResmanOptions(index);

      let equipMap: Record<string, string>;
      try {
        equipMap = JSON.parse(equipJson);
      } catch {
        return { content: [{ type: "text", text: "Invalid JSON for equipment parameter." }] };
      }

      // Find creature in GIT
      const { doc: gitDoc, obj: git } = getGitDoc(index, area);
      const creatureList = getFieldList(git, "Creature List");
      const creature = creatureList.find(c => getFieldStr(c, "Tag") === tag);
      if (!creature) {
        const available = creatureList.map(c => getFieldStr(c, "Tag")).filter(Boolean).join(", ");
        return { content: [{ type: "text", text: `Creature '${tag}' not found in ${area}. Available: ${available}` }] };
      }

      snapshotGitForUndo(gitDoc, area, "set_creature_equipment", `Set equipment on ${tag}`);

      // Get or create Equip_ItemList
      let equipList = getFieldList(creature, "Equip_ItemList");
      if (replace) {
        creature.Equip_ItemList = { type: "list", value: [] };
        equipList = (creature.Equip_ItemList as { value: GffObj[] }).value;
      } else if (!creature.Equip_ItemList) {
        creature.Equip_ItemList = { type: "list", value: [] };
        equipList = (creature.Equip_ItemList as { value: GffObj[] }).value;
      }

      const added: Array<{ slot: string; resref: string }> = [];
      const failed: string[] = [];

      for (const [slotName, itemResref] of Object.entries(equipMap)) {
        const slotId = EQUIP_SLOT_MAP[slotName.toLowerCase()];
        if (slotId === undefined) {
          failed.push(`Unknown slot: ${slotName}`);
          continue;
        }

        const itemDoc = await resolveBlueprint(index, itemResref, "uti", resmanOpts);
        if (!itemDoc) {
          failed.push(`Blueprint not found: ${itemResref}`);
          continue;
        }

        const itemObj = itemDoc as GffObj;
        delete itemObj.__data_type;
        itemObj.__struct_id = slotId;
        setField(itemObj, "Dropable", "byte", 1);

        // Remove existing item in this slot (merge mode)
        if (!replace) {
          const existingIdx = equipList.findIndex(e => (e as GffObj).__struct_id === slotId);
          if (existingIdx >= 0) equipList.splice(existingIdx, 1);
        }

        equipList.push(itemObj);
        added.push({ slot: slotName, resref: itemResref });
      }

      await writeBackGit(index, area, gitDoc);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            area,
            creature: tag,
            mode: replace ? "replace" : "merge",
            added,
            failed: failed.length > 0 ? failed : undefined,
            totalEquipped: equipList.length,
          }, null, 2),
        }],
      };
    },
  );

  // ─── clear_creature_equipment ─────────────────────────────────────────

  server.tool(
    "clear_creature_equipment",
    "Remove all or specific equipment from a placed creature.",
    {
      area: z.string().describe("Area resref"),
      tag: z.string().describe("Creature tag"),
      slot: z.string().optional().describe("Specific slot name to clear (e.g., 'righthand'). Omit to clear all."),
    },
    { destructiveHint: true },
    async ({ area, tag, slot }) => {
      const index = requireIndex();
      const { doc: gitDoc, obj: git } = getGitDoc(index, area);
      const creatureList = getFieldList(git, "Creature List");
      const creature = creatureList.find(c => getFieldStr(c, "Tag") === tag);
      if (!creature) {
        return { content: [{ type: "text", text: `Creature '${tag}' not found in ${area}.` }] };
      }

      snapshotGitForUndo(gitDoc, area, "clear_creature_equipment", `Clear equipment on ${tag}`);

      const equipList = getFieldList(creature, "Equip_ItemList");
      let removedCount = 0;

      if (slot) {
        const slotId = EQUIP_SLOT_MAP[slot.toLowerCase()];
        if (slotId === undefined) {
          return { content: [{ type: "text", text: `Unknown slot: ${slot}. Valid: ${Object.keys(EQUIP_SLOT_MAP).join(", ")}` }] };
        }
        const idx = equipList.findIndex(e => (e as GffObj).__struct_id === slotId);
        if (idx >= 0) {
          equipList.splice(idx, 1);
          removedCount = 1;
        }
      } else {
        removedCount = equipList.length;
        setField(creature, "Equip_ItemList", "list", []);
      }

      await writeBackGit(index, area, gitDoc);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            area,
            creature: tag,
            removedCount,
            slot: slot || "all",
            remainingEquipped: slot ? equipList.length : 0,
          }, null, 2),
        }],
      };
    },
  );
}
