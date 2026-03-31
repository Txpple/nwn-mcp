import fs from "fs/promises";
import path from "path";
import { GFF_EXTENSIONS, SCRIPT_FIELDS, NWN_FOLDER_DATA, NWN_FOLDER_USER } from "./config.js";
import { erfExtract, erfList, gffToJson, twodaToJson, tlkToJson, resmanExtract } from "./nim-tools.js";
import type { ResmanOptions } from "./nim-tools.js";
import { createTempDir, cleanupTempDir } from "./util/temp-dir.js";
import { clearWokCache, setWokCacheDir } from "./util/walkmesh.js";
import { clearTilesetCache } from "./util/tileset.js";
import { clearUndoStack } from "./util/undo.js";
import { getFieldStr, getFieldNum, getFieldLocStr, getFieldList } from "./types/gff.js";
import type { GffDocument, GffObj } from "./types/gff.js";
import type {
  ModuleIndex, ResourceEntry, TagLocation, ScriptUsage,
  AreaSummary, DialogSummary, CreatureRecord, ItemRecord,
  TwoDATable, TlkTable,
} from "./types/module.js";

let currentIndex: ModuleIndex | null = null;

export function getIndex(): ModuleIndex | null {
  return currentIndex;
}

export function requireIndex(): ModuleIndex {
  if (!currentIndex) throw new Error("No module loaded. Call load_module first.");
  return currentIndex;
}

/** Resolve HAK file paths from hakList, checking NWN_FOLDER_USER/hak/ then NWN_FOLDER_DATA/hak/ */
export async function resolveHakPaths(hakList: string[], warnings?: Array<{ type: string; message: string }>): Promise<string[]> {
  const hakPaths: string[] = [];
  for (const hakName of hakList) {
    let found = false;
    for (const dir of [
      NWN_FOLDER_USER ? path.join(NWN_FOLDER_USER, "hak") : null,
      NWN_FOLDER_DATA ? path.join(NWN_FOLDER_DATA, "hak") : null,
    ]) {
      if (!dir) continue;
      const p = path.join(dir, `${hakName}.hak`);
      try { await fs.access(p); hakPaths.push(p); found = true; break; } catch { /* try next */ }
    }
    if (!found) {
      console.error(`HAK not found: ${hakName}.hak`);
      if (warnings) warnings.push({ type: "hak", message: `HAK not found: ${hakName}.hak` });
    }
  }
  return hakPaths;
}

/** Build resman options from a loaded module index, for use with resman-based tools */
export async function buildResmanOptions(index: ModuleIndex): Promise<ResmanOptions> {
  const hakPaths = await resolveHakPaths(index.hakList);
  return {
    root: NWN_FOLDER_DATA || undefined,
    userDir: NWN_FOLDER_USER || undefined,
    // Reverse: hakList[0] = highest priority; resman loads later erfs with higher priority
    erfs: hakPaths.length > 0 ? [...hakPaths].reverse() : undefined,
    dirs: [index.tempDir],
  };
}

