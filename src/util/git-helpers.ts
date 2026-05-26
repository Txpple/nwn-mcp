/**
 * GIT (Game Instance Table) helper utilities.
 *
 * Shared by placement, object management, and blueprint tools:
 * - resolveBlueprint: Resolve a blueprint from module cache, disk, or resman
 * - getGitDoc: Get the GIT document for an area
 * - writeBackGit: Write GIT back to disk with cache invalidation
 * - updateAreaCounts: Update area summary counts from current GIT
 * - degToRad: Convert degrees to radians
 * - buildMinimalUtc: Build a minimal UTC creature document from scratch
 */

import fs from "fs/promises";
import path from "path";
import type { NasherSyncResult } from "../nasher-sync.js";
import { syncNasherSourceForIndex } from "../nasher-sync.js";
import type { ResmanOptions } from "../nim-tools.js";
import { gffToJson, jsonToGff, resmanExtractToJson } from "../nim-tools.js";
import { invalidateTagToAreaCache } from "../tools/tileset-tools.js";
import type { GffDocument, GffObj } from "../types/gff.js";
import { getFieldList } from "../types/gff.js";
import type { ModuleIndex } from "../types/module.js";

/** Resolve a blueprint from module cache, disk, or resman (base game/HAKs). */
export async function resolveBlueprint(
  index: ModuleIndex,
  resref: string,
  extension: string,
  resmanOpts: ResmanOptions,
): Promise<GffDocument | null> {
  const key = `${resref.toLowerCase()}.${extension.toLowerCase()}`;

  // 1. Check parsed GFF cache
  const cached = index.parsedGff.get(key);
  if (cached) return JSON.parse(JSON.stringify(cached)) as GffDocument;

  // 2. Check resources on disk
  const entry = index.resources.get(key);
  if (entry) {
    const doc = await gffToJson(entry.filePath);
    index.parsedGff.set(key, doc);
    return JSON.parse(JSON.stringify(doc)) as GffDocument;
  }

  // 3. Fall back to resman (base game / HAKs) — extract to cache dir then parse
  try {
    const cacheDir = path.join(index.tempDir, "blueprint_cache");
    await fs.mkdir(cacheDir, { recursive: true });
    const doc = await resmanExtractToJson(key, cacheDir, resmanOpts);
    // Cache in memory for subsequent lookups
    index.parsedGff.set(key, doc);
    return JSON.parse(JSON.stringify(doc)) as GffDocument;
  } catch (e) {
    console.error(`Blueprint not found via resman: ${key}: ${e}`);
    return null;
  }
}

/** Get the GIT document for an area, or throw. */
export function getGitDoc(index: ModuleIndex, areaResref: string): { doc: GffDocument; obj: GffObj } {
  const key = `${areaResref.toLowerCase()}.git`;
  const doc = index.parsedGff.get(key);
  if (!doc) throw new Error(`GIT not found for area: ${areaResref}`);
  return { doc, obj: doc as GffObj };
}

/** Write GIT back to disk. Invalidates derived caches. */
export async function writeBackGit(
  index: ModuleIndex,
  areaResref: string,
  doc: GffDocument,
): Promise<NasherSyncResult | undefined> {
  const key = `${areaResref.toLowerCase()}.git`;
  const entry = index.resources.get(key);
  if (entry) {
    await jsonToGff(doc, entry.filePath);
    invalidateTagToAreaCache();
  }
  // Sync the GIC file so the toolset can see all placed objects.
  await syncGic(index, areaResref, doc);
  return syncNasherSourceForIndex(index, { reason: `writeBackGit:${areaResref.toLowerCase()}` });
}

/**
 * Sync the GIC (Game Instance Comments) file to match the GIT.
 * The toolset uses the GIC to know which objects exist in an area.
 * Each GIC list must have one entry per GIT object (just a Comment struct).
 */
async function syncGic(index: ModuleIndex, areaResref: string, gitDoc: GffDocument): Promise<void> {
  const gicKey = `${areaResref.toLowerCase()}.gic`;
  const gicEntry = index.resources.get(gicKey);
  if (!gicEntry) return;

  const gicDoc = index.parsedGff.get(gicKey);
  if (!gicDoc) return;

  const gic = gicDoc as GffObj;
  const git = gitDoc as GffObj;

  const listNames = [
    "Creature List",
    "Door List",
    "Encounter List",
    "Placeable List",
    "SoundList",
    "StoreList",
    "TriggerList",
    "WaypointList",
  ];

  for (const listName of listNames) {
    const gitList = getFieldList(git, listName);
    const gicList: GffObj[] = [];
    for (let i = 0; i < gitList.length; i++) {
      gicList.push({
        __struct_id: 0,
        Comment: { type: "cexostring", value: "" },
      });
    }
    gic[listName] = { type: "list", value: gicList };
  }

  await jsonToGff(gicDoc, gicEntry.filePath);
}

