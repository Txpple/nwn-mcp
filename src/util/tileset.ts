/**
 * Tileset .set file parser and cache.
 * Parses NWN tileset definition files into structured data for tile solving,
 * visualization, and area creation.
 */

import { resmanExtract, resmanGrep } from "../nim-tools.js";
import type { ResmanOptions } from "../nim-tools.js";
import type { ModuleIndex, TlkTable } from "../types/module.js";
import fs from "fs/promises";
import path from "path";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface TilesetInfo {
  resref: string;
  displayName: string;       // resolved from TLK or raw name
  interior: boolean;
  hasHeightTransition: boolean;
  envMap: string;
  transition: number;
  border: string;
  defaultTerrain: string;
  floor: string;
  terrainTypes: TerrainType[];
  crosserTypes: CrosserType[];
  primaryRules: PrimaryRule[];
  secondaryRules: PrimaryRule[];
  tiles: TileDefinition[];
  groups: TileGroup[];
}

export interface TerrainType {
  index: number;
  name: string;
  /** Original .set file terrain name (lowercase). Matches tile corner values and validPairs keys.
   *  `name` may be overwritten by TLK resolution (e.g. "floor" → "Floor (Interior)"),
   *  but rawName always stays as the .set value so layout/solver code can match against it. */
  rawName: string;
  strref: number;
}

export interface CrosserType {
  index: number;
  name: string;
  strref: number;
}

export interface PrimaryRule {
  placed: string;
  placedHeight: number;
  adjacent: string;
  adjacentHeight: number;
  changed: string;
  changedHeight: number;
}

export interface TileDoorPlacement {
  x: number;           // tile-local offset [-5, +5]
  y: number;
  z: number;
  orientation: number; // degrees
  type: number;
}

export interface TileDefinition {
  id: number;
  model: string;
  imageMap2D: string;
  corners: TileCorners;
  crossers: TileCrossers;
  /** True if all corner heights are 0 (no elevation). Height tiles are excluded from solving. */
  flat: boolean;
  pathNode: string;
  doors: number;
  doorPlacements: TileDoorPlacement[];
  sounds: number;
  orientation: number;
  groupId: number | null;
  groupName: string | null;
}

export interface TileCorners {
  topLeft: string;
  topRight: string;
  bottomLeft: string;
  bottomRight: string;
}

export interface TileCrossers {
  top: string;
  right: string;
  bottom: string;
  left: string;
}

export interface TileGroup {
  index: number;
  name: string;
  strref: number;
  rows: number;
  columns: number;
  tileIds: number[];  // length = rows * columns, -1 = empty slot
}

// ─── Parser ─────────────────────────────────────────────────────────────────