export async function loadModule(modPath: string): Promise<ModuleIndex> {
  // Clean up previous
  if (currentIndex) {
    await cleanupTempDir(currentIndex.tempDir).catch(() => {});
  }
  clearWokCache();
  clearTilesetCache();
  clearUndoStack();

  const BATCH_SIZE = 20;  // Max concurrent child processes per batch
  const loadWarnings: Array<{ type: string; message: string }> = [];
  const absPath = path.resolve(modPath);
  const tempDir = await createTempDir(absPath);
  setWokCacheDir(tempDir);

  // Extract module
  await erfExtract(absPath, tempDir);

  // List all resources
  const fileNames = await erfList(absPath);
  const resources = new Map<string, ResourceEntry>();

  for (const fileName of fileNames) {
    const ext = path.extname(fileName).slice(1).toLowerCase();
    const resref = path.basename(fileName, path.extname(fileName));
    const filePath = path.join(tempDir, fileName);
    let sizeBytes = 0;
    try {
      const stat = await fs.stat(filePath);
      sizeBytes = stat.size;
    } catch { /* file may not exist */ }

    resources.set(fileName.toLowerCase(), { resref, extension: ext, filePath, sizeBytes });
  }

  // Parse all GFF files in parallel (batched to limit concurrent processes)
  const parsedGff = new Map<string, GffDocument>();
  const gffEntries = [...resources.entries()].filter(([, e]) => GFF_EXTENSIONS.has(e.extension));
  for (let i = 0; i < gffEntries.length; i += BATCH_SIZE) {
    const batch = gffEntries.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map(async ([key, entry]) => {
        const doc = await gffToJson(entry.filePath);
        return { key, doc };
      }),
    );
    for (const result of results) {
      if (result.status === "fulfilled") {
        parsedGff.set(result.value.key, result.value.doc);
      } else {
        console.error(`Warning: Failed to parse GFF: ${result.reason}`);
        loadWarnings.push({ type: "gff", message: `Failed to parse GFF: ${result.reason}` });
      }
    }
  }

  // Build indexes
  const tags = new Map<string, TagLocation[]>();
  const scripts = new Map<string, ScriptUsage[]>();
  const areas = new Map<string, AreaSummary>();
  const dialogs = new Map<string, DialogSummary>();
  const creatures: CreatureRecord[] = [];
  const items: ItemRecord[] = [];

  // Index all GFF documents
  for (const [key, doc] of parsedGff) {
    indexGffDocument(key, doc, tags, scripts);
  }

  // Build area summaries
  for (const [key, entry] of resources) {
    if (entry.extension === "are") {
      const areDoc = parsedGff.get(key);
      const gitKey = `${entry.resref}.git`;
      const gitDoc = parsedGff.get(gitKey);
      if (areDoc) {
        const summary = buildAreaSummary(entry.resref, areDoc, gitDoc);
        areas.set(entry.resref, summary);
      }

      // Index creatures and placeables from GIT
      if (gitDoc) {
        indexAreaCreatures(entry.resref, gitDoc, creatures);
      }
    }
  }

  // Build dialog summaries
  for (const [key, entry] of resources) {
    if (entry.extension === "dlg") {
      const dlgDoc = parsedGff.get(key);
      if (dlgDoc) {
        const summary = buildDialogSummary(entry.resref, dlgDoc, creatures);
        dialogs.set(entry.resref, summary);
      }
    }
  }

  // Index standalone item blueprints
  for (const [key, entry] of resources) {
    if (entry.extension === "uti") {
      const doc = parsedGff.get(key);
      if (doc) {
        items.push(buildItemRecord(entry.resref, doc, "blueprint"));
      }
    }
  }

  // Parse 2DA tables found in the module (highest priority)
  const twodaTables = new Map<string, TwoDATable>();
  for (const [key, entry] of resources) {
    if (entry.extension === "2da") {
      try {
        const raw = await twodaToJson(entry.filePath);
        const table = parse2DAJson(raw);
        twodaTables.set(entry.resref.toLowerCase(), table);
      } catch (e) {
        console.error(`Warning: Failed to parse 2DA ${key}: ${e}`);
        loadWarnings.push({ type: "2da", message: `Failed to parse 2DA ${key}: ${e}` });
      }
    }
  }

  // Get module metadata from IFO
  const ifo = parsedGff.get("module.ifo");
  const ifoObj = ifo ? (ifo as GffObj) : null;
  const moduleName = ifoObj
    ? getFieldLocStr(ifoObj, "Mod_Name") || path.basename(modPath, ".mod")
    : path.basename(modPath, ".mod");
  const hakList = ifoObj
    ? getFieldList(ifoObj, "Mod_HakList").map(h => getFieldStr(h, "Mod_Hak")).filter(Boolean)
    : [];
  const customTlkName = ifoObj ? getFieldStr(ifoObj, "Mod_CustomTlk") || "" : "";

  // === Custom TLK ===
  // Check module ERF first, then NWN_FOLDER_USER/tlk/ via Mod_CustomTlk
  let customTlk: TlkTable | null = null;
  for (const [key, entry] of resources) {
    if (entry.extension === "tlk") {
      try {
        const raw = await tlkToJson(entry.filePath);
        customTlk = parseTlkJson(raw);
        console.error(`Loaded custom TLK from module ERF: ${customTlk.size} entries`);
      } catch (e) {
        console.error(`Warning: Failed to parse TLK ${key}: ${e}`);
        loadWarnings.push({ type: "tlk", message: `Failed to parse TLK ${key}: ${e}` });
      }
      break;
    }
  }
  if (!customTlk && customTlkName && NWN_FOLDER_USER) {
    const tlkPath = path.join(NWN_FOLDER_USER, "tlk", `${customTlkName}.tlk`);
    try {
      await fs.access(tlkPath);
      const raw = await tlkToJson(tlkPath);
      customTlk = parseTlkJson(raw);
      console.error(`Loaded custom TLK "${customTlkName}": ${customTlk.size} entries`);
    } catch {
      console.error(`Custom TLK not found: ${tlkPath}`);
      loadWarnings.push({ type: "tlk", message: `Custom TLK not found: ${tlkPath}` });
    }
  }

  // === Base game TLK ===
  // NWN EE stores dialog.tlk under lang/en/data/; original NWN uses data/
  let baseTlk: TlkTable | null = null;
  if (NWN_FOLDER_DATA) {
    const candidates = [
      path.join(NWN_FOLDER_DATA, "lang", "en", "data", "dialog.tlk"),
      path.join(NWN_FOLDER_DATA, "data", "dialog.tlk"),
    ];
    for (const tlkPath of candidates) {
      try {
        await fs.access(tlkPath);
        const raw = await tlkToJson(tlkPath);
        baseTlk = parseTlkJson(raw);
        console.error(`Loaded base game TLK: ${baseTlk.size} entries`);
        break;
      } catch { /* try next */ }
    }
    if (!baseTlk) {
      console.error("Base game TLK not found (checked lang/en/data/ and data/)");
      loadWarnings.push({ type: "tlk", message: "Base game TLK not found (checked lang/en/data/ and data/)" });
    }
  }

  // === Extra 2DAs via resman ===
  // Load order (lowest→highest): base game BIFs → HAKs → user ovr/ → user development/
  // Module's own 2DAs (already in twodaTables) always win.
  //
  // HAK resolution: look in NWN_FOLDER_USER/hak/ first, NWN_FOLDER_DATA/hak/ as fallback.
  // In NWN, hakList[0] has highest priority. resman --erfs loads later entries with higher
  // priority, so we pass hakPaths in reverse order.
  const extraTwodas = new Map<string, TwoDATable>();

  if (NWN_FOLDER_DATA || NWN_FOLDER_USER) {
    const hakPaths = await resolveHakPaths(hakList, loadWarnings);

    // development/ folder: no subfolders, higher priority than override/
    const extraDirs: string[] = [];
    if (NWN_FOLDER_USER) {
      const devDir = path.join(NWN_FOLDER_USER, "development");
      try { await fs.access(devDir); extraDirs.push(devDir); } catch { /* not present */ }
    }

    try {
      const resman2daDir = path.join(tempDir, "resman_2da");
      await resmanExtract(resman2daDir, {
        root: NWN_FOLDER_DATA || undefined,
        userDir: NWN_FOLDER_USER || undefined,
        erfs: hakPaths.length > 0 ? [...hakPaths].reverse() : undefined,
        dirs: extraDirs.length > 0 ? extraDirs : undefined,
        pattern: ".2da",
      });

      const extracted = (await fs.readdir(resman2daDir)).filter(f => f.toLowerCase().endsWith(".2da"));
      let loaded = 0;
      for (let i = 0; i < extracted.length; i += BATCH_SIZE) {
        const batch = extracted.slice(i, i + BATCH_SIZE);
        const results = await Promise.allSettled(
          batch.map(async (fileName) => {
            const resref = path.basename(fileName, ".2da").toLowerCase();
            const raw = await twodaToJson(path.join(resman2daDir, fileName));
            return { resref, table: parse2DAJson(raw) };
          }),
        );
        for (const result of results) {
          if (result.status === "fulfilled") {
            extraTwodas.set(result.value.resref, result.value.table);
            loaded++;
          }
        }
      }
      console.error(`Loaded ${loaded} 2DAs via resman`);
    } catch (e) {
      console.error(`resman 2DA extraction failed: ${e}`);
      loadWarnings.push({ type: "resman", message: `resman 2DA extraction failed: ${e}` });
    }
  }

  // Merge — module 2DAs always win
  for (const [resref, table] of extraTwodas) {
    if (!twodaTables.has(resref)) {
      twodaTables.set(resref, table);
    }
  }

  currentIndex = {
    modPath: absPath,
    tempDir,
    moduleName,
    resources,
    tags,
    scripts,
    areas,
    dialogs,
    creatures,
    items,
    parsedGff,
    twodaTables,
    customTlk,
    baseTlk,
    hakList,
    customTlkName,
    loadWarnings,
  };

  return currentIndex;
}

