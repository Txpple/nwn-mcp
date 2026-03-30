/**
 * Walkmesh (.wok) file parser and walkability validation.
 * Parses NWN ASCII walkmesh files to determine which positions are walkable,
 * and performs flood-fill reachability analysis across area tiles.
 */

import fs from "fs/promises";
import path from "path";
import { resmanExtract } from "../nim-tools.js";
import type { ResmanOptions } from "../nim-tools.js";
import type { ModuleIndex, TwoDATable } from "../types/module.js";
import { getFieldList, getFieldNum } from "../types/gff.js";
import type { GffObj } from "../types/gff.js";
import { getTilesetInfo, getRotatedCrossers } from "./tileset.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface WokData {
  verts: [number, number, number][];
  faces: WokFace[];
}

export interface WokFace {
  v1: number;
  v2: number;
  v3: number;
  surfaceMaterial: number;
}

export interface WalkabilityResult {
  walkable: boolean;
  material?: string;
  materialId?: number;
  error?: string;
}

export interface TileWalkSummary {
  walkablePercent: number;
  dominantMaterial: string;
  materials: Map<string, number>;  // material name → face count
  hasWater: boolean;
}

export interface ZoneInfo {
  id: string;
  tiles: Set<number>;       // tile indices in this zone
  walkablePercent: number;
  connected: boolean;        // reachable from the largest zone
  description: string;
  /** Area resrefs reachable via area transitions (doors/triggers) in this zone */
  transitionsOut?: string[];
}

/** An area transition object (door or trigger with active LinkedTo) for zone annotation */
export interface AreaTransitionInfo {
  x: number;
  y: number;
  targetArea: string;  // destination area resref
}

// ─── Surface Material Data ──────────────────────────────────────────────────

/** Default walkability flags from surfacemat.2da (fallback if 2DA not loaded) */
const DEFAULT_WALKABLE: Record<number, boolean> = {
  0: false,   // NotDefined
  1: true,    // Dirt
  2: false,   // Obscuring
  3: true,    // Grass
  4: true,    // Stone
  5: true,    // Wood
  6: true,    // Water
  7: false,   // Nonwalk
  8: false,   // Transparent
  9: true,    // Carpet
  10: true,   // Metal
  11: true,   // Puddles
  12: true,   // Swamp
  13: true,   // Mud
  14: true,   // Leaves
  15: false,  // Lava
  16: false,  // BottomlessPit
  17: false,  // DeepWater
  18: true,   // Door
  19: true,   // Snow
  20: true,   // Sand
  21: true,   // Barebones
  22: true,   // StoneBridge
};

const DEFAULT_MATERIAL_NAMES: Record<number, string> = {
  0: "NotDefined", 1: "Dirt", 2: "Obscuring", 3: "Grass", 4: "Stone",
  5: "Wood", 6: "Water", 7: "Nonwalk", 8: "Transparent", 9: "Carpet",
  10: "Metal", 11: "Puddles", 12: "Swamp", 13: "Mud", 14: "Leaves",
  15: "Lava", 16: "BottomlessPit", 17: "DeepWater", 18: "Door",
  19: "Snow", 20: "Sand", 21: "Barebones", 22: "StoneBridge",
};

/** Water material IDs */
const WATER_MATERIALS = new Set([6, 11, 12, 13]);

/** Check if a surface material is walkable, using surfacemat.2da if available */
export function isMaterialWalkable(materialId: number, surfacemat?: TwoDATable): boolean {
  if (surfacemat) {
    const row = surfacemat.rows.get(materialId);
    if (row) return row.Walk === "1";
  }
  return DEFAULT_WALKABLE[materialId] ?? false;
}

/** Get the display name of a surface material */
export function getMaterialName(materialId: number, surfacemat?: TwoDATable): string {
  if (surfacemat) {
    const row = surfacemat.rows.get(materialId);
    if (row?.Label) return row.Label;
  }
  return DEFAULT_MATERIAL_NAMES[materialId] ?? `Material_${materialId}`;
}