/** Parse a .set file content string into structured TilesetInfo */
export function parseTilesetFile(content: string, resref: string): TilesetInfo {
  const sections = parseSections(content);

  // [GENERAL]
  const general = sections.get("GENERAL") ?? {};
  const _displayNameStrref = parseInt(general.DisplayName ?? "-1", 10);
  const interior = general.Interior === "1";
  const hasHeightTransition = general.HasHeightTransition === "1";

  // [TERRAIN TYPES]
  const terrainCount = parseInt(sections.get("TERRAIN TYPES")?.Count ?? "0", 10);
  const terrainTypes: TerrainType[] = [];
  for (let i = 0; i < terrainCount; i++) {
    const s = sections.get(`TERRAIN${i}`) ?? {};
    const rawName = (s.Name ?? `Terrain${i}`).toLowerCase();
    terrainTypes.push({
      index: i,
      name: rawName,
      rawName,
      strref: parseInt(s.StrRef ?? "0", 10),
    });
  }

  // [CROSSER TYPES]
  const crosserCount = parseInt(sections.get("CROSSER TYPES")?.Count ?? "0", 10);
  const crosserTypes: CrosserType[] = [];
  for (let i = 0; i < crosserCount; i++) {
    const s = sections.get(`CROSSER${i}`) ?? {};
    crosserTypes.push({
      index: i,
      name: (s.Name ?? `Crosser${i}`).toLowerCase(),
      strref: parseInt(s.StrRef ?? "0", 10),
    });
  }

  // [PRIMARY RULES]
  const primaryRules = parseRules(sections, "PRIMARY RULE");
  const secondaryRules = parseRules(sections, "SECONDARY RULE");

  // [TILES]
  const tileCount = parseInt(sections.get("TILES")?.Count ?? "0", 10);
  const tiles: TileDefinition[] = [];
  for (let i = 0; i < tileCount; i++) {
    const s = sections.get(`TILE${i}`) ?? {};
    const tlH = parseInt(s.TopLeftHeight ?? "0", 10);
    const trH = parseInt(s.TopRightHeight ?? "0", 10);
    const blH = parseInt(s.BottomLeftHeight ?? "0", 10);
    const brH = parseInt(s.BottomRightHeight ?? "0", 10);

    // The .set file Orientation field (degrees: 0/90/180/270) specifies the
    // rotation at which the tile's corners and crossers are defined. To normalize
    // all tiles to GIT orientation 0, we un-rotate by the .set Orientation.
    // This ensures getRotatedCorners(tile, gitOri) returns the correct effective
    // corners for any GIT placement orientation.
    const setOrientation = parseInt(s.Orientation ?? "0", 10);
    const oriSteps = Math.round(setOrientation / 90) % 4;
    let corners: TileCorners = {
      topLeft: (s.TopLeft ?? "").toLowerCase(),
      topRight: (s.TopRight ?? "").toLowerCase(),
      bottomLeft: (s.BottomLeft ?? "").toLowerCase(),
      bottomRight: (s.BottomRight ?? "").toLowerCase(),
    };
    let crossers: TileCrossers = {
      top: (s.Top ?? "").toLowerCase(),
      right: (s.Right ?? "").toLowerCase(),
      bottom: (s.Bottom ?? "").toLowerCase(),
      left: (s.Left ?? "").toLowerCase(),
    };
    if (oriSteps > 0) {
      corners = unrotateCorners(corners, oriSteps);
      crossers = unrotateCrossers(crossers, oriSteps);
    }

    tiles.push({
      id: i,
      model: s.Model ?? "",
      imageMap2D: s.ImageMap2D ?? "",
      corners,
      crossers,
      flat: tlH === 0 && trH === 0 && blH === 0 && brH === 0,
      pathNode: s.PathNode ?? "",
      doors: parseInt(s.Doors ?? "0", 10),
      doorPlacements: [],
      sounds: parseInt(s.Sounds ?? "0", 10),
      orientation: setOrientation,
      groupId: null,
      groupName: null,
    });
  }

  // Parse [TILE<id>DOOR<n>] sections → attach to tiles
  const doorSectionPattern = /^TILE(\d+)DOOR(\d+)$/i;
  for (const [sectionName, data] of sections) {
    const m = doorSectionPattern.exec(sectionName);
    if (!m) continue;
    const tileId = parseInt(m[1], 10);
    if (tileId < 0 || tileId >= tiles.length) continue;
    tiles[tileId].doorPlacements.push({
      x: parseFloat(data.X ?? "0"),
      y: parseFloat(data.Y ?? "0"),
      z: parseFloat(data.Z ?? "0"),
      orientation: parseFloat(data.Orientation ?? "0"),
      type: parseInt(data.Type ?? "0", 10),
    });
  }

  // [GROUPS]
  const groupCount = parseInt(sections.get("GROUPS")?.Count ?? "0", 10);
  const groups: TileGroup[] = [];
  for (let i = 0; i < groupCount; i++) {
    const s = sections.get(`GROUP${i}`) ?? {};
    const rows = parseInt(s.Rows ?? "1", 10);
    const columns = parseInt(s.Columns ?? "1", 10);
    const tileIds: number[] = [];
    for (let t = 0; t < rows * columns; t++) {
      tileIds.push(parseInt(s[`Tile${t}`] ?? "-1", 10));
    }
    const group: TileGroup = {
      index: i,
      name: s.Name ?? `Group${i}`,
      strref: parseInt(s.StrRef ?? "0", 10),
      rows,
      columns,
      tileIds,
    };
    groups.push(group);

    // Tag tiles with their group membership
    for (const tid of tileIds) {
      if (tid >= 0 && tid < tiles.length) {
        tiles[tid].groupId = i;
        tiles[tid].groupName = group.name;
      }
    }
  }

  return {
    resref,
    displayName: general.Name ?? resref.toUpperCase(),
    interior,
    hasHeightTransition,
    envMap: general.EnvMap ?? "",
    transition: parseInt(general.Transition ?? "0", 10),
    border: general.Border ?? "",
    defaultTerrain: (general.Default ?? terrainTypes[0]?.name ?? "").toLowerCase(),
    floor: general.Floor ?? "",
    terrainTypes,
    crosserTypes,
    primaryRules,
    secondaryRules,
    tiles,
    groups,
  };
}

