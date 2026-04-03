/**
 * Blueprint creation MCP tools.
 *
 * Tools:
 * - create_creature_blueprint: Create a new UTC blueprint from scratch or cloned from base game
 * - create_encounter_blueprint: Create a new UTE encounter blueprint
 * - create_store_blueprint: Create a new UTM store blueprint with inventory
 */

import { z } from "zod";
import path from "path";
import fs from "fs/promises";

import { optNumParam, toI, toF } from "../util/params.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { requireIndex, buildResmanOptions } from "../module-loader.js";
import { jsonToGff } from "../nim-tools.js";
import { resolveBlueprint, buildMinimalUtc, buildMinimalUte, buildMinimalUtm } from "../util/git-helpers.js";
import { setField, getFieldList, getFieldNum } from "../types/gff.js";
import type { GffDocument, GffObj } from "../types/gff.js";
import { EQUIP_SLOT_MAP } from "../util/equip-slots.js";

export function registerBlueprintTools(server: McpServer): void {

  // ─── create_creature_blueprint ─────────────────────────────────────────

  server.tool(
    "create_creature_blueprint",
    "Create a new creature blueprint (.utc). Optionally clone from a base game or module creature and apply overrides.",
    {
      resref: z.string().describe("New creature resref"),
      tag: z.string().describe("Creature tag"),
      name: z.string().describe("Creature display name (first name)"),
      sourceResref: z.string().optional().describe("Base creature to clone from (e.g. 'nw_dog', 'nw_oldman')"),
      appearance: optNumParam("Appearance row from appearance.2da"),
      faction: optNumParam("Faction ID"),
      cr: optNumParam("Challenge rating"),
      hp: optNumParam("Hit points"),
      race: optNumParam("Racial type (racialtypes.2da row)"),
      gender: optNumParam("Gender (0=male, 1=female)"),
      conversation: z.string().optional().describe("Dialog resref"),
      str: optNumParam("Strength"),
      dex: optNumParam("Dexterity"),
      con: optNumParam("Constitution"),
      int: optNumParam("Intelligence"),
      wis: optNumParam("Wisdom"),
      cha: optNumParam("Charisma"),
      naturalAC: optNumParam("Natural armor class"),
      classes: z.string().optional().describe("JSON array of {class, level} objects. Replaces ClassList. Class IDs: 0=Barbarian 1=Bard 2=Cleric 3=Druid 4=Fighter 5=Monk 6=Paladin 7=Ranger 8=Rogue 9=Sorcerer 10=Wizard"),
      feats: z.string().optional().describe("JSON array of feat IDs (integers). Replaces FeatList."),
      spells: z.string().optional().describe("JSON array of {spell, level} objects. Sets SpecAbilityList (spell-like abilities). spell=spells.2da row, level=caster level."),
      equipment: z.string().optional().describe("JSON object mapping slot names to item resrefs. Resolves from base game/HAKs. Slots: head, chest, boots, arms, righthand, lefthand, cloak, leftring, rightring, neck, belt, arrows, bullets, bolts"),
      inventory: z.string().optional().describe("JSON array of carried (non-equipped) items: [{resref: 'nw_waxhn001', quantity?: 1}]. Dropped on death if creature is lootable."),
      lootable: z.boolean().optional().describe("Whether the creature leaves a lootable corpse (default false)"),
    },
    async ({ resref, tag, name, sourceResref, appearance, faction, cr, hp, race, gender, conversation, str, dex, con, int: intStat, wis, cha, naturalAC, classes, feats, spells, equipment, inventory, lootable }) => {
      const index = requireIndex();
      const resrefLower = resref.toLowerCase();
      const key = `${resrefLower}.utc`;

      if (index.resources.has(key)) {
        return { content: [{ type: "text", text: `Resource already exists: ${key}` }] };
      }

      // Build resman options lazily — needed for sourceResref and equipment
      const needsResman = !!sourceResref || !!equipment;
      const resmanOpts = needsResman ? await buildResmanOptions(index) : undefined;

      let doc: GffDocument;

      if (sourceResref) {
        // Clone from source
        const source = await resolveBlueprint(index, sourceResref, "utc", resmanOpts!);
        if (!source) {
          return { content: [{ type: "text", text: `Source blueprint not found: ${sourceResref}.utc` }] };
        }
        doc = source;
      } else {
        // Build minimal UTC from scratch
        doc = buildMinimalUtc();
      }

      const obj = doc as GffObj;

      // Apply overrides
      obj.__data_type = "UTC ";
      setField(obj, "Tag", "cexostring", tag);
      setField(obj, "TemplateResRef", "resref", resrefLower);
      obj.FirstName = { type: "cexolocstring", value: { "0": name } };

      if (appearance !== undefined) setField(obj, "Appearance_Type", "word", toI(appearance));
      if (faction !== undefined) setField(obj, "FactionID", "word", toI(faction));
      if (cr !== undefined) setField(obj, "ChallengeRating", "float", toF(cr));
      if (hp !== undefined) {
        setField(obj, "MaxHitPoints", "short", toI(hp));
        setField(obj, "CurrentHitPoints", "short", toI(hp));
        setField(obj, "HitPoints", "short", toI(hp));
      }
      if (race !== undefined) setField(obj, "Race", "byte", toI(race));
      if (gender !== undefined) setField(obj, "Gender", "byte", toI(gender));
      if (conversation !== undefined) setField(obj, "Conversation", "resref", conversation);
      if (str !== undefined) setField(obj, "Str", "byte", toI(str));
      if (dex !== undefined) setField(obj, "Dex", "byte", toI(dex));
      if (con !== undefined) setField(obj, "Con", "byte", toI(con));
      if (intStat !== undefined) setField(obj, "Int", "byte", toI(intStat));
      if (wis !== undefined) setField(obj, "Wis", "byte", toI(wis));
      if (cha !== undefined) setField(obj, "Cha", "byte", toI(cha));
      if (naturalAC !== undefined) setField(obj, "NaturalAC", "byte", toI(naturalAC));
      if (lootable !== undefined) setField(obj, "Lootable", "byte", lootable ? 1 : 0);

      // Ensure default AI scripts are set (source creatures may have blanks
      // or custom scripts — standardize to nw_c2_default* series)
      const defaultScripts: Record<string, string> = {
        ScriptAttacked: "nw_c2_default5",
        ScriptDamaged: "nw_c2_default6",
        ScriptDeath: "nw_c2_default7",
        ScriptDialogue: "nw_c2_default4",
        ScriptDisturbed: "nw_c2_default8",
        ScriptEndRound: "nw_c2_default3",
        ScriptHeartbeat: "nw_c2_default1",
        ScriptOnBlocked: "nw_c2_defaulte",
        ScriptPercption: "nw_c2_default2",
        ScriptRested: "nw_c2_defaulta",
        ScriptSpawn: "nw_c2_default9",
        ScriptSpellAt: "nw_c2_defaultb",
        ScriptUserDefine: "nw_c2_defaultd",
      };
      for (const [field, script] of Object.entries(defaultScripts)) {
        setField(obj, field, "resref", script);
      }

      // Classes — replaces ClassList
      if (classes) {
        const parsed: Array<{ class: number; level: number }> = JSON.parse(classes);
        obj.ClassList = {
          type: "list",
          value: parsed.map(c => ({
            __struct_id: 2,
            Class: { type: "int", value: c.class },
            ClassLevel: { type: "short", value: c.level },
          })),
        };
      }

      // Feats — replaces FeatList
      if (feats) {
        const parsed: number[] = JSON.parse(feats);
        obj.FeatList = {
          type: "list",
          value: parsed.map(f => ({
            __struct_id: 1,
            Feat: { type: "word", value: f },
          })),
        };
      }

      // Spell-like abilities — replaces SpecAbilityList
      if (spells) {
        const parsed: Array<{ spell: number; level: number }> = JSON.parse(spells);
        obj.SpecAbilityList = {
          type: "list",
          value: parsed.map(s => ({
            __struct_id: 0,
            Spell: { type: "word", value: s.spell },
            SpellCasterLevel: { type: "byte", value: s.level },
            SpellFlags: { type: "byte", value: 1 },
          })),
        };
      }

      // Equipment — resolves item blueprints and embeds in Equip_ItemList
      if (equipment) {
        const parsed: Record<string, string> = JSON.parse(equipment);
        const equipList: GffObj[] = [];
        const failedItems: string[] = [];

        for (const [slotName, itemResref] of Object.entries(parsed)) {
          const slotId = EQUIP_SLOT_MAP[slotName.toLowerCase()];
          if (slotId === undefined) {
            failedItems.push(`Unknown slot: ${slotName}`);
            continue;
          }
          const itemDoc = await resolveBlueprint(index, itemResref, "uti", resmanOpts!);
          if (!itemDoc) {
            failedItems.push(`Item not found: ${itemResref}.uti`);
            continue;
          }
          const itemObj = itemDoc as GffObj;
          itemObj.__struct_id = slotId;
          setField(itemObj, "Dropable", "byte", 1);
          equipList.push(itemObj);
        }

        obj.Equip_ItemList = { type: "list", value: equipList };

        if (failedItems.length > 0) {
          // Still create the creature, just warn about missing items
          console.error(`Equipment warnings for ${resrefLower}: ${failedItems.join(", ")}`);
        }
      }

      // Inventory — carried (non-equipped) items, dropped on death if lootable
      if (inventory) {
        const parsed: Array<{ resref: string; quantity?: number }> = JSON.parse(inventory);
        const itemList: GffObj[] = [];
        const failedInv: string[] = [];

        for (let i = 0; i < parsed.length; i++) {
          const { resref: itemResref, quantity } = parsed[i];
          const itemDoc = await resolveBlueprint(index, itemResref, "uti", resmanOpts!);
          if (!itemDoc) {
            failedInv.push(`Item not found: ${itemResref}.uti`);
            continue;
          }
          const itemObj = itemDoc as GffObj;
          itemObj.__struct_id = 0;
          setField(itemObj, "Dropable", "byte", 1);
          setField(itemObj, "Identified", "byte", 1);
          setField(itemObj, "Repos_PosX", "word", itemList.length % 6);
          setField(itemObj, "Repos_Posy", "word", Math.floor(itemList.length / 6));
          if (quantity && quantity > 1) {
            setField(itemObj, "StackSize", "word", quantity);
          }
          itemList.push(itemObj);
        }

        obj.ItemList = { type: "list", value: itemList };

        if (failedInv.length > 0) {
          console.error(`Inventory warnings for ${resrefLower}: ${failedInv.join(", ")}`);
        }
      }

      // Write to disk
      const filePath = path.join(index.tempDir, `${resrefLower}.utc`);
      await jsonToGff(doc, filePath);

      // Register
      const stat = await fs.stat(filePath);
      index.resources.set(key, {
        resref: resrefLower,
        extension: "utc",
        filePath,
        sizeBytes: stat.size,
      });
      index.parsedGff.set(key, doc);

      const result: Record<string, unknown> = {
        success: true,
        created: key,
        tag,
        name,
        source: sourceResref || "scratch",
        sizeBytes: stat.size,
      };

      if (equipment) {
        const parsed: Record<string, string> = JSON.parse(equipment);
        const equipped: string[] = [];
        const failed: string[] = [];
        for (const [slotName, itemResref] of Object.entries(parsed)) {
          const slotId = EQUIP_SLOT_MAP[slotName.toLowerCase()];
          if (slotId === undefined) { failed.push(`Unknown slot: ${slotName}`); continue; }
          // Check if it made it into the list
          const equipItems = (obj.Equip_ItemList as any)?.value || [];
          if (equipItems.some((e: any) => e.__struct_id === slotId)) {
            equipped.push(`${slotName}: ${itemResref}`);
          } else {
            failed.push(`${slotName}: ${itemResref} (not found)`);
          }
        }
        result.equipped = equipped;
        if (failed.length > 0) result.equipmentWarnings = failed;
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2),
        }],
      };
    },
  );

  // ─── create_encounter_blueprint ─────────────────────────────────────────

  server.tool(
    "create_encounter_blueprint",
    "Create a new encounter blueprint (.ute) with a creature spawn list. Encounters spawn creatures when players enter their region, with configurable difficulty, respawning, and creature counts.",
    {
      resref: z.string().describe("New encounter resref"),
      tag: z.string().describe("Encounter tag"),
      name: z.string().describe("Encounter display name"),
      creatures: z.string().describe("JSON array of creature entries: [{resref: 'nw_wolf', singleSpawn?: false}]. Resrefs are UTC blueprint names."),
      sourceResref: z.string().optional().describe("Base encounter to clone from (e.g. existing UTE resref)"),
      active: z.boolean().optional().describe("Whether encounter is active (default true)"),
      difficulty: optNumParam("Difficulty index 0-4: 0=VERY_EASY, 1=EASY, 2=NORMAL, 3=HARD, 4=IMPOSSIBLE (default 1)"),
      maxCreatures: optNumParam("Max creatures spawned simultaneously (default 3)"),
      recCreatures: optNumParam("Recommended creature count (default 1)"),
      respawns: z.boolean().optional().describe("Whether encounter respawns after cleared (default false)"),
      respawnTime: optNumParam("Seconds until respawn (default 300)"),
    },
    async ({ resref, tag, name, creatures, sourceResref, active, difficulty, maxCreatures, recCreatures, respawns, respawnTime }) => {
      const index = requireIndex();
      const resrefLower = resref.toLowerCase();
      const key = `${resrefLower}.ute`;

      if (index.resources.has(key)) {
        return { content: [{ type: "text", text: `Resource already exists: ${key}` }] };
      }

      const needsResman = !!sourceResref;
      const resmanOpts = needsResman ? await buildResmanOptions(index) : undefined;

      let doc: GffDocument;

      if (sourceResref) {
        const source = await resolveBlueprint(index, sourceResref, "ute", resmanOpts!);
        if (!source) {
          return { content: [{ type: "text", text: `Source blueprint not found: ${sourceResref}.ute` }] };
        }
        doc = source;
      } else {
        doc = buildMinimalUte();
      }

      const obj = doc as GffObj;

      // Apply overrides
      setField(obj, "Tag", "cexostring", tag);
      setField(obj, "TemplateResRef", "resref", resrefLower);
      obj.LocalizedName = { type: "cexolocstring", value: { "0": name } };

      if (active !== undefined) setField(obj, "Active", "byte", active ? 1 : 0);
      if (difficulty !== undefined) setField(obj, "DifficultyIndex", "int", toI(difficulty));
      if (maxCreatures !== undefined) setField(obj, "MaxCreatures", "int", toI(maxCreatures));
      if (recCreatures !== undefined) setField(obj, "RecCreatures", "int", toI(recCreatures));
      if (respawns !== undefined) setField(obj, "Respawns", "byte", respawns ? 1 : 0);
      if (respawnTime !== undefined) {
        setField(obj, "RespawnTime", "dword", toI(respawnTime));
        setField(obj, "ResetTime", "int", toI(respawnTime));
      }

      // Creature list
      const parsed: Array<{ resref: string; singleSpawn?: boolean }> = JSON.parse(creatures);
      obj.CreatureList = {
        type: "list",
        value: parsed.map(c => ({
          __struct_id: 0,
          Appearance: { type: "int", value: 0 },
          CR: { type: "float", value: 0 },
          Resref: { type: "resref", value: c.resref.toLowerCase() },
          SingleSpawn: { type: "byte", value: c.singleSpawn ? 1 : 0 },
        })),
      };

      // Write to disk
      const filePath = path.join(index.tempDir, `${resrefLower}.ute`);
      await jsonToGff(doc, filePath);

      const stat = await fs.stat(filePath);
      index.resources.set(key, {
        resref: resrefLower,
        extension: "ute",
        filePath,
        sizeBytes: stat.size,
      });
      index.parsedGff.set(key, doc);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            created: key,
            tag,
            name,
            source: sourceResref || "scratch",
            creatureCount: parsed.length,
            sizeBytes: stat.size,
          }, null, 2),
        }],
      };
    },
  );

  // ─── create_store_blueprint ─────────────────────────────────────────

  server.tool(
    "create_store_blueprint",
    "Create a new store blueprint (.utm) with custom pricing and inventory. Place with place_store and open via script (OpenStore).",
    {
      resref: z.string().describe("New store resref"),
      tag: z.string().describe("Store tag"),
      name: z.string().describe("Store display name"),
      sourceResref: z.string().optional().describe("Base store to clone from (e.g. existing UTM resref)"),
      markUp: optNumParam("Buy markup percentage (100 = no markup, 120 = 20% markup, default 100)"),
      markDown: optNumParam("Sell markdown percentage (100 = no markdown, 80 = 20% markdown, default 100)"),
      storeGold: optNumParam("Gold on hand (-1 = unlimited, default -1)"),
      maxBuyPrice: optNumParam("Max buy price (0 = unlimited, default 0)"),
      identifyPrice: optNumParam("Identification cost (default 100)"),
      inventory: z.string().optional().describe("JSON array of inventory items: [{resref: 'nw_it_mpotion001', infinite?: true, category?: 0}]. Category: 0=Armor, 1=Weapons, 2=Potions/Scrolls, 3=Wands/Magic, 4=Misc (default 4). Items are resolved from module or base game."),
    },
    async ({ resref, tag, name, sourceResref, markUp, markDown, storeGold, maxBuyPrice, identifyPrice, inventory }) => {
      const index = requireIndex();
      const resrefLower = resref.toLowerCase();
      const key = `${resrefLower}.utm`;

      if (index.resources.has(key)) {
        return { content: [{ type: "text", text: `Resource already exists: ${key}` }] };
      }

      const needsResman = !!sourceResref || !!inventory;
      const resmanOpts = needsResman ? await buildResmanOptions(index) : undefined;

      let doc: GffDocument;

      if (sourceResref) {
        const source = await resolveBlueprint(index, sourceResref, "utm", resmanOpts!);
        if (!source) {
          return { content: [{ type: "text", text: `Source blueprint not found: ${sourceResref}.utm` }] };
        }
        doc = source;
      } else {
        doc = buildMinimalUtm();
      }

      const obj = doc as GffObj;

      // Apply overrides
      setField(obj, "Tag", "cexostring", tag);
      setField(obj, "TemplateResRef", "resref", resrefLower);
      obj.LocName = { type: "cexolocstring", value: { "0": name } };

      if (markUp !== undefined) setField(obj, "MarkUp", "int", toI(markUp));
      if (markDown !== undefined) setField(obj, "MarkDown", "int", toI(markDown));
      if (storeGold !== undefined) setField(obj, "StoreGold", "int", toI(storeGold));
      if (maxBuyPrice !== undefined) setField(obj, "MaxBuyPrice", "int", toI(maxBuyPrice));
      if (identifyPrice !== undefined) setField(obj, "IdentifyPrice", "int", toI(identifyPrice));

      // Inventory — resolve items and add to store categories
      const failedItems: string[] = [];
      let itemCount = 0;

      if (inventory) {
        const parsed: Array<{ resref: string; infinite?: boolean; category?: number }> = JSON.parse(inventory);

        // Ensure StoreList has at least 5 categories
        const storeList = getFieldList(obj, "StoreList");
        while (storeList.length < 5) {
          storeList.push({
            __struct_id: storeList.length,
            ItemList: { type: "list", value: [] },
          });
        }

        for (const item of parsed) {
          const itemDoc = await resolveBlueprint(index, item.resref, "uti", resmanOpts!);
          if (!itemDoc) {
            failedItems.push(`Item not found: ${item.resref}.uti`);
            continue;
          }

          const itemObj = itemDoc as GffObj;
          itemObj.__struct_id = 0;
          // Add Infinite flag to the embedded item
          setField(itemObj, "Infinite", "byte", item.infinite ? 1 : 0);
          delete itemObj.__data_type;

          // Determine category: explicit, or auto-detect from baseItem, or default to 4 (misc)
          let cat = item.category ?? 4;
          if (item.category === undefined) {
            const baseItem = getFieldNum(itemObj, "BaseItem");
            // Auto-categorize: armor/shields → 0, weapons → 1, potions/scrolls → 2, wands → 3
            if ([16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71, 72, 73, 78, 80].includes(baseItem)) {
              cat = 0; // Armor-like items
            } else if ([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 37, 40, 41, 47, 48, 49, 50, 51, 95, 108].includes(baseItem)) {
              cat = 1; // Weapons
            } else if ([19, 20, 35, 36, 75, 76, 77].includes(baseItem)) {
              cat = 2; // Potions, scrolls, healers kits
            } else if ([35, 36].includes(baseItem)) {
              cat = 3; // Wands, rods
            }
          }
          if (cat > 4) cat = 4;

          const categoryObj = storeList[cat] as GffObj;
          const itemList = getFieldList(categoryObj, "ItemList");
          itemList.push(itemObj);
          itemCount++;
        }
      }

      // Write to disk
      const filePath = path.join(index.tempDir, `${resrefLower}.utm`);
      await jsonToGff(doc, filePath);

      const stat = await fs.stat(filePath);
      index.resources.set(key, {
        resref: resrefLower,
        extension: "utm",
        filePath,
        sizeBytes: stat.size,
      });
      index.parsedGff.set(key, doc);

      const result: Record<string, unknown> = {
        success: true,
        created: key,
        tag,
        name,
        source: sourceResref || "scratch",
        itemCount,
        sizeBytes: stat.size,
      };

      if (failedItems.length > 0) {
        result.inventoryWarnings = failedItems;
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2),
        }],
      };
    },
  );

  // ─── create_trap_blueprint ─────────────────────────────────────────────

  server.tool(
    "create_trap_blueprint",
    "Create a new trap trigger blueprint (.utt) with trap detection/disarm DCs and a default square geometry. Optionally clone from a base game trigger and apply overrides.",
    {
      resref: z.string().describe("New trap blueprint resref"),
      tag: z.string().describe("Trap tag"),
      name: z.string().describe("Trap display name"),
      scriptOnEnter: z.string().describe("Script resref to run when PC enters the trap"),
      sourceResref: z.string().optional().describe("Base trigger to clone from (e.g. 'nw_yourfeet')"),
      detectDC: optNumParam("Trap detection DC (default 15)"),
      disarmDC: optNumParam("Trap disarm DC (default 15)"),
      oneShot: z.boolean().optional().describe("Trap fires once then disables (default true)"),
      size: optNumParam("Trigger square size in meters (default 4.0)"),
    },
    async ({ resref, tag, name, scriptOnEnter, sourceResref, detectDC, disarmDC, oneShot, size }) => {
      const index = requireIndex();
      const resrefLower = resref.toLowerCase();
      const detectN = detectDC !== undefined ? toI(detectDC) : 15;
      const disarmN = disarmDC !== undefined ? toI(disarmDC) : 15;
      const oneShotN = oneShot !== false;
      const sizeN = size !== undefined ? parseFloat(size) : 4.0;
      const halfSize = sizeN / 2;

      let doc: GffDocument;

      if (sourceResref) {
        const resmanOpts = await buildResmanOptions(index);
        const source = await resolveBlueprint(index, sourceResref, "utt", resmanOpts);
        if (!source) {
          return { content: [{ type: "text", text: `Source blueprint not found: ${sourceResref}.utt` }] };
        }
        doc = source;
      } else {
        // Build minimal UTT from scratch
        doc = {
          __data_type: "UTT ",
          AutoRemoveKey: { type: "byte", value: 0 },
          Cursor: { type: "byte", value: 0 },
          DisarmDC: { type: "byte", value: disarmN },
          Faction: { type: "dword", value: 0 },
          HighlightHeight: { type: "float", value: 0 },
          KeyName: { type: "cexostring", value: "" },
          LinkedTo: { type: "cexostring", value: "" },
          LinkedToFlags: { type: "byte", value: 0 },
          LoadScreenID: { type: "word", value: 0 },
          OnClick: { type: "resref", value: "" },
          OnDisarm: { type: "resref", value: "" },
          OnTrapTriggered: { type: "resref", value: "" },
          PortraitId: { type: "word", value: 0 },
          ScriptHeartbeat: { type: "resref", value: "" },
          ScriptOnEnter: { type: "resref", value: scriptOnEnter },
          ScriptOnExit: { type: "resref", value: "" },
          ScriptUserDefine: { type: "resref", value: "" },
          Tag: { type: "cexostring", value: tag },
          TemplateResRef: { type: "resref", value: resrefLower },
          TrapDetectDC: { type: "byte", value: detectN },
          TrapDetectable: { type: "byte", value: 1 },
          TrapDisarmable: { type: "byte", value: 1 },
          TrapFlag: { type: "byte", value: 1 },
          TrapOneShot: { type: "byte", value: oneShotN ? 1 : 0 },
          TrapType: { type: "byte", value: 0 },
          Type: { type: "int", value: 0 },
          LocalizedName: { type: "cexolocstring", value: { "0": name } },
          Description: { type: "cexolocstring", value: {} },
          // Default square geometry (4 vertices)
          Geometry: {
            type: "list",
            value: [
              { __struct_id: 3, PointX: { type: "float", value: -halfSize }, PointY: { type: "float", value: -halfSize }, PointZ: { type: "float", value: 0 } },
              { __struct_id: 3, PointX: { type: "float", value: halfSize }, PointY: { type: "float", value: -halfSize }, PointZ: { type: "float", value: 0 } },
              { __struct_id: 3, PointX: { type: "float", value: halfSize }, PointY: { type: "float", value: halfSize }, PointZ: { type: "float", value: 0 } },
              { __struct_id: 3, PointX: { type: "float", value: -halfSize }, PointY: { type: "float", value: halfSize }, PointZ: { type: "float", value: 0 } },
            ],
          },
        } as unknown as GffDocument;
      }

      const obj = doc as GffObj;
      setField(obj, "Tag", "cexostring", tag);
      setField(obj, "TemplateResRef", "resref", resrefLower);
      obj.LocalizedName = { type: "cexolocstring", value: { "0": name } };
      setField(obj, "ScriptOnEnter", "resref", scriptOnEnter);
      setField(obj, "TrapDetectDC", "byte", detectN);
      setField(obj, "DisarmDC", "byte", disarmN);
      setField(obj, "TrapDetectable", "byte", 1);
      setField(obj, "TrapDisarmable", "byte", 1);
      setField(obj, "TrapFlag", "byte", 1);
      setField(obj, "TrapOneShot", "byte", oneShotN ? 1 : 0);

      // Write to disk and register
      const filePath = path.join(index.tempDir, `${resrefLower}.utt`);
      await jsonToGff(doc, filePath);
      const stat = await fs.stat(filePath);

      const key = `${resrefLower}.utt`;
      index.resources.set(key, {
        resref: resrefLower,
        extension: "utt",
        filePath,
        sizeBytes: stat.size,
      });
      index.parsedGff.set(key, doc);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            resref: resrefLower,
            tag,
            name,
            scriptOnEnter,
            detectDC: detectN,
            disarmDC: disarmN,
            oneShot: oneShotN,
            size: sizeN,
          }, null, 2),
        }],
      };
    },
  );
}
