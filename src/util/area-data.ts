/**
 * Shared area data extraction for the spatial awareness payload and HTML report export.
 * Computes tile render data from tileset/walkmesh sources using
 * surfacemat.2da material types (not arbitrary tileset terrain names).
 *
 * Data flow: this module produces the canonical JSON spatial payload that the LLM
 * uses for spatial reasoning. HTML export tools consume this same data to render
 * human-readable visualizations — the HTML is always downstream of the payload.
 */

import { getFieldList, getFieldNum, getFieldLocStrResolved, getFieldStr } from "../types/gff.js";
import type { GffObj } from "../types/gff.js";
import type { ModuleIndex } from "../types/module.js";
import type { TilesetInfo } from "./tileset.js";
import { getRotatedCorners, getRotatedCrossers, findTileGroup } from "./tileset.js";
import type { TileWalkSummary, WokData } from "./walkmesh.js";
import { getCachedWok, getMaterialName } from "./walkmesh.js";
import type { TwoDATable } from "../types/module.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface TileRenderData {
  col: number;
  row: number;
  tileId: number;
  orientation: number;
  /** Dominant terrain from tileset .set file (arbitrary name, used for ASCII fill chars only) */
  dominantTerrain: string;
  /** Corner terrain names from .set file */
  cornerTerrains: { tl: string; tr: string; bl: string; br: string };
  /** Crosser types on each edge */
  crossers: { top: string; right: string; bottom: string; left: string };
  /** Walkability percentage from walkmesh (0-100) */
  walkablePercent: number;
  /** Dominant surface material from surfacemat.2da (standardized engine type) */
  dominantMaterial: string;
  /** Full material breakdown: material name → face count */
  materials: Map<string, number>;
  /** Whether tile has water surfaces */
  hasWater: boolean;
  /** Multi-tile group name if part of a feature */
  groupName: string | null;
  /** Tile model filename (from tileset .set file) */
  tileModel: string;
  /** Pre-computed SVG triangles from walkmesh geometry */
  triangles: TileTriangle[];
}

export interface TileTriangle {
  /** SVG polygon points "x1,y1 x2,y2 x3,y3" in normalized 0-1 coords */
  points: string;
  /** CSS hex color for this triangle's surface material */
  color: string;
}

export interface FeatureLabel {
  name: string;
  col: number;
  row: number;
  cols: number;
  rows: number;
}

export interface AreaObjectData {
  type: "creature" | "door" | "placeable" | "waypoint" | "trigger" | "encounter" | "sound" | "store";
  name: string;
  tag: string;
  x: number;
  y: number;
  /** For doors/triggers: destination tag (area transition target) */
  linkedTo?: string;
  /** For doors/triggers: 1 = active area transition link */
  linkedToFlags?: number;
  /** For doors: whether locked */
  locked?: boolean;
  /** For doors: key tag required to unlock */
  keyName?: string;
  /** For doors: open lock difficulty class */
  lockDC?: number;
  /** For placeables: whether it can be used/activated */
  useable?: boolean;
  /** For placeables: whether it has an inventory container */
  hasInventory?: boolean;
  /** For placeables: whether it is static (non-interactive decoration) */
  static?: boolean;
  /** For creatures: challenge rating */
  cr?: number;
  /** For creatures: hit points */
  hp?: number;
  /** For creatures: class summary string */
  classes?: string;
  /** For creatures: hostile faction */
  hostile?: boolean;
  /** For creatures: has a dialog assigned */
  hasDialog?: boolean;
  /** For sounds/encounters: whether active */
  active?: boolean;
  /** For sounds: whether continuous */
  continuous?: boolean;
  /** For sounds: whether looping */
  looping?: boolean;
  /** For sounds: volume (0-127) */
  volume?: number;
  /** For sounds: max audible distance in meters */
  maxDistance?: number;
  /** For stores: buy markup percentage */
  markUp?: number;
  /** For stores: sell markdown percentage */
  markDown?: number;
  /** For stores: gold on hand */
  storeGold?: number;
  /** For stores: inventory by category (may be empty for toolset-placed stores where inventory is in the blueprint) */
  inventory?: Array<{ categoryIndex: number; items: Array<{ resref: string; name: string; infinite: boolean }> }>;
  /** For waypoints: description text */
  description?: string;
  /** For waypoints: map note text */
  mapNote?: string;
  /** For waypoints: whether map note is enabled */
  mapNoteEnabled?: boolean;
  /** For waypoints: whether a map note exists */
  hasMapNote?: boolean;
  /** For encounters: difficulty index */
  difficulty?: number;
  /** For encounters: max creatures to spawn */
  maxCreatures?: number;
  /** For encounters: whether encounter respawns */
  respawns?: boolean;
  /** For encounters: creature spawn list */
  creatures?: Array<{ resref: string; cr: number }>;
  /** For triggers: trigger type (0=generic, 1=transition, etc.) */
  triggerType?: number;
  /** For triggers: assigned scripts (only non-empty entries included) */
  scripts?: Record<string, string>;
}