function parseRules(sections: Map<string, Record<string, string>>, prefix: string): PrimaryRule[] {
  const _countSection = sections.get(`${prefix.replace(/ RULE$/, "")}${prefix.includes("PRIMARY") ? " RULES" : " RULES"}`);
  // Try both "PRIMARY RULES" and "SECONDARY RULES"
  const key = prefix.startsWith("PRIMARY") ? "PRIMARY RULES" : "SECONDARY RULES";
  const count = parseInt(sections.get(key)?.Count ?? "0", 10);
  const rules: PrimaryRule[] = [];
  for (let i = 0; i < count; i++) {
    const s = sections.get(`${prefix}${i}`) ?? {};
    rules.push({
      placed: s.Placed ?? "",
      placedHeight: parseInt(s.PlacedHeight ?? "0", 10),
      adjacent: s.Adjacent ?? "",
      adjacentHeight: parseInt(s.AdjacentHeight ?? "0", 10),
      changed: s.Changed ?? "",
      changedHeight: parseInt(s.ChangedHeight ?? "0", 10),
    });
  }
  return rules;
}

/** Parse INI-style sections from .set file content */
function parseSections(content: string): Map<string, Record<string, string>> {
  const sections = new Map<string, Record<string, string>>();
  let currentSection = "";
  let currentData: Record<string, string> = {};

  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith(";")) continue;

    if (line.startsWith("[") && line.endsWith("]")) {
      if (currentSection) {
        sections.set(currentSection, currentData);
      }
      currentSection = line.slice(1, -1);
      currentData = {};
    } else {
      const eqIdx = line.indexOf("=");
      if (eqIdx > 0) {
        const key = line.substring(0, eqIdx);
        const value = line.substring(eqIdx + 1);
        currentData[key] = value;
      }
    }
  }
  if (currentSection) {
    sections.set(currentSection, currentData);
  }

  return sections;
}

// ─── Door Placement Helpers ─────────────────────────────────────────────────

/** Forward-rotate a point by tile orientation (local→world). Same as area-data forwardRotate. */
function forwardRotateDoor(x: number, y: number, orientation: number): [number, number] {
  switch (orientation % 4) {
    case 0: return [x, y];
    case 1: return [-y, x];
    case 2: return [-x, -y];
    case 3: return [y, -x];
    default: return [x, y];
  }
}

/** Compute world-space door positions for a tile placed at (col, row) with given orientation. */
export function getTileDoorWorldPositions(
  tile: TileDefinition,
  col: number,
  row: number,
  tileOrientation: number,
): Array<{ x: number; y: number; z: number; bearing: number }> {
  return tile.doorPlacements.map((dp) => {
    const [rx, ry] = forwardRotateDoor(dp.x, dp.y, tileOrientation);
    return {
      x: col * 10 + 5 + rx,
      y: row * 10 + 5 + ry,
      z: dp.z,
      bearing: (dp.orientation + tileOrientation * 90) % 360,
    };
  });
}

// ─── Tileset Cache ──────────────────────────────────────────────────────────

const tilesetCache = new Map<string, TilesetInfo>();

/** Clear the tileset cache (call on load_module) */
export function clearTilesetCache(): void {
  tilesetCache.clear();
}

/** Get tileset info, loading from resman if needed */
export async function getTilesetInfo(
  resref: string,
  resmanOpts: ResmanOptions,
  index: ModuleIndex,
): Promise<TilesetInfo> {
  const key = resref.toLowerCase();
  const cached = tilesetCache.get(key);
  if (cached) return cached;

  // Extract .set file from resman to temp
  const destDir = path.join(index.tempDir, "tileset_cache");
  await fs.mkdir(destDir, { recursive: true });
  const setFile = `${key}.set`;
  await resmanExtract(destDir, {
    ...resmanOpts,
    files: [setFile],
  });

  const content = await fs.readFile(path.join(destDir, setFile), "utf-8");
  const info = parseTilesetFile(content, key);

  // Resolve display name from TLK if available
  const strref = parseInt(
    parseSections(content).get("GENERAL")?.DisplayName ?? "-1",
    10,
  );
  if (strref >= 0) {
    const resolved = resolveTlk(strref, index.baseTlk, index.customTlk);
    if (resolved) info.displayName = resolved;
  }

  // Resolve group display names from TLK
  for (const group of info.groups) {
    if (group.strref > 0) {
      const resolved = resolveTlk(group.strref, index.baseTlk, index.customTlk);
      if (resolved) group.name = resolved;
    }
  }

  // Resolve terrain type display names from TLK
  for (const terrain of info.terrainTypes) {
    if (terrain.strref > 0) {
      const resolved = resolveTlk(terrain.strref, index.baseTlk, index.customTlk);
      if (resolved) terrain.name = resolved;
    }
  }

  tilesetCache.set(key, info);
  return info;
}