// ─── .wok Parser ────────────────────────────────────────────────────────────

/** Parse an ASCII .wok file into vertices and faces */
export function parseWokFile(content: string): WokData {
  const verts: [number, number, number][] = [];
  const faces: WokFace[] = [];
  const lines = content.split("\n");

  let i = 0;
  const len = lines.length;

  // Find "verts <count>" line
  while (i < len) {
    const line = lines[i].trim();
    if (line.startsWith("verts ")) {
      const vertCount = parseInt(line.split(/\s+/)[1], 10);
      i++;
      for (let v = 0; v < vertCount && i < len; v++, i++) {
        const parts = lines[i].trim().split(/\s+/);
        if (parts.length >= 3) {
          verts.push([parseFloat(parts[0]), parseFloat(parts[1]), parseFloat(parts[2])]);
        }
      }
      break;
    }
    i++;
  }

  // Find "faces <count>" line
  while (i < len) {
    const line = lines[i].trim();
    if (line.startsWith("faces ")) {
      const faceCount = parseInt(line.split(/\s+/)[1], 10);
      i++;
      for (let f = 0; f < faceCount && i < len; f++, i++) {
        const parts = lines[i].trim().split(/\s+/);
        // Format: v1 v2 v3 smooth adj1 adj2 adj3 surfaceMaterial
        if (parts.length >= 8) {
          faces.push({
            v1: parseInt(parts[0], 10),
            v2: parseInt(parts[1], 10),
            v3: parseInt(parts[2], 10),
            surfaceMaterial: parseInt(parts[7], 10),
          });
        }
      }
      break;
    }
    i++;
  }

  return { verts, faces };
}

// ─── WOK Cache ──────────────────────────────────────────────────────────────

const wokCache = new Map<string, WokData>();
let wokCacheDirPath = "";
let wokCacheDirReady = false;

/** Clear the walkmesh cache (call on load_module) */
export function clearWokCache(): void {
  wokCache.clear();
  wokCacheDirReady = false;
}

/** Set the wok cache directory path (call after tempDir is known) */
export function setWokCacheDir(tempDir: string): void {
  wokCacheDirPath = path.join(tempDir, "wok_cache");
  wokCacheDirReady = false;
}

/** Ensure the wok cache directory exists (lazy-init, one fs.mkdir per module load) */
export async function ensureWokCacheDir(): Promise<string> {
  if (!wokCacheDirReady) {
    await fs.mkdir(wokCacheDirPath, { recursive: true });
    wokCacheDirReady = true;
  }
  return wokCacheDirPath;
}

/** Sync lookup of cached WOK data (available after loadAreaWalkmeshData runs) */
export function getCachedWok(model: string): WokData | null {
  return wokCache.get(model.toLowerCase()) ?? null;
}

/** Get WOK data for a tile model, loading from resman if needed */
export async function getWokForTile(
  tileModel: string,
  resmanOpts: ResmanOptions,
  cacheDir: string,
): Promise<WokData | null> {
  const key = tileModel.toLowerCase();
  const cached = wokCache.get(key);
  if (cached) return cached;

  const wokFile = `${key}.wok`;
  const wokPath = path.join(cacheDir, wokFile);

  // Check if already extracted
  try {
    await fs.access(wokPath);
  } catch {
    // Extract from resman
    try {
      await resmanExtract(cacheDir, { ...resmanOpts, files: [wokFile] });
    } catch {
      return null;  // WOK not found in resman
    }
  }

  try {
    const content = await fs.readFile(wokPath, "utf-8");
    const wok = parseWokFile(content);
    wokCache.set(key, wok);
    return wok;
  } catch {
    return null;
  }
}

// ─── Geometry Helpers ───────────────────────────────────────────────────────