// ─── Surface Material Colors (from surfacemat.2da) ──────────────────────────

/** CSS hex colors for each surfacemat.2da material type */
export const MATERIAL_COLORS: Record<string, string> = {
  // Walkable materials
  "Dirt":         "#8B7355",
  "Grass":        "#4a8c3f",
  "Stone":        "#808080",
  "Wood":         "#8B6914",
  "Water":        "#2E86C1",
  "Carpet":       "#8B4513",
  "Metal":        "#A9A9A9",
  "Puddles":      "#5DADE2",
  "Swamp":        "#2E4A1E",
  "Mud":          "#6B4423",
  "Leaves":       "#6B8E23",
  "Door":         "#CD853F",
  "Snow":         "#D5D8DC",
  "Sand":         "#C4A84A",
  "Barebones":    "#777777",
  "StoneBridge":  "#999999",
  // Non-walkable materials
  "NotDefined":   "#111111",
  "Obscuring":    "#ffe000",
  "Nonwalk":      "#ff1a1a",
  "Transparent":  "#1a1a1a",
  "Lava":         "#8B0000",
  "BottomlessPit": "#000000",
  "DeepWater":    "#1a3a5a",
};

/** Whether a material is walkable (matches surfacemat.2da Walk column) */
export const MATERIAL_WALKABLE: Record<string, boolean> = {
  "NotDefined": false,
  "Dirt": true,
  "Obscuring": false,
  "Grass": true,
  "Stone": true,
  "Wood": true,
  "Water": true,
  "Nonwalk": false,
  "Transparent": false,
  "Carpet": true,
  "Metal": true,
  "Puddles": true,
  "Swamp": true,
  "Mud": true,
  "Leaves": true,
  "Lava": false,
  "BottomlessPit": false,
  "DeepWater": false,
  "Door": true,
  "Snow": true,
  "Sand": true,
  "Barebones": true,
  "StoneBridge": true,
};

/** Whether a material is water */
export const MATERIAL_IS_WATER: Record<string, boolean> = {
  "Water": true,
  "Puddles": true,
  "Swamp": true,
  "Mud": true,
  "DeepWater": true,
};

/** Get CSS color for a material name, with fallback */
export function getMaterialColor(material: string): string {
  return MATERIAL_COLORS[material] ?? "#555555";
}

// ─── Walkmesh Triangle Computation ──────────────────────────────────────────

/**
 * Apply forward tile rotation (local → world-oriented).
 * This is the opposite of rotateForOrientation() in walkmesh.ts which does inverse.
 */
function forwardRotate(x: number, y: number, orientation: number): [number, number] {
  switch (orientation % 4) {
    case 0: return [x, y];
    case 1: return [-y, x];       // 90° CW
    case 2: return [-x, -y];      // 180°
    case 3: return [y, -x];       // 270° CW
    default: return [x, y];
  }
}

/**
 * Compute SVG triangle data from a tile's walkmesh.
 * Transforms WOK vertices → normalized 0-1 SVG coords.
 *
 * Tile walkmesh is always 10x10m but some models (e.g. ttf01_a02_01)
 * have their origin shifted from the standard (0,0) center. We detect
 * this by computing the bounding box center and re-centering to -5..+5
 * before applying the standard normalization.
 */