function indexGffDocument(
  resourceFile: string,
  doc: GffDocument,
  tags: Map<string, TagLocation[]>,
  scripts: Map<string, ScriptUsage[]>,
  basePath: string = "",
  objectType: string = ""
): void {
  const obj = doc as GffObj;

  for (const [key, rawField] of Object.entries(obj)) {
    if (key === "__struct_id" || key === "__data_type") continue;

    const field = rawField as { type?: string; value?: unknown };
    if (!field || typeof field !== "object" || !("type" in field)) continue;

    const currentPath = basePath ? `${basePath}.${key}` : key;

    // Index tags
    if (key === "Tag" && field.type === "cexostring" && typeof field.value === "string" && field.value) {
      const tagValue = field.value as string;
      const loc: TagLocation = {
        resourceFile,
        gffPath: currentPath,
        objectType: objectType || guessObjectType(resourceFile),
        name: getFieldLocStr(obj, "FirstName") || getFieldLocStr(obj, "LocalizedName") || getFieldLocStr(obj, "LocName") || undefined,
      };
      const existing = tags.get(tagValue) || [];
      existing.push(loc);
      tags.set(tagValue, existing);
    }

    // Index script references
    if (SCRIPT_FIELDS.has(key) && field.type === "resref" && typeof field.value === "string" && field.value) {
      const scriptRef = field.value as string;
      const usage: ScriptUsage = {
        scriptResref: scriptRef,
        resourceFile,
        gffPath: currentPath,
        usageType: key,
      };
      const existing = scripts.get(scriptRef) || [];
      existing.push(usage);
      scripts.set(scriptRef, existing);
    }

    // Recurse into lists and structs
    if (field.type === "list" && Array.isArray(field.value)) {
      const listObjectType = guessListObjectType(key);
      (field.value as GffObj[]).forEach((item, i) => {
        indexGffDocument(resourceFile, item as GffDocument, tags, scripts, `${currentPath}[${i}]`, listObjectType);
      });
    } else if (field.type === "struct" && typeof field.value === "object" && field.value) {
      indexGffDocument(resourceFile, field.value as GffDocument, tags, scripts, currentPath, objectType);
    }
  }
}