function resolveTlk(strref: number, baseTlk: TlkTable | null, customTlk: TlkTable | null): string | null {
  // Custom TLK strrefs are >= 0x01000000
  if (strref >= 0x01000000 && customTlk) {
    return customTlk.get(strref - 0x01000000) ?? null;
  }
  return baseTlk?.get(strref) ?? null;
}

/** List all tilesets available via resman */
export async function listAllTilesets(resmanOpts: ResmanOptions): Promise<string[]> {
  const output = await resmanGrep({ ...resmanOpts, pattern: ".set" });
  return output
    .trim()
    .split("\n")
    .map(line => line.trim().split(/\s+/)[0] ?? "")
    .filter(line => line.endsWith(".set"))
    .map(line => path.basename(line, ".set").toLowerCase());
}

// ─── Tile Orientation Helpers ───────────────────────────────────────────────

/**
 * Un-rotate corners by N steps (inverse of forward rotation).
 * Used at parse time to normalize .set file corners (defined at the tile's
 * Orientation) back to GIT orientation 0.
 *
 * Unrotating by N steps = forward rotating by (4-N) steps.
 */
function unrotateCorners(c: TileCorners, steps: number): TileCorners {
  const inv = (4 - (steps % 4)) % 4;
  switch (inv) {
    case 0: return { ...c };
    case 1: return { topLeft: c.topRight, topRight: c.bottomRight, bottomRight: c.bottomLeft, bottomLeft: c.topLeft };
    case 2: return { topLeft: c.bottomRight, topRight: c.bottomLeft, bottomRight: c.topLeft, bottomLeft: c.topRight };
    case 3: return { topLeft: c.bottomLeft, topRight: c.topLeft, bottomRight: c.topRight, bottomLeft: c.bottomRight };
    default: return { ...c };
  }
}

/** Un-rotate crossers by N steps. Same inverse logic as unrotateCorners. */
function unrotateCrossers(cr: TileCrossers, steps: number): TileCrossers {
  const inv = (4 - (steps % 4)) % 4;
  switch (inv) {
    case 0: return { ...cr };
    case 1: return { top: cr.right, right: cr.bottom, bottom: cr.left, left: cr.top };
    case 2: return { top: cr.bottom, right: cr.left, bottom: cr.top, left: cr.right };
    case 3: return { top: cr.left, right: cr.top, bottom: cr.right, left: cr.bottom };
    default: return { ...cr };
  }
}

/**
 * Get the effective corners of a tile after applying orientation rotation.
 * When a tile is rotated, its corners rotate with it.
 *
 * The tile's stored corners are normalized to GIT orientation 0 at parse time
 * (un-rotated from the .set Orientation). After rotation by the GIT placement
 * orientation, the result is the corners as rendered by the engine.
 */
export function getRotatedCorners(tile: TileDefinition, orientation: number): TileCorners {
  const c = tile.corners;
  switch (orientation % 4) {
    case 0: return { ...c };
    case 1: // 90° CW: TR→TL, BR→TR, BL→BR, TL→BL
      return {
        topLeft: c.topRight,
        topRight: c.bottomRight,
        bottomRight: c.bottomLeft,
        bottomLeft: c.topLeft,
      };
    case 2: // 180°: BR→TL, BL→TR, TL→BR, TR→BL
      return {
        topLeft: c.bottomRight,
        topRight: c.bottomLeft,
        bottomRight: c.topLeft,
        bottomLeft: c.topRight,
      };
    case 3: // 270° CW: BL→TL, TL→TR, TR→BR, BR→BL
      return {
        topLeft: c.bottomLeft,
        topRight: c.topLeft,
        bottomRight: c.topRight,
        bottomLeft: c.bottomRight,
      };
    default: return { ...c };
  }
}

/**
 * Get the effective crossers of a tile after applying orientation rotation.
 */
export function getRotatedCrossers(tile: TileDefinition, orientation: number): TileCrossers {
  const cr = tile.crossers;
  switch (orientation % 4) {
    case 0: return { ...cr };
    case 1: return { top: cr.right, right: cr.bottom, bottom: cr.left, left: cr.top };       // 90° CW
    case 2: return { top: cr.bottom, right: cr.left, bottom: cr.top, left: cr.right };      // 180°
    case 3: return { top: cr.left, right: cr.top, bottom: cr.right, left: cr.bottom };      // 270° CW
    default: return { ...cr };
  }
}

/**
 * Find the group that a tile ID belongs to, if any.
 */
export function findTileGroup(tileset: TilesetInfo, tileId: number): TileGroup | null {
  for (const group of tileset.groups) {
    if (group.tileIds.includes(tileId)) return group;
  }
  return null;
}