function computeTileTriangles(
  wok: WokData,
  orientation: number,
  surfacemat?: TwoDATable,
): TileTriangle[] {
  if (wok.faces.length === 0) return [];

  // First pass: compute bounding box of raw (pre-rotation) vertices
  let rawMinX = Infinity, rawMaxX = -Infinity, rawMinY = Infinity, rawMaxY = -Infinity;
  const referenced = new Set<number>();
  for (const face of wok.faces) {
    for (const vi of [face.v1, face.v2, face.v3]) {
      if (referenced.has(vi)) continue;
      referenced.add(vi);
      const v = wok.verts[vi];
      if (!v) continue;
      if (v[0] < rawMinX) rawMinX = v[0];
      if (v[0] > rawMaxX) rawMaxX = v[0];
      if (v[1] < rawMinY) rawMinY = v[1];
      if (v[1] > rawMaxY) rawMaxY = v[1];
    }
  }

  // Compute origin shift: how far the center is from (0,0)
  const offsetX = (rawMinX + rawMaxX) / 2;
  const offsetY = (rawMinY + rawMaxY) / 2;

  // Second pass: re-center, rotate, normalize to 0-1 SVG space
  const triangles: TileTriangle[] = [];
  for (const face of wok.faces) {
    const v1 = wok.verts[face.v1];
    const v2 = wok.verts[face.v2];
    const v3 = wok.verts[face.v3];
    if (!v1 || !v2 || !v3) continue;

    const pts: string[] = [];
    for (const [vx, vy] of [v1, v2, v3]) {
      // Re-center to standard -5..+5 range, then rotate
      const [rx, ry] = forwardRotate(vx - offsetX, vy - offsetY, orientation);
      const nx = (rx + 5) / 10;
      const ny = (5 - ry) / 10;
      pts.push(`${nx.toFixed(3)},${ny.toFixed(3)}`);
    }

    const matName = getMaterialName(face.surfaceMaterial, surfacemat);
    triangles.push({
      points: pts.join(" "),
      color: getMaterialColor(matName),
    });
  }
  return triangles;
}

// ─── Area Data Builder ──────────────────────────────────────────────────────

export interface AreaRenderResult {
  grid: TileRenderData[][];
  features: FeatureLabel[];
  width: number;
  height: number;
  areaName: string;
}

/**
 * Build the full tile render data grid for an area.
 * Each tile includes tileset terrain data AND walkmesh material data.
 */
export function buildAreaRenderData(
  areaResref: string,
  index: ModuleIndex,
  tileset: TilesetInfo,
  walkData: Map<number, TileWalkSummary>,
): AreaRenderResult {
  const areDoc = index.parsedGff.get(`${areaResref}.are`);
  if (!areDoc) return { grid: [], features: [], width: 0, height: 0, areaName: areaResref };

  const are = areDoc as GffObj;
  const width = getFieldNum(are, "Width");
  const height = getFieldNum(are, "Height");
  const areaName = ((are.Name as { value?: unknown })?.value as Record<string, string> | undefined)?.["0"] ?? areaResref;
  const tileList = getFieldList(are, "Tile_List");
  const surfacemat = index.twodaTables.get("surfacemat");

  // Build grid
  const grid: TileRenderData[][] = [];
  for (let row = 0; row < height; row++) {
    const gridRow: TileRenderData[] = [];
    for (let col = 0; col < width; col++) {
      const tileIndex = row * width + col;
      const tileEntry = tileList[tileIndex];
      const walkSummary = walkData.get(tileIndex);

      if (!tileEntry) {
        gridRow.push(emptyTileRender(col, row));
        continue;
      }

      const tileId = getFieldNum(tileEntry, "Tile_ID");
      const orientation = getFieldNum(tileEntry, "Tile_Orientation");
      const tile = tileId < tileset.tiles.length ? tileset.tiles[tileId] : null;

      if (!tile) {
        gridRow.push(emptyTileRender(col, row));
        continue;
      }

      const corners = getRotatedCorners(tile, orientation);
      const crossers = getRotatedCrossers(tile, orientation);

      // Dominant terrain from tileset (for ASCII display)
      const terrainCounts = new Map<string, number>();
      for (const t of [corners.topLeft, corners.topRight, corners.bottomLeft, corners.bottomRight]) {
        if (t) terrainCounts.set(t, (terrainCounts.get(t) ?? 0) + 1);
      }
      let dominantTerrain = "";
      let maxCount = 0;
      for (const [terrain, count] of terrainCounts) {
        if (count > maxCount) { maxCount = count; dominantTerrain = terrain; }
      }

      // Compute walkmesh triangles from cached WOK data
      const wok = getCachedWok(tile.model);
      const triangles = wok ? computeTileTriangles(wok, orientation, surfacemat) : [];

      gridRow.push({
        col, row, tileId, orientation,
        dominantTerrain,
        cornerTerrains: { tl: corners.topLeft, tr: corners.topRight, bl: corners.bottomLeft, br: corners.bottomRight },
        crossers: { top: crossers.top, right: crossers.right, bottom: crossers.bottom, left: crossers.left },
        walkablePercent: walkSummary?.walkablePercent ?? 0,
        dominantMaterial: walkSummary?.dominantMaterial ?? "NotDefined",
        materials: walkSummary?.materials ?? new Map(),
        hasWater: walkSummary?.hasWater ?? false,
        groupName: tile.groupName,
        tileModel: tile.model,
        triangles,
      });
    }
    grid.push(gridRow);
  }

  // Detect features
  const features = detectFeatures(grid, tileList, tileset, width, height);

  return { grid, features, width, height, areaName };
}