/** 2D point-in-triangle test using barycentric coordinates (ignores Z) */
export function pointInTriangle2D(
  px: number, py: number,
  ax: number, ay: number,
  bx: number, by: number,
  cx: number, cy: number,
): boolean {
  const denom = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
  if (Math.abs(denom) < 1e-10) return false;  // degenerate triangle

  const a = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / denom;
  const b = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / denom;
  const c = 1 - a - b;

  return a >= -1e-6 && b >= -1e-6 && c >= -1e-6;
}

/**
 * Apply inverse tile orientation rotation to convert world-local coords
 * to the tile's unrotated local space.
 *
 * Tile vertices are in unrotated space [-5, +5].
 * World-local coords are after subtracting tile origin.
 * We need to "un-rotate" the world coords to match the stored vertices.
 */
export function rotateForOrientation(x: number, y: number, orientation: number): [number, number] {
  switch (orientation % 4) {
    case 0: return [x, y];
    case 1: return [y, -x];      // inverse of 90° CW
    case 2: return [-x, -y];     // inverse of 180°
    case 3: return [-y, x];      // inverse of 270° CW
    default: return [x, y];
  }
}

// ─── Walkability Check ──────────────────────────────────────────────────────

/**
 * Check if a world position is walkable in a given area.
 * Pipeline: world pos → tile grid → tile model → .wok → triangle test → material check
 */
export async function checkPositionWalkable(
  worldX: number,
  worldY: number,
  areaResref: string,
  index: ModuleIndex,
  resmanOpts: ResmanOptions,
): Promise<WalkabilityResult> {
  // Get area data
  const areDoc = index.parsedGff.get(`${areaResref}.are`);
  if (!areDoc) return { walkable: false, error: `Area ${areaResref} not found` };

  const are = areDoc as GffObj;
  const width = getFieldNum(are, "Width");
  const height = getFieldNum(are, "Height");
  const tilesetResref = (are.Tileset as { value?: string })?.value ?? "";

  // Check bounds
  if (worldX < 0 || worldX >= width * 10 || worldY < 0 || worldY >= height * 10) {
    return { walkable: false, error: `Position (${worldX}, ${worldY}) is outside area bounds (0-${width * 10}, 0-${height * 10})` };
  }

  // World pos → tile grid
  const tileX = Math.floor(worldX / 10);
  const tileY = Math.floor(worldY / 10);
  const tileIndex = tileY * width + tileX;

  // Get tile data from Tile_List
  const tileList = getFieldList(are, "Tile_List");
  if (tileIndex >= tileList.length) {
    return { walkable: false, error: `Tile index ${tileIndex} out of range` };
  }

  const tileEntry = tileList[tileIndex];
  const tileId = getFieldNum(tileEntry, "Tile_ID");
  const tileOrientation = getFieldNum(tileEntry, "Tile_Orientation");

  // Get tileset info to look up tile model
  const tileset = await getTilesetInfo(tilesetResref, resmanOpts, index);
  if (tileId >= tileset.tiles.length) {
    return { walkable: false, error: `Tile ID ${tileId} not found in tileset ${tilesetResref}` };
  }

  const tileModel = tileset.tiles[tileId].model;

  // Load .wok
  const cacheDir = await ensureWokCacheDir();
  const wok = await getWokForTile(tileModel, resmanOpts, cacheDir);
  if (!wok) {
    return { walkable: false, error: `Walkmesh ${tileModel}.wok not found` };
  }

  // Convert world pos to tile-local coords
  const localX = (worldX - tileX * 10) - 5;
  const localY = (worldY - tileY * 10) - 5;

  // Apply inverse rotation
  const [rx, ry] = rotateForOrientation(localX, localY, tileOrientation);

  // Test against all faces
  const surfacemat = index.twodaTables.get("surfacemat");

  for (const face of wok.faces) {
    const v1 = wok.verts[face.v1];
    const v2 = wok.verts[face.v2];
    const v3 = wok.verts[face.v3];
    if (!v1 || !v2 || !v3) continue;

    if (pointInTriangle2D(rx, ry, v1[0], v1[1], v2[0], v2[1], v3[0], v3[1])) {
      const walkable = isMaterialWalkable(face.surfaceMaterial, surfacemat);
      return {
        walkable,
        material: getMaterialName(face.surfaceMaterial, surfacemat),
        materialId: face.surfaceMaterial,
      };
    }
  }

  return { walkable: false, error: "Position is not covered by any walkmesh face" };
}