/** Update area summary counts from the current GIT. */
export function updateAreaCounts(index: ModuleIndex, areaResref: string): void {
  const summary = index.areas.get(areaResref.toLowerCase());
  if (!summary) return;
  const { obj } = getGitDoc(index, areaResref);
  summary.creatureCount = getFieldList(obj, "Creature List").length;
  summary.placeableCount = getFieldList(obj, "Placeable List").length;
  summary.doorCount = getFieldList(obj, "Door List").length;
  summary.encounterCount = getFieldList(obj, "Encounter List").length;
  summary.triggerCount = getFieldList(obj, "TriggerList").length;
  summary.waypointCount = getFieldList(obj, "WaypointList").length;
}

/** Convert degrees to radians. */
export function degToRad(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

/** Build a minimal UTE encounter document from scratch. */
export function buildMinimalUte(): GffDocument {
  return {
    __data_type: "UTE ",
    Active: { type: "byte", value: 1 },
    Comment: { type: "cexostring", value: "" },
    CreatureList: { type: "list", value: [] },
    Difficulty: { type: "int", value: 0 },
    DifficultyIndex: { type: "int", value: 1 },
    Faction: { type: "dword", value: 1 }, // Hostile
    Geometry: {
      type: "list",
      value: [
        {
          __struct_id: 0,
          X: { type: "float", value: -5.0 },
          Y: { type: "float", value: -5.0 },
          Z: { type: "float", value: 0.0 },
        },
        {
          __struct_id: 0,
          X: { type: "float", value: 5.0 },
          Y: { type: "float", value: -5.0 },
          Z: { type: "float", value: 0.0 },
        },
        {
          __struct_id: 0,
          X: { type: "float", value: 5.0 },
          Y: { type: "float", value: 5.0 },
          Z: { type: "float", value: 0.0 },
        },
        {
          __struct_id: 0,
          X: { type: "float", value: -5.0 },
          Y: { type: "float", value: 5.0 },
          Z: { type: "float", value: 0.0 },
        },
      ],
    },
    LocalizedName: { type: "cexolocstring", value: { "0": "Encounter" } },
    MaxCreatures: { type: "int", value: 3 },
    OnEntered: { type: "resref", value: "" },
    OnExhausted: { type: "resref", value: "" },
    OnExit: { type: "resref", value: "" },
    OnHeartbeat: { type: "resref", value: "" },
    OnUserDefined: { type: "resref", value: "" },
    PaletteID: { type: "byte", value: 0 },
    PlayerOnly: { type: "byte", value: 0 },
    RecCreatures: { type: "int", value: 1 },
    Reset: { type: "byte", value: 1 },
    ResetTime: { type: "int", value: 300 },
    Respawns: { type: "byte", value: 0 },
    RespawnTime: { type: "dword", value: 300 },
    SpawnOption: { type: "byte", value: 1 },
    Tag: { type: "cexostring", value: "" },
    TemplateResRef: { type: "resref", value: "" },
  };
}

/** Build a minimal UTM store document from scratch. */
export function buildMinimalUtm(): GffDocument {
  // 5 standard inventory categories: Armor, Weapons, Potions/Scrolls, Wands/Magic, Misc
  const makeCategory = (idx: number) => ({
    __struct_id: idx,
    ItemList: { type: "list", value: [] as unknown[] },
  });

  return {
    __data_type: "UTM ",
    BlackMarket: { type: "byte", value: 0 },
    BM_MarkDown: { type: "int", value: 0 },
    Comment: { type: "cexostring", value: "" },
    ID: { type: "byte", value: 0 },
    IdentifyPrice: { type: "int", value: 100 },
    LocName: { type: "cexolocstring", value: { "0": "Store" } },
    MarkDown: { type: "int", value: 100 },
    MarkUp: { type: "int", value: 100 },
    MaxBuyPrice: { type: "int", value: 0 },
    OnClosStore: { type: "resref", value: "" },
    OnOpenStore: { type: "resref", value: "" },
    PaletteID: { type: "byte", value: 0 },
    StoreGold: { type: "int", value: -1 },
    StoreList: {
      type: "list",
      value: [makeCategory(0), makeCategory(1), makeCategory(2), makeCategory(3), makeCategory(4)],
    },
    Tag: { type: "cexostring", value: "" },
    TemplateResRef: { type: "resref", value: "" },
    WillNotBuy: { type: "list", value: [] },
    WillOnlyBuy: { type: "list", value: [] },
  };
}

/** Build a minimal UTC creature document from scratch. */
export function buildMinimalUtc(): GffDocument {
  return {
    __data_type: "UTC ",
    Appearance_Type: { type: "word", value: 0 },
    BodyBag: { type: "byte", value: 0 },
    Cha: { type: "byte", value: 10 },
    ChallengeRating: { type: "float", value: 0 },
    ClassList: {
      type: "list",
      value: [
        {
          __struct_id: 2,
          Class: { type: "int", value: 0 }, // Barbarian (placeholder)
          ClassLevel: { type: "short", value: 1 },
        },
      ],
    },
    Con: { type: "byte", value: 10 },
    Conversation: { type: "resref", value: "" },
    CurrentHitPoints: { type: "short", value: 10 },
    DecayTime: { type: "dword", value: 5000 },
    Description: { type: "cexolocstring", value: {} },
    Dex: { type: "byte", value: 10 },
    Disarmable: { type: "byte", value: 0 },
    Equip_ItemList: { type: "list", value: [] },
    FactionID: { type: "word", value: 0 },
    FeatList: { type: "list", value: [] },
    FirstName: { type: "cexolocstring", value: { "0": "Creature" } },
    Gender: { type: "byte", value: 0 },
    GoodEvil: { type: "byte", value: 50 },
    HitPoints: { type: "short", value: 10 },
    Int: { type: "byte", value: 10 },
    Interruptable: { type: "byte", value: 1 },
    IsImmortal: { type: "byte", value: 0 },
    IsPC: { type: "byte", value: 0 },
    ItemList: { type: "list", value: [] },
    LastName: { type: "cexolocstring", value: {} },
    LawfulChaotic: { type: "byte", value: 50 },
    Lootable: { type: "byte", value: 0 },
    MaxHitPoints: { type: "short", value: 10 },
    NaturalAC: { type: "byte", value: 0 },
    NoPermDeath: { type: "byte", value: 0 },
    PerceptionRange: { type: "byte", value: 11 },
    Phenotype: { type: "int", value: 0 },
    Plot: { type: "byte", value: 0 },
    Race: { type: "byte", value: 6 }, // Human
    ScriptAttacked: { type: "resref", value: "nw_c2_default5" },
    ScriptDamaged: { type: "resref", value: "nw_c2_default6" },
    ScriptDeath: { type: "resref", value: "nw_c2_default7" },
    ScriptDialogue: { type: "resref", value: "nw_c2_default4" },
    ScriptDisturbed: { type: "resref", value: "nw_c2_default8" },
    ScriptEndRound: { type: "resref", value: "nw_c2_default3" },
    ScriptHeartbeat: { type: "resref", value: "nw_c2_default1" },
    ScriptOnBlocked: { type: "resref", value: "nw_c2_defaulte" },
    ScriptPercption: { type: "resref", value: "nw_c2_default2" },
    ScriptRested: { type: "resref", value: "nw_c2_defaulta" },
    ScriptSpawn: { type: "resref", value: "nw_c2_default9" },
    ScriptSpellAt: { type: "resref", value: "nw_c2_defaultb" },
    ScriptUserDefine: { type: "resref", value: "nw_c2_defaultd" },
    SkillList: { type: "list", value: [] },
    SoundSetFile: { type: "word", value: 0 },
    SpecAbilityList: { type: "list", value: [] },
    Str: { type: "byte", value: 10 },
    Subrace: { type: "cexostring", value: "" },
    Tag: { type: "cexostring", value: "" },
    Tail_New: { type: "byte", value: 0 },
    TemplateList: { type: "list", value: [] },
    TemplateResRef: { type: "resref", value: "" },
    WalkRate: { type: "int", value: 4 },
    Wings_New: { type: "byte", value: 0 },
    Wis: { type: "byte", value: 10 },
    fortbonus: { type: "short", value: 0 },
    refbonus: { type: "short", value: 0 },
    willbonus: { type: "short", value: 0 },
  };
}