// ─── Object Extraction ──────────────────────────────────────────────────────

/** Build a TLK lookup function from the module index (custom TLK first, then base) */
export function buildTlkLookup(index: ModuleIndex): ((strref: number) => string | undefined) | undefined {
  if (!index.baseTlk && !index.customTlk) return undefined;
  return (strref: number) => {
    // Custom TLK strrefs are offset by 0x01000000
    if (index.customTlk && strref >= 0x01000000) {
      return index.customTlk.get(strref - 0x01000000);
    }
    return index.baseTlk?.get(strref);
  };
}

/** Extract placed objects from area GIT for overlay markers */
export function extractAreaObjects(index: ModuleIndex, areaResref: string): AreaObjectData[] {
  const gitDoc = index.parsedGff.get(`${areaResref}.git`);
  if (!gitDoc) return [];

  const git = gitDoc as GffObj;
  const objects: AreaObjectData[] = [];

  const lists: Array<{ field: string; type: AreaObjectData["type"]; posFields: "XY" | "XPos" }> = [
    { field: "Creature List", type: "creature", posFields: "XPos" },
    { field: "Door List", type: "door", posFields: "XY" },
    { field: "Placeable List", type: "placeable", posFields: "XY" },
    { field: "WaypointList", type: "waypoint", posFields: "XPos" },
    { field: "TriggerList", type: "trigger", posFields: "XPos" },
    { field: "Encounter List", type: "encounter", posFields: "XPos" },
    { field: "SoundList", type: "sound", posFields: "XPos" },
    { field: "StoreList", type: "store", posFields: "XPos" },
  ];

  const tlkLookup = buildTlkLookup(index);

  for (const { field, type, posFields } of lists) {
    const list = getFieldList(git, field);
    for (const entry of list) {
      const name = getFieldLocStrResolved(entry, "FirstName", tlkLookup) || getFieldLocStrResolved(entry, "LocName", tlkLookup) || getFieldStr(entry, "Tag") || type;
      const tag = getFieldStr(entry, "Tag") || "";

      let x: number, y: number;
      if (posFields === "XY") {
        x = getFieldNum(entry, "X");
        y = getFieldNum(entry, "Y");
      } else {
        x = getFieldNum(entry, "XPosition");
        y = getFieldNum(entry, "YPosition");
      }

      const obj: AreaObjectData = { type, name, tag, x, y };

      // Extract transition link data for doors and triggers
      if (type === "door" || type === "trigger") {
        const linkedTo = getFieldStr(entry, "LinkedTo");
        const linkedToFlags = getFieldNum(entry, "LinkedToFlags");
        if (linkedTo) obj.linkedTo = linkedTo;
        if (linkedToFlags) obj.linkedToFlags = linkedToFlags;
      }

      // Extract door lock data
      if (type === "door") {
        obj.locked = getFieldNum(entry, "Locked") === 1;
        const keyName = getFieldStr(entry, "KeyName");
        if (keyName) obj.keyName = keyName;
        const lockDC = getFieldNum(entry, "OpenLockDC");
        if (lockDC) obj.lockDC = lockDC;
      }

      // Extract placeable properties
      if (type === "placeable") {
        obj.useable = getFieldNum(entry, "Useable") === 1;
        obj.hasInventory = getFieldNum(entry, "HasInventory") === 1;
        obj.static = getFieldNum(entry, "Static") === 1;
      }

      // Extract creature stats
      if (type === "creature") {
        obj.cr = getFieldNum(entry, "ChallengeRating");
        obj.hp = getFieldNum(entry, "MaxHitPoints") || getFieldNum(entry, "HitPoints") || getFieldNum(entry, "CurrentHitPoints");
        obj.hostile = getFieldNum(entry, "FactionID") === 1;
        obj.hasDialog = !!getFieldStr(entry, "Conversation");
        const classList = getFieldList(entry, "ClassList");
        obj.classes = classList.map(cl => {
          const classId = getFieldNum(cl, "Class");
          const level = getFieldNum(cl, "ClassLevel");
          return `class${classId}/lv${level}`;
        }).join(", ") || "unknown";
      }

      // Extract sound properties
      if (type === "sound") {
        obj.active = getFieldNum(entry, "Active") === 1;
        obj.continuous = getFieldNum(entry, "Continuous") === 1;
        obj.looping = getFieldNum(entry, "Looping") === 1;
        obj.volume = getFieldNum(entry, "Volume");
        obj.maxDistance = getFieldNum(entry, "MaxDistance");
      }

      // Extract store properties
      if (type === "store") {
        obj.markUp = getFieldNum(entry, "MarkUp");
        obj.markDown = getFieldNum(entry, "MarkDown");
        obj.storeGold = getFieldNum(entry, "StoreGold");
        const storeList = getFieldList(entry, "StoreList");
        obj.inventory = storeList.map((category, i) => {
          const items = getFieldList(category, "ItemList").map(item => ({
            resref: getFieldStr(item, "InventoryRes") || "",
            name: getFieldLocStrResolved(item, "LocalizedName", tlkLookup) || getFieldLocStrResolved(item, "LocName", tlkLookup) || "",
            infinite: getFieldNum(item, "Infinite") === 1,
          }));
          return { categoryIndex: i, items };
        });
      }

      // Extract waypoint properties
      if (type === "waypoint") {
        obj.description = getFieldLocStrResolved(entry, "Description", tlkLookup) || undefined;
        obj.hasMapNote = getFieldNum(entry, "HasMapNote") === 1;
        obj.mapNote = getFieldLocStrResolved(entry, "MapNote", tlkLookup) || undefined;
        obj.mapNoteEnabled = getFieldNum(entry, "MapNoteEnabled") === 1;
      }

      // Extract encounter properties
      if (type === "encounter") {
        obj.active = getFieldNum(entry, "Active") === 1;
        obj.difficulty = getFieldNum(entry, "DifficultyIndex");
        obj.maxCreatures = getFieldNum(entry, "MaxCreatures");
        obj.respawns = getFieldNum(entry, "Respawns") === 1;
        obj.creatures = getFieldList(entry, "CreatureList").map(c => ({
          resref: getFieldStr(c, "Resref") || "",
          cr: getFieldNum(c, "CR"),
        }));
      }

      // Extract trigger properties
      if (type === "trigger") {
        obj.triggerType = getFieldNum(entry, "Type");
        const rawScripts: Record<string, string> = {
          onEnter: getFieldStr(entry, "OnEnter") || getFieldStr(entry, "ScriptOnEnter") || "",
          onExit: getFieldStr(entry, "OnExit") || getFieldStr(entry, "ScriptOnExit") || "",
          onClick: getFieldStr(entry, "OnClick") || "",
          onDisarm: getFieldStr(entry, "OnDisarm") || "",
          onTrapTriggered: getFieldStr(entry, "OnTrapTriggered") || "",
          heartbeat: getFieldStr(entry, "ScriptHeartbeat") || "",
          userDefined: getFieldStr(entry, "ScriptUserDefine") || "",
        };
        obj.scripts = Object.fromEntries(Object.entries(rawScripts).filter(([, v]) => v !== ""));
      }

      objects.push(obj);
    }
  }

  return objects;
}