// ─── Placement Safety Check ─────────────────────────────────────────────────

/** Buffer distance (meters) from non-walkable surfaces */
const PLACEMENT_BUFFER = 1.0;

/** Cardinal probe offsets at PLACEMENT_BUFFER distance */
const CARDINAL_PROBES: [string, number, number][] = [
  ["north", 0, PLACEMENT_BUFFER],
  ["south", 0, -PLACEMENT_BUFFER],
  ["east", PLACEMENT_BUFFER, 0],
  ["west", -PLACEMENT_BUFFER, 0],
];

/**
 * Check if a position is safe for object placement:
 * 1. The position itself must be walkable
 * 2. All cardinal probe points at 1m must also be walkable (buffer zone)
 *
 * Use this for all placement/move tools except doors and sounds.
 */
export async function checkPlacementWalkable(
  worldX: number,
  worldY: number,
  areaResref: string,
  index: ModuleIndex,
  resmanOpts: ResmanOptions,
): Promise<{ ok: boolean; reason?: string }> {
  // 1. Check the position itself
  const center = await checkPositionWalkable(worldX, worldY, areaResref, index, resmanOpts);
  if (!center.walkable) {
    const detail = center.error || `surface: ${center.material} (ID ${center.materialId})`;
    return { ok: false, reason: `Position is not walkable — ${detail}` };
  }

  // 2. Check cardinal probes for buffer zone
  for (const [dir, dx, dy] of CARDINAL_PROBES) {
    const probe = await checkPositionWalkable(worldX + dx, worldY + dy, areaResref, index, resmanOpts);
    if (!probe.walkable) {
      const surface = probe.material || "unknown";
      return { ok: false, reason: `Position is within ${PLACEMENT_BUFFER}m of non-walkable surface (${surface}) to the ${dir}` };
    }
  }

  return { ok: true };
}

// ─── Tile Walk Summary ──────────────────────────────────────────────────────

/** Compute a walkability summary for a single tile's walkmesh */
export function computeTileWalkSummary(wok: WokData, surfacemat?: TwoDATable): TileWalkSummary {
  const materials = new Map<string, number>();
  let walkableFaces = 0;
  let hasWater = false;

  for (const face of wok.faces) {
    const name = getMaterialName(face.surfaceMaterial, surfacemat);
    materials.set(name, (materials.get(name) ?? 0) + 1);

    if (isMaterialWalkable(face.surfaceMaterial, surfacemat)) {
      walkableFaces++;
    }
    if (WATER_MATERIALS.has(face.surfaceMaterial)) {
      hasWater = true;
    }
  }

  const total = wok.faces.length;
  const walkablePercent = total > 0 ? Math.round((walkableFaces / total) * 100) : 0;

  // Find dominant material — prefer walkable, fall back to any if no walkable faces
  const walkableMaterials = new Map<string, number>();
  for (const face of wok.faces) {
    if (isMaterialWalkable(face.surfaceMaterial, surfacemat)) {
      const name = getMaterialName(face.surfaceMaterial, surfacemat);
      walkableMaterials.set(name, (walkableMaterials.get(name) ?? 0) + 1);
    }
  }

  let dominantMaterial = "Unknown";
  let maxCount = 0;
  const source = walkableMaterials.size > 0 ? walkableMaterials : materials;
  for (const [name, count] of source) {
    if (count > maxCount) {
      maxCount = count;
      dominantMaterial = name;
    }
  }

  return { walkablePercent, dominantMaterial, materials, hasWater };
}