function guessObjectType(resourceFile: string): string {
  const ext = path.extname(resourceFile).slice(1);
  const map: Record<string, string> = {
    utc: "creature", uti: "item", utp: "placeable", utd: "door",
    utt: "trigger", utm: "store", ute: "encounter", utw: "waypoint",
    uts: "sound", dlg: "dialog", are: "area", git: "area_instance",
    ifo: "module", fac: "faction",
  };
  return map[ext] || ext;
}

function guessListObjectType(fieldName: string): string {
  const map: Record<string, string> = {
    "Creature List": "creature",
    "Placeable List": "placeable",
    "Door List": "door",
    "TriggerList": "trigger",
    "WaypointList": "waypoint",
    "Encounter List": "encounter",
    "SoundList": "sound",
    "StoreList": "store",
    "List": "item",
    "ItemList": "item",
    "Equip_ItemList": "equipped_item",
    "EntryList": "dialog_entry",
    "ReplyList": "dialog_reply",
  };
  return map[fieldName] || "";
}

function buildAreaSummary(
  resref: string,
  areDoc: GffDocument,
  gitDoc: GffDocument | undefined
): AreaSummary {
  const are = areDoc as GffObj;
  const git = gitDoc as GffObj | undefined;

  return {
    resref,
    name: getFieldLocStr(are, "Name") || resref,
    width: getFieldNum(are, "Width"),
    height: getFieldNum(are, "Height"),
    tileset: getFieldStr(are, "Tileset"),
    isInterior: (getFieldNum(are, "Flags") & 1) !== 0,
    creatureCount: git ? getFieldList(git, "Creature List").length : 0,
    placeableCount: git ? getFieldList(git, "Placeable List").length : 0,
    doorCount: git ? getFieldList(git, "Door List").length : 0,
    encounterCount: git ? getFieldList(git, "Encounter List").length : 0,
    triggerCount: git ? getFieldList(git, "TriggerList").length : 0,
    waypointCount: git ? getFieldList(git, "WaypointList").length : 0,
  };
}

