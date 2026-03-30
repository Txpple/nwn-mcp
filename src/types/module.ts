import type { GffDocument } from "./gff.js";

export interface ResourceEntry {
  resref: string;
  extension: string;
  filePath: string;
  sizeBytes: number;
}

export interface TagLocation {
  resourceFile: string;
  gffPath: string;
  objectType: string;
  name?: string;
}

export interface ScriptUsage {
  scriptResref: string;
  resourceFile: string;
  gffPath: string;
  usageType: string;
}

export interface AreaSummary {
  resref: string;
  name: string;
  width: number;
  height: number;
  tileset: string;
  creatureCount: number;
  placeableCount: number;
  doorCount: number;
  encounterCount: number;
  triggerCount: number;
  waypointCount: number;
  isInterior: boolean;
}

export interface DialogSummary {
  resref: string;
  entryCount: number;
  replyCount: number;
  startingNodes: number[];
  scriptsUsed: string[];
  conditionsUsed: string[];
  usedByCreatures: string[];
}

export interface CreatureRecord {
  tag: string;
  firstName: string;
  lastName: string;
  cr: number;
  hp: number;
  classes: Array<{ classId: number; level: number }>;
  conversation: string;
  area: string;
  faction: number;
  position: { x: number; y: number; z: number };
}

export interface ItemRecord {
  tag: string;
  resref: string;
  name: string;
  baseItem: number;
  cost: number;
  description: string;
  source: string; // "blueprint" or "area:creature_tag"
}

/** Parsed 2DA table: rows keyed by row index, each row is column→value */
export interface TwoDATable {
  columns: string[];
  rows: Map<number, Record<string, string>>;
}

/** Parsed TLK string table: strref → text */
export type TlkTable = Map<number, string>;

export interface ModuleIndex {
  modPath: string;
  tempDir: string;
  moduleName: string;
  resources: Map<string, ResourceEntry>;
  tags: Map<string, TagLocation[]>;
  scripts: Map<string, ScriptUsage[]>;
  areas: Map<string, AreaSummary>;
  dialogs: Map<string, DialogSummary>;
  creatures: CreatureRecord[];
  items: ItemRecord[];
  parsedGff: Map<string, GffDocument>;
  twodaTables: Map<string, TwoDATable>;
  customTlk: TlkTable | null;
  baseTlk: TlkTable | null;
  hakList: string[];
  customTlkName: string;
  loadWarnings: Array<{ type: string; message: string }>;
}