// ─── Zone Analysis ──────────────────────────────────────────────────────────

/**
 * Compute walkable zones (connected components) across an entire area.
 * Uses tile-level connectivity: two adjacent tiles are connected if both
 * have walkable areas near their shared edge.
 */
export async function computeWalkableZones(
  areaResref: string,
  index: ModuleIndex,
  resmanOpts: ResmanOptions,
  tileSummaries: Map<number, TileWalkSummary>,
  transitions?: AreaTransitionInfo[],
): Promise<ZoneInfo[]> {
  const areDoc = index.parsedGff.get(`${areaResref}.are`);
  if (!areDoc) return [];

  const are = areDoc as GffObj;
  const width = getFieldNum(are, "Width");
  const height = getFieldNum(are, "Height");
  const tilesetResref = (are.Tileset as { value?: string })?.value ?? "";
  const tileList = getFieldList(are, "Tile_List");
  const tileset = await getTilesetInfo(tilesetResref, resmanOpts, index);

  // Build adjacency: tile i is connected to tile j if both are walkable
  // and they share an edge where neither side has a blocking crosser pattern
  const totalTiles = width * height;
  const walkableTiles = new Set<number>();

  for (let i = 0; i < totalTiles; i++) {
    const summary = tileSummaries.get(i);
    if (summary && summary.walkablePercent > 0) {
      walkableTiles.add(i);
    }
  }

  // Adjacency list
  const adj = new Map<number, Set<number>>();
  for (const ti of walkableTiles) {
    adj.set(ti, new Set());
  }

  for (const ti of walkableTiles) {
    const tx = ti % width;
    const ty = Math.floor(ti / width);

    // Check tile connectivity based on shared edges and crosser patterns
    const tileEntry = tileList[ti];
    const tileId = getFieldNum(tileEntry, "Tile_ID");
    const tileOri = getFieldNum(tileEntry, "Tile_Orientation");
    const tile = tileset.tiles[tileId];
    const crossers = tile ? getRotatedCrossers(tile, tileOri) : { top: "", right: "", bottom: "", left: "" };

    // Right neighbor
    if (tx + 1 < width) {
      const ni = ti + 1;
      if (walkableTiles.has(ni)) {
        // Connected unless blocked by wall crosser
        if (crossers.right !== "Wall") {
          adj.get(ti)!.add(ni);
          adj.get(ni)!.add(ti);
        }
      }
    }

    // Top neighbor (y+1)
    if (ty + 1 < height) {
      const ni = ti + width;
      if (walkableTiles.has(ni)) {
        if (crossers.top !== "Wall") {
          adj.get(ti)!.add(ni);
          adj.get(ni)!.add(ti);
        }
      }
    }
  }

  // Flood fill to find connected components
  const visited = new Set<number>();
  const zones: ZoneInfo[] = [];
  const labels = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

  for (const ti of walkableTiles) {
    if (visited.has(ti)) continue;

    const zone = new Set<number>();
    const queue = [ti];
    visited.add(ti);

    while (queue.length > 0) {
      const current = queue.shift()!;
      zone.add(current);

      for (const neighbor of adj.get(current) ?? []) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          queue.push(neighbor);
        }
      }
    }

    const zoneId = labels[zones.length] ?? `Z${zones.length}`;

    // Compute average walkability for the zone
    let totalWalk = 0;
    for (const t of zone) {
      totalWalk += tileSummaries.get(t)?.walkablePercent ?? 0;
    }

    // Describe zone location
    const tileCoords = [...zone].map(t => ({ x: t % width, y: Math.floor(t / width) }));
    const minX = Math.min(...tileCoords.map(c => c.x));
    const maxX = Math.max(...tileCoords.map(c => c.x));
    const minY = Math.min(...tileCoords.map(c => c.y));
    const maxY = Math.max(...tileCoords.map(c => c.y));

    let description: string;
    if (zone.size === totalTiles) {
      description = "entire area";
    } else if (zone.size > totalTiles * 0.5) {
      description = "main area";
    } else {
      // Describe by location
      const cx = (minX + maxX) / 2;
      const cy = (minY + maxY) / 2;
      const nsLabel = cy > height * 0.66 ? "N" : cy < height * 0.33 ? "S" : "";
      const ewLabel = cx > width * 0.66 ? "E" : cx < width * 0.33 ? "W" : "";
      const locStr = nsLabel + ewLabel || "center";
      description = `${zone.size} tile${zone.size > 1 ? "s" : ""}, ${locStr} area`;
    }

    zones.push({
      id: zoneId,
      tiles: zone,
      walkablePercent: zone.size > 0 ? Math.round(totalWalk / zone.size) : 0,
      connected: false,  // set below
      description,
    });
  }

  // Mark the largest zone as "main" and check connectivity
  if (zones.length > 0) {
    zones.sort((a, b) => b.tiles.size - a.tiles.size);
    zones[0].connected = true;
    zones[0].description = zones[0].tiles.size > totalTiles * 0.3 ? "main area" : zones[0].description;

    for (let i = 1; i < zones.length; i++) {
      zones[i].connected = false;
    }
  }

  // Annotate zones with area transitions (doors/triggers with active links)
  if (transitions && transitions.length > 0) {
    for (const tr of transitions) {
      const tileCol = Math.floor(tr.x / 10);
      const tileRow = Math.floor(tr.y / 10);
      if (tileCol < 0 || tileCol >= width || tileRow < 0 || tileRow >= height) continue;
      const tileIdx = tileRow * width + tileCol;
      for (const zone of zones) {
        if (zone.tiles.has(tileIdx)) {
          if (!zone.transitionsOut) zone.transitionsOut = [];
          if (!zone.transitionsOut.includes(tr.targetArea)) {
            zone.transitionsOut.push(tr.targetArea);
          }
          break;
        }
      }
    }
  }

  return zones;
}