function indexAreaCreatures(areaResref: string, gitDoc: GffDocument, creatures: CreatureRecord[]): void {
  const git = gitDoc as GffObj;
  const creatureList = getFieldList(git, "Creature List");

  for (const creature of creatureList) {
    const classList = getFieldList(creature, "ClassList");
    creatures.push({
      tag: getFieldStr(creature, "Tag"),
      firstName: getFieldLocStr(creature, "FirstName"),
      lastName: getFieldLocStr(creature, "LastName"),
      cr: getFieldNum(creature, "ChallengeRating"),
      hp: getFieldNum(creature, "MaxHitPoints") || getFieldNum(creature, "CurrentHitPoints"),
      classes: classList.map(c => ({
        classId: getFieldNum(c, "Class"),
        level: getFieldNum(c, "ClassLevel"),
      })),
      conversation: getFieldStr(creature, "Conversation"),
      area: areaResref,
      faction: getFieldNum(creature, "FactionID"),
      position: {
        x: getFieldNum(creature, "XPosition"),
        y: getFieldNum(creature, "YPosition"),
        z: getFieldNum(creature, "ZPosition"),
      },
    });
  }
}

export function buildDialogSummary(
  resref: string,
  dlgDoc: GffDocument,
  creatures: CreatureRecord[]
): DialogSummary {
  const dlg = dlgDoc as GffObj;
  const entries = getFieldList(dlg, "EntryList");
  const replies = getFieldList(dlg, "ReplyList");
  const startingList = getFieldList(dlg, "StartingList");

  const scriptsUsed = new Set<string>();
  const conditionsUsed = new Set<string>();

  // Collect scripts from entries
  for (const entry of entries) {
    const script = getFieldStr(entry, "Script");
    if (script) scriptsUsed.add(script);
  }
  for (const reply of replies) {
    const script = getFieldStr(reply, "Script");
    if (script) scriptsUsed.add(script);
  }

  // Collect conditions from starting list and entry/reply links
  for (const start of startingList) {
    const active = getFieldStr(start, "Active");
    if (active) conditionsUsed.add(active);
  }
  for (const entry of entries) {
    for (const link of getFieldList(entry, "RepliesList")) {
      const active = getFieldStr(link, "Active");
      if (active) conditionsUsed.add(active);
    }
  }
  for (const reply of replies) {
    for (const link of getFieldList(reply, "EntriesList")) {
      const active = getFieldStr(link, "Active");
      if (active) conditionsUsed.add(active);
    }
  }

  // Find creatures that use this dialog
  const usedByCreatures = creatures
    .filter(c => c.conversation === resref)
    .map(c => c.tag);

  return {
    resref,
    entryCount: entries.length,
    replyCount: replies.length,
    startingNodes: startingList.map(s => getFieldNum(s, "Index")),
    scriptsUsed: [...scriptsUsed],
    conditionsUsed: [...conditionsUsed],
    usedByCreatures,
  };
}

function buildItemRecord(resref: string, doc: GffDocument, source: string): ItemRecord {
  const obj = doc as GffObj;
  return {
    tag: getFieldStr(obj, "Tag"),
    resref,
    name: getFieldLocStr(obj, "LocalizedName") || getFieldLocStr(obj, "LocName"),
    baseItem: getFieldNum(obj, "BaseItem"),
    cost: getFieldNum(obj, "Cost"),
    description: getFieldLocStr(obj, "Description") || getFieldLocStr(obj, "DescIdentified"),
    source,
  };
}

/**
 * Parse twodaToJson output into a TwoDATable.
 * twodaToJson returns { columns: string[], rows: [rowIndex, {col: val}][] }
 */
function parse2DAJson(raw: { columns: string[]; rows: Array<[number, Record<string, string>]> }): TwoDATable {
  const rows = new Map<number, Record<string, string>>();
  for (const [idx, rowData] of raw.rows) {
    rows.set(idx, rowData);
  }
  return { columns: raw.columns, rows };
}

/**
 * Parse nwn_tlk JSON output into a TlkTable (strref → text).
 * nwn_tlk outputs: { language: number, entries: [{ id: number, text: string }, ...] }
 * Empty entries are omitted from the array, so use the id field as the strref directly.
 */
function parseTlkJson(raw: unknown): TlkTable {
  const table: TlkTable = new Map();
  const data = raw as GffObj;

  // Format: { language, entries: [{id, text}, ...] }
  const entries = data?.entries;
  if (Array.isArray(entries)) {
    for (const entry of entries as Array<{ id?: number; text?: string }>) {
      if (entry && typeof entry.text === "string" && typeof entry.id === "number") {
        table.set(entry.id, entry.text);
      }
    }
  }
  return table;
}