// ─── Internal Helpers ───────────────────────────────────────────────────────

function emptyTileRender(col: number, row: number): TileRenderData {
  return {
    col, row, tileId: -1, orientation: 0,
    dominantTerrain: "",
    cornerTerrains: { tl: "", tr: "", bl: "", br: "" },
    crossers: { top: "", right: "", bottom: "", left: "" },
    walkablePercent: 0,
    dominantMaterial: "NotDefined",
    materials: new Map(),
    hasWater: false,
    groupName: null,
    tileModel: "",
    triangles: [],
  };
}

function detectFeatures(
  _grid: TileRenderData[][],
  tileList: GffObj[],
  tileset: TilesetInfo,
  width: number,
  height: number,
): FeatureLabel[] {
  const featureLabels: FeatureLabel[] = [];
  const usedTiles = new Set<number>();

  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const tileIndex = row * width + col;
      if (usedTiles.has(tileIndex)) continue;

      const tileEntry = tileList[tileIndex];
      if (!tileEntry) continue;
      const tileId = getFieldNum(tileEntry, "Tile_ID");
      const group = findTileGroup(tileset, tileId);
      if (!group) continue;

      const firstGroupTileId = group.tileIds.find(id => id >= 0);
      if (firstGroupTileId === undefined || tileId !== firstGroupTileId) continue;

      for (let gr = 0; gr < group.rows; gr++) {
        for (let gc = 0; gc < group.columns; gc++) {
          const ti = (row + gr) * width + (col + gc);
          usedTiles.add(ti);
        }
      }

      featureLabels.push({ name: group.name, col, row, cols: group.columns, rows: group.rows });
    }
  }

  return featureLabels;
}