/**
 * Load walkmesh data for all unique tiles in an area and compute summaries.
 * Returns a map from tile index → TileWalkSummary.
 */
export async function loadAreaWalkmeshData(
  areaResref: string,
  index: ModuleIndex,
  resmanOpts: ResmanOptions,
): Promise<Map<number, TileWalkSummary>> {
  const areDoc = index.parsedGff.get(`${areaResref}.are`);
  if (!areDoc) return new Map();

  const are = areDoc as GffObj;
  const tilesetResref = (are.Tileset as { value?: string })?.value ?? "";
  const tileList = getFieldList(are, "Tile_List");

  const tileset = await getTilesetInfo(tilesetResref, resmanOpts, index);
  const surfacemat = index.twodaTables.get("surfacemat");
  const cacheDir = await ensureWokCacheDir();

  // Batch-extract unique .wok files
  const uniqueModels = new Set<string>();
  for (const entry of tileList) {
    const tileId = getFieldNum(entry, "Tile_ID");
    if (tileId < tileset.tiles.length) {
      uniqueModels.add(tileset.tiles[tileId].model.toLowerCase());
    }
  }

  // Extract all unique wok files at once
  const wokFiles = [...uniqueModels].map(m => `${m}.wok`);
  if (wokFiles.length > 0) {
    try {
      await resmanExtract(cacheDir, { ...resmanOpts, files: wokFiles });
    } catch {
      // Some files may not exist — that's OK, we'll handle per-tile
    }
  }

  // Compute summaries
  const summaries = new Map<number, TileWalkSummary>();

  for (let i = 0; i < tileList.length; i++) {
    const entry = tileList[i];
    const tileId = getFieldNum(entry, "Tile_ID");
    if (tileId >= tileset.tiles.length) continue;

    const model = tileset.tiles[tileId].model;
    const wok = await getWokForTile(model, resmanOpts, cacheDir);
    if (wok) {
      summaries.set(i, computeTileWalkSummary(wok, surfacemat));
    }
  }

  return summaries;
}
