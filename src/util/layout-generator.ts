/**
 * Procedural area layout generator for the adventure creator pipeline.
 *
 * Generates terrain zones, crosser paths, and transition points that can be
 * passed directly to paint_terrain.  Encodes all the layout rules from SKILL.md:
 * - Perimeter encapsulation (interior=wall, exterior=trees/impassable)
 * - 30-50% walkable ratio
 * - 2-tile room separation for interiors
 * - Adjacency chain validation via computeValidPairs()
 * - Crosser type selection from available tileset crossers
 *
 * Supports style types: dungeon, cave, forest_clearing, village
 */

import type { TilesetInfo } from "./tileset.js";
import type { TerrainZone, CrosserPath } from "./zone-solver.js";
import { computeValidPairs } from "./zone-solver.js";

// ─── Public interface ────────────────────────────────────────────────────────

export interface LayoutStyle {
  type: "dungeon" | "cave" | "forest_clearing" | "village";
  rooms?: number;          // dungeon/cave: number of rooms (default 3)
  clearings?: number;      // forest_clearing: number of clearings (default 3)
  buildings?: number;      // village: number of buildings (default 4)
  corridorStyle?: "straight" | "zigzag";  // dungeon: corridor style (default "straight")
  hasWater?: boolean;      // forest_clearing: include a water zone
  hasRoad?: boolean;       // village: include a road crosser spine
}

export interface TransitionPoint {
  x: number;
  y: number;
  direction: "north" | "south" | "east" | "west";
  tileCol: number;
  tileRow: number;
}

export interface LayoutResult {
  zones: TerrainZone[];
  crossers: CrosserPath[];
  transitionPoints: TransitionPoint[];
  layoutDescription: string;
}

interface Room {
  x: number;      // tile column (left)
  y: number;      // tile row (bottom)
  w: number;      // width in tiles
  h: number;      // height in tiles
  name: string;
}

// ─── Main entry point ────────────────────────────────────────────────────────

export function generateLayout(
  tileset: TilesetInfo,
  width: number,
  height: number,
  style: LayoutStyle,
  transitionCount?: number,
  transitionDirections?: string[],
): LayoutResult {
  const validPairs = computeValidPairs(tileset);

  switch (style.type) {
    case "dungeon":
    case "cave":
      return generateInteriorLayout(tileset, width, height, style, validPairs, transitionCount, transitionDirections);
    case "forest_clearing":
      return generateExteriorClearingLayout(tileset, width, height, style, validPairs, transitionCount, transitionDirections);
    case "village":
      return generateVillageLayout(tileset, width, height, style, validPairs, transitionCount, transitionDirections);
    default:
      return generateInteriorLayout(tileset, width, height, style, validPairs, transitionCount, transitionDirections);
  }
}

// ─── Interior layout (dungeon / cave) ────────────────────────────────────────

function generateInteriorLayout(
  tileset: TilesetInfo,
  width: number,
  height: number,
  style: LayoutStyle,
  validPairs: Set<string>,
  transitionCount?: number,
  transitionDirections?: string[],
): LayoutResult {
  const roomCount = style.rooms ?? 3;
  const defaultTerrain = tileset.defaultTerrain.toLowerCase();

  // Find the floor terrain — first terrain that isn't the default (wall)
  const floorTerrain = findFloorTerrain(tileset, defaultTerrain, validPairs);
  if (!floorTerrain) {
    return { zones: [], crossers: [], transitionPoints: [], layoutDescription: "ERROR: Cannot find a floor terrain that transitions from the default wall terrain." };
  }

  // Find a corridor crosser type.  Doorway crossers require matched pairs on
  // shared edges (the arch geometry is split between adjacent tiles), so we
  // use corridor crossers which are self-contained on each tile.
  const corridorCrosser = findCrosserType(tileset, ["corridor", "doorway", "door"]);

  // BSP partition the playable area (leaving 1-tile perimeter as wall)
  const playableX = 1;
  const playableY = 1;
  const playableW = width - 2;
  const playableH = height - 2;

  const rooms = bspPartition(playableX, playableY, playableW, playableH, roomCount);

  // Build floor zones from rooms and collect floor tile set for corridor routing
  const zones: TerrainZone[] = [];
  const floorTiles = new Set<string>();
  for (const room of rooms) {
    const tiles: Array<{ x: number; y: number }> = [];
    for (let x = room.x; x < room.x + room.w; x++) {
      for (let y = room.y; y < room.y + room.h; y++) {
        tiles.push({ x, y });
        floorTiles.add(`${x},${y}`);
      }
    }
    zones.push({ terrain: floorTerrain, tiles });
  }

  // Connect adjacent rooms with corridor crossers through wall tiles.
  const crossers: CrosserPath[] = [];
  for (let i = 0; i < rooms.length - 1; i++) {
    const a = rooms[i];
    const b = rooms[i + 1];
    const corridor = connectRoomsInterior(a, b, corridorCrosser, style.corridorStyle ?? "straight", floorTiles);
    if (corridor) crossers.push(corridor);
  }

  // T-junction: add one shortcut corridor between non-adjacent rooms.
  // Where the new corridor crosses an existing corridor tile, the solver
  // merges crosser edges → 3-way or 4-way tiles (T-junction / crossroads).
  if (rooms.length >= 3) {
    let bestPair: [number, number] | null = null;
    let bestDist = Infinity;
    for (let i = 0; i < rooms.length; i++) {
      for (let j = i + 2; j < rooms.length; j++) {
        const cx = (rooms[i].x + rooms[i].w / 2) - (rooms[j].x + rooms[j].w / 2);
        const cy = (rooms[i].y + rooms[i].h / 2) - (rooms[j].y + rooms[j].h / 2);
        const dist = Math.abs(cx) + Math.abs(cy);
        if (dist < bestDist && dist < (width + height) / 2) {
          bestDist = dist;
          bestPair = [i, j];
        }
      }
    }
    if (bestPair) {
      const shortcut = connectRoomsInterior(
        rooms[bestPair[0]], rooms[bestPair[1]],
        corridorCrosser, style.corridorStyle ?? "straight", floorTiles,
      );
      if (shortcut) crossers.push(shortcut);
    }
  }

  // Compute transition points
  const transitionPoints = computeTransitions(rooms, width, height, transitionCount, transitionDirections);

  // Build description
  const roomDescs = rooms.map((r, i) => `Room ${String.fromCharCode(65 + i)} (${r.w}x${r.h} at col=${r.x},row=${r.y})`);
  const corridorDescs = crossers.map((c, i) => `Corridor ${i + 1}: ${c.type}`);
  const layoutDescription = `${roomCount}-room ${style.type}: ${roomDescs.join(", ")}. ${corridorDescs.join(", ")}.`;

  return { zones, crossers, transitionPoints, layoutDescription };
}

// ─── Exterior clearing layout ────────────────────────────────────────────────

function generateExteriorClearingLayout(
  tileset: TilesetInfo,
  width: number,
  height: number,
  style: LayoutStyle,
  validPairs: Set<string>,
  transitionCount?: number,
  transitionDirections?: string[],
): LayoutResult {
  const clearingCount = style.clearings ?? 3;
  const defaultTerrain = tileset.defaultTerrain.toLowerCase();

  // For exterior tilesets, check if the default terrain IS the walkable one.
  // If so (e.g., ttf01 where "forest" is walkable), clearings use the default
  // terrain and variety comes from features, not terrain zones.
  const clearingTerrain = findClearingTerrain(tileset, defaultTerrain, validPairs);
  const useDefaultForClearings = !clearingTerrain || clearingTerrain === defaultTerrain;

  // Find a path crosser (road, stream)
  const roadCrosser = findCrosserType(tileset, ["road", "path", "trail", "stream"]);

  // Place clearings in a grid pattern within the playable area
  const playableX = 1;
  const playableY = 1;
  const playableW = width - 2;
  const playableH = height - 2;

  const rooms = distributeRooms(playableX, playableY, playableW, playableH, clearingCount, 3, 4);

  // Build terrain zones
  const zones: TerrainZone[] = [];

  // Perimeter always needs an impassable border for exterior areas.
  // Find a suitable border terrain (cliff, rocky, mountain, etc.)
  const borderTerrain = findBorderTerrain(tileset, defaultTerrain, validPairs);

  if (borderTerrain) {
    const borderTiles: Array<{ x: number; y: number }> = [];
    for (let x = 0; x < width; x++) {
      for (let y = 0; y < height; y++) {
        if (x === 0 || x === width - 1 || y === 0 || y === height - 1) {
          borderTiles.push({ x, y });
        }
      }
    }
    zones.push({ terrain: borderTerrain, tiles: borderTiles });
  }

  if (useDefaultForClearings) {
    // Clearings use default terrain — no additional zones needed.
    // The "clearings" are logical regions for object/feature placement.
  } else {
    // Clearing zones with the walkable terrain
    for (const room of rooms) {
      const tiles: Array<{ x: number; y: number }> = [];
      for (let x = room.x; x < room.x + room.w; x++) {
        for (let y = room.y; y < room.y + room.h; y++) {
          tiles.push({ x, y });
        }
      }
      zones.push({ terrain: clearingTerrain, tiles });
    }

    // Optional water zone
    if (style.hasWater) {
      const waterTerrain = findTerrainByName(tileset, ["water", "lake", "pond"]);
      if (waterTerrain && canAdjoin(waterTerrain, clearingTerrain, validPairs)) {
        const lastRoom = rooms[rooms.length - 1];
        const waterTiles: Array<{ x: number; y: number }> = [];
        for (let x = lastRoom.x + lastRoom.w; x < Math.min(lastRoom.x + lastRoom.w + 2, width - 1); x++) {
          for (let y = lastRoom.y; y < lastRoom.y + Math.min(2, lastRoom.h); y++) {
            waterTiles.push({ x, y });
          }
        }
        if (waterTiles.length > 0) {
          zones.push({ terrain: waterTerrain, tiles: waterTiles });
        }
      }
    }
  }

  // Connect clearings with road crossers (through any tile for exteriors)
  const crossers: CrosserPath[] = [];
  if (roadCrosser) {
    for (let i = 0; i < rooms.length - 1; i++) {
      const corridor = connectRoomsExterior(rooms[i], rooms[i + 1], roadCrosser);
      if (corridor) crossers.push(corridor);
    }
  }

  const transitionPoints = computeTransitions(rooms, width, height, transitionCount, transitionDirections);

  const terrainNote = useDefaultForClearings
    ? " Default terrain used throughout (clearings are logical regions for features/objects)."
    : "";
  const roomDescs = rooms.map((r, i) => `Clearing ${i + 1} (${r.w}x${r.h} at col=${r.x},row=${r.y})`);
  const layoutDescription = `${clearingCount}-clearing exterior: ${roomDescs.join(", ")}.${terrainNote}${style.hasWater ? " Water feature included." : ""}`;

  return { zones, crossers, transitionPoints, layoutDescription };
}

// ─── Village layout ──────────────────────────────────────────────────────────

function generateVillageLayout(
  tileset: TilesetInfo,
  width: number,
  height: number,
  style: LayoutStyle,
  validPairs: Set<string>,
  transitionCount?: number,
  transitionDirections?: string[],
): LayoutResult {
  const buildingCount = style.buildings ?? 4;
  const defaultTerrain = tileset.defaultTerrain.toLowerCase();

  const clearingTerrain = findClearingTerrain(tileset, defaultTerrain, validPairs);
  const useDefaultForBuildings = !clearingTerrain || clearingTerrain === defaultTerrain;

  const roadCrosser = findCrosserType(tileset, ["road", "path", "trail"]);

  const playableX = 1;
  const playableY = 1;
  const playableW = width - 2;
  const playableH = height - 2;

  // Place buildings as small clearings along a road spine
  const rooms = distributeRooms(playableX, playableY, playableW, playableH, buildingCount, 2, 3);

  const zones: TerrainZone[] = [];

  // Perimeter border for exterior areas
  const villageBorderTerrain = findBorderTerrain(tileset, defaultTerrain, validPairs);
  if (villageBorderTerrain) {
    const borderTiles: Array<{ x: number; y: number }> = [];
    for (let x = 0; x < width; x++) {
      for (let y = 0; y < height; y++) {
        if (x === 0 || x === width - 1 || y === 0 || y === height - 1) {
          borderTiles.push({ x, y });
        }
      }
    }
    zones.push({ terrain: villageBorderTerrain, tiles: borderTiles });
  }

  if (!useDefaultForBuildings) {
    // Building clearings
    for (const room of rooms) {
      const tiles: Array<{ x: number; y: number }> = [];
      for (let x = room.x; x < room.x + room.w; x++) {
        for (let y = room.y; y < room.y + room.h; y++) {
          tiles.push({ x, y });
        }
      }
      zones.push({ terrain: clearingTerrain, tiles });
    }
  }

  // Road spine connecting buildings
  const crossers: CrosserPath[] = [];
  if (style.hasRoad !== false && roadCrosser) {
    for (let i = 0; i < rooms.length - 1; i++) {
      const corridor = connectRoomsExterior(rooms[i], rooms[i + 1], roadCrosser);
      if (corridor) crossers.push(corridor);
    }
  }

  const transitionPoints = computeTransitions(rooms, width, height, transitionCount, transitionDirections);

  const layoutDescription = `${buildingCount}-building village: ${rooms.map((r, i) => `Building ${i + 1} (${r.w}x${r.h} at col=${r.x},row=${r.y})`).join(", ")}.${roadCrosser ? " Road spine connecting buildings." : ""}`;

  return { zones, crossers, transitionPoints, layoutDescription };
}

// ─── BSP partitioning ────────────────────────────────────────────────────────

function bspPartition(x: number, y: number, w: number, h: number, targetRooms: number): Room[] {
  if (targetRooms <= 1 || (w < 10 && h < 10)) {
    // Always use 2-tile margin (4-tile gaps between rooms).
    // Interior tilesets need at least one pure-wall tile in the gap
    // for straight corridor crossers.  Boundary tiles (mixed wall/floor
    // corners) can only carry a corridor crosser on ONE edge.
    // Minimum room size 3x3 so notching at multiple corridor entrances
    // still leaves enough floor tiles (notch removes 1 tile per entrance).
    const margin = 2;
    const roomW = Math.max(3, w - margin * 2);
    const roomH = Math.max(3, h - margin * 2);
    return [{ x: x + margin, y: y + margin, w: roomW, h: roomH, name: "" }];
  }

  // Split along the longer axis
  const splitHorizontal = h > w;
  const rooms: Room[] = [];

  if (splitHorizontal) {
    // Split horizontally (creating top/bottom halves)
    const splitY = y + Math.floor(h / 2);
    const topH = splitY - y;
    const bottomH = h - topH;
    const topRooms = Math.ceil(targetRooms / 2);
    const bottomRooms = targetRooms - topRooms;
    rooms.push(...bspPartition(x, y, w, topH, bottomRooms));
    rooms.push(...bspPartition(x, splitY, w, bottomH, topRooms));
  } else {
    // Split vertically (creating left/right halves)
    const splitX = x + Math.floor(w / 2);
    const leftW = splitX - x;
    const rightW = w - leftW;
    const leftRooms = Math.ceil(targetRooms / 2);
    const rightRooms = targetRooms - leftRooms;
    rooms.push(...bspPartition(x, y, leftW, h, leftRooms));
    rooms.push(...bspPartition(splitX, y, rightW, h, rightRooms));
  }

  // Name rooms
  for (let i = 0; i < rooms.length; i++) {
    rooms[i].name = String.fromCharCode(65 + i);
  }

  return rooms;
}

// ─── Room distribution (for exteriors) ───────────────────────────────────────

function distributeRooms(
  playX: number, playY: number, playW: number, playH: number,
  count: number, minSize: number, maxSize: number,
): Room[] {
  const rooms: Room[] = [];

  // Grid-based distribution with some randomness
  const cols = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / cols);
  const cellW = Math.floor(playW / cols);
  const cellH = Math.floor(playH / rows);

  let placed = 0;
  for (let r = 0; r < rows && placed < count; r++) {
    for (let c = 0; c < cols && placed < count; c++) {
      const cellX = playX + c * cellW;
      const cellY = playY + r * cellH;

      // Room size: between minSize and maxSize, capped by cell
      const roomW = Math.min(maxSize, Math.max(minSize, cellW - 2));
      const roomH = Math.min(maxSize, Math.max(minSize, cellH - 2));

      // Center room in cell
      const roomX = cellX + Math.floor((cellW - roomW) / 2);
      const roomY = cellY + Math.floor((cellH - roomH) / 2);

      rooms.push({ x: roomX, y: roomY, w: roomW, h: roomH, name: String.fromCharCode(65 + placed) });
      placed++;
    }
  }

  return rooms;
}

// ─── Floor neck between rooms (interior) ─────────────────────────────────────

/**
 * Build a 1-tile-wide floor path ("neck") connecting two rooms through the
 * wall gap.  The neck goes from room A's edge to room B's edge in a straight
 * line (or L-shape if rooms don't share an axis).  Only wall tiles are added.
 */
function buildFloorNeck(
  a: Room, b: Room,
  floorTiles: Set<string>,
  areaWidth: number, areaHeight: number,
): Array<{ x: number; y: number }> {
  const aCenterX = a.x + Math.floor(a.w / 2);
  const aCenterY = a.y + Math.floor(a.h / 2);
  const bCenterX = b.x + Math.floor(b.w / 2);
  const bCenterY = b.y + Math.floor(b.h / 2);

  const fullPath: Array<{ x: number; y: number }> = [];
  const dx = Math.abs(bCenterX - aCenterX);
  const dy = Math.abs(bCenterY - aCenterY);

  if (dx >= dy) {
    // Horizontal path
    const startX = Math.min(aCenterX, bCenterX);
    const endX = Math.max(aCenterX, bCenterX);
    for (let x = startX; x <= endX; x++) fullPath.push({ x, y: aCenterY });
    // Vertical segment if needed
    const startY = Math.min(aCenterY, bCenterY);
    const endY = Math.max(aCenterY, bCenterY);
    for (let y = startY; y <= endY; y++) {
      if (y !== aCenterY) fullPath.push({ x: bCenterX, y });
    }
  } else {
    // Vertical path
    const startY = Math.min(aCenterY, bCenterY);
    const endY = Math.max(aCenterY, bCenterY);
    for (let y = startY; y <= endY; y++) fullPath.push({ x: aCenterX, y });
    // Horizontal segment if needed
    const startX = Math.min(aCenterX, bCenterX);
    const endX = Math.max(aCenterX, bCenterX);
    for (let x = startX; x <= endX; x++) {
      if (x !== aCenterX) fullPath.push({ x, y: bCenterY });
    }
  }

  // Only return tiles that aren't already floor and are within bounds
  return fullPath.filter(p =>
    p.x >= 0 && p.x < areaWidth && p.y >= 0 && p.y < areaHeight &&
    !floorTiles.has(`${p.x},${p.y}`)
  );
}

// ─── Room connection (interior — wall tiles only) ────────────────────────────

/**
 * Connect two rooms with a corridor that only passes through wall tiles.
 * The corridor exits room A at its edge, traverses the wall gap, and enters
 * room B at its edge.  Only tiles NOT in floorTiles get crosser entries.
 *
 * Routing uses axis overlap detection: if rooms share a Y range, connect
 * horizontally at the shared Y; if they share an X range, connect vertically.
 * Falls back to L-shaped routing when rooms don't overlap on either axis.
 */
function connectRoomsInterior(
  a: Room, b: Room,
  crosserType: string | null,
  corridorStyle: string,
  floorTiles: Set<string>,
): CrosserPath | null {
  if (!crosserType) return null;

  // Room extents (inclusive tile ranges)
  const aRight = a.x + a.w - 1;
  const aTop = a.y + a.h - 1;
  const bRight = b.x + b.w - 1;
  const bTop = b.y + b.h - 1;

  // Check axis overlaps — rooms that share a range can be connected straight
  const yOverlapMin = Math.max(a.y, b.y);
  const yOverlapMax = Math.min(aTop, bTop);
  const hasYOverlap = yOverlapMin <= yOverlapMax;

  const xOverlapMin = Math.max(a.x, b.x);
  const xOverlapMax = Math.min(aRight, bRight);
  const hasXOverlap = xOverlapMin <= xOverlapMax;

  const fullPath: Array<{ x: number; y: number }> = [];

  if (hasYOverlap) {
    // Horizontal connection at shared Y
    const sharedY = Math.floor((yOverlapMin + yOverlapMax) / 2);
    const x0 = Math.min(aRight, bRight) === aRight ? aRight : bRight;
    const x1 = Math.max(a.x, b.x);
    const xMin = Math.min(x0, x1);
    const xMax = Math.max(x0, x1);
    const span = xMax - xMin + 1;

    // S-curve: offset middle segment by 1 tile vertically when long enough
    if (corridorStyle !== "zigzag" && span >= 5 && Math.random() < 0.5) {
      const offsetDir = Math.random() < 0.5 ? 1 : -1;
      const bendStart = xMin + Math.floor(span / 3);
      const bendEnd = xMin + Math.floor(2 * span / 3);
      for (let x = xMin; x <= xMax; x++) {
        if (x === bendStart) {
          fullPath.push({ x, y: sharedY });
          fullPath.push({ x, y: sharedY + offsetDir });
        } else if (x > bendStart && x < bendEnd) {
          fullPath.push({ x, y: sharedY + offsetDir });
        } else if (x === bendEnd) {
          fullPath.push({ x, y: sharedY + offsetDir });
          fullPath.push({ x, y: sharedY });
        } else {
          fullPath.push({ x, y: sharedY });
        }
      }
    } else {
      for (let x = xMin; x <= xMax; x++) fullPath.push({ x, y: sharedY });
    }
  } else if (hasXOverlap) {
    // Vertical connection at shared X
    const sharedX = Math.floor((xOverlapMin + xOverlapMax) / 2);
    const y0 = Math.min(aTop, bTop);
    const y1 = Math.max(a.y, b.y);
    const yMin = Math.min(y0, y1);
    const yMax = Math.max(y0, y1);
    const span = yMax - yMin + 1;

    // S-curve: offset middle segment by 1 tile horizontally when long enough
    if (corridorStyle !== "zigzag" && span >= 5 && Math.random() < 0.5) {
      const offsetDir = Math.random() < 0.5 ? 1 : -1;
      const bendStart = yMin + Math.floor(span / 3);
      const bendEnd = yMin + Math.floor(2 * span / 3);
      for (let y = yMin; y <= yMax; y++) {
        if (y === bendStart) {
          fullPath.push({ x: sharedX, y });
          fullPath.push({ x: sharedX + offsetDir, y });
        } else if (y > bendStart && y < bendEnd) {
          fullPath.push({ x: sharedX + offsetDir, y });
        } else if (y === bendEnd) {
          fullPath.push({ x: sharedX + offsetDir, y });
          fullPath.push({ x: sharedX, y });
        } else {
          fullPath.push({ x: sharedX, y });
        }
      }
    } else {
      for (let y = yMin; y <= yMax; y++) fullPath.push({ x: sharedX, y });
    }
  } else {
    // L-shaped path: horizontal then vertical (or vice versa)
    const aCenterX = a.x + Math.floor(a.w / 2);
    const aCenterY = a.y + Math.floor(a.h / 2);
    const bCenterX = b.x + Math.floor(b.w / 2);
    const bCenterY = b.y + Math.floor(b.h / 2);

    if (corridorStyle === "zigzag") {
      // Vertical first, then horizontal
      const startY = Math.min(aCenterY, bCenterY);
      const endY = Math.max(aCenterY, bCenterY);
      for (let y = startY; y <= endY; y++) fullPath.push({ x: aCenterX, y });
      const startX = Math.min(aCenterX, bCenterX);
      const endX = Math.max(aCenterX, bCenterX);
      for (let x = startX; x <= endX; x++) {
        if (x !== aCenterX) fullPath.push({ x, y: bCenterY });
      }
    } else {
      // Horizontal first, then vertical
      const startX = Math.min(aCenterX, bCenterX);
      const endX = Math.max(aCenterX, bCenterX);
      for (let x = startX; x <= endX; x++) fullPath.push({ x, y: aCenterY });
      const startY = Math.min(aCenterY, bCenterY);
      const endY = Math.max(aCenterY, bCenterY);
      for (let y = startY; y <= endY; y++) {
        if (y !== aCenterY) fullPath.push({ x: bCenterX, y });
      }
    }
  }

  // Filter to only wall tiles (tiles NOT in any floor zone)
  const wallOnly = fullPath.filter(p => !floorTiles.has(`${p.x},${p.y}`));
  if (wallOnly.length === 0) return null;

  // Build crosser path with edge flags pointing toward neighbors in the FULL
  // path (including room tiles).  At L-bends, a tile needs crosser edges for
  // BOTH incoming (prev) and outgoing (next) directions.  First/last tiles
  // get edges toward their adjacent rooms for proper archway transitions.
  const path: CrosserPath["path"] = wallOnly.map((p) => {
    const fullIdx = fullPath.findIndex(fp => fp.x === p.x && fp.y === p.y);
    const prev = fullIdx > 0 ? fullPath[fullIdx - 1] : null;
    const next = fullIdx < fullPath.length - 1 ? fullPath[fullIdx + 1] : null;
    return {
      x: p.x, y: p.y,
      edges: {
        left:   (prev !== null && prev.x < p.x) || (next !== null && next.x < p.x) ? true : undefined,
        right:  (prev !== null && prev.x > p.x) || (next !== null && next.x > p.x) ? true : undefined,
        bottom: (prev !== null && prev.y < p.y) || (next !== null && next.y < p.y) ? true : undefined,
        top:    (prev !== null && prev.y > p.y) || (next !== null && next.y > p.y) ? true : undefined,
      },
    };
  });

  return { type: crosserType, path };
}

// ─── Room connection (exterior — through any tile) ───────────────────────────

function connectRoomsExterior(a: Room, b: Room, crosserType: string | null): CrosserPath | null {
  if (!crosserType) return null;

  const aCenterX = a.x + Math.floor(a.w / 2);
  const aCenterY = a.y + Math.floor(a.h / 2);
  const bCenterX = b.x + Math.floor(b.w / 2);
  const bCenterY = b.y + Math.floor(b.h / 2);

  const path: CrosserPath["path"] = [];
  const dx = Math.abs(bCenterX - aCenterX);
  const dy = Math.abs(bCenterY - aCenterY);

  if (dx >= dy) {
    const startX = Math.min(aCenterX, bCenterX);
    const endX = Math.max(aCenterX, bCenterX);
    const y = aCenterY;
    for (let x = startX; x <= endX; x++) {
      path.push({ x, y, edges: { left: x > startX, right: x < endX } });
    }
  } else {
    const startY = Math.min(aCenterY, bCenterY);
    const endY = Math.max(aCenterY, bCenterY);
    const x = aCenterX;
    for (let y = startY; y <= endY; y++) {
      path.push({ x, y, edges: { bottom: y > startY, top: y < endY } });
    }
  }

  return { type: crosserType, path };
}

// ─── Transition point computation ────────────────────────────────────────────

function computeTransitions(
  rooms: Room[],
  width: number,
  height: number,
  transitionCount?: number,
  transitionDirections?: string[],
): TransitionPoint[] {
  const count = transitionCount ?? 1;
  const directions = transitionDirections?.map(d => d.toLowerCase()) ??
    ["south", "north", "east", "west"].slice(0, count);

  const points: TransitionPoint[] = [];

  for (const dir of directions) {
    if (points.length >= count) break;

    // Find the room closest to the requested edge
    let bestRoom = rooms[0];
    let bestDist = Infinity;

    for (const room of rooms) {
      const cx = room.x + room.w / 2;
      const cy = room.y + room.h / 2;
      let dist: number;
      switch (dir) {
        case "north": dist = height - cy; break;
        case "south": dist = cy; break;
        case "east":  dist = width - cx; break;
        case "west":  dist = cx; break;
        default:      dist = Infinity;
      }
      if (dist < bestDist) { bestDist = dist; bestRoom = room; }
    }

    // Place transition at the edge of the closest room, facing the direction
    let tileCol: number, tileRow: number;
    switch (dir) {
      case "north":
        tileCol = bestRoom.x + Math.floor(bestRoom.w / 2);
        tileRow = bestRoom.y + bestRoom.h - 1;
        break;
      case "south":
        tileCol = bestRoom.x + Math.floor(bestRoom.w / 2);
        tileRow = bestRoom.y;
        break;
      case "east":
        tileCol = bestRoom.x + bestRoom.w - 1;
        tileRow = bestRoom.y + Math.floor(bestRoom.h / 2);
        break;
      case "west":
        tileCol = bestRoom.x;
        tileRow = bestRoom.y + Math.floor(bestRoom.h / 2);
        break;
      default:
        continue;
    }

    points.push({
      x: tileCol * 10 + 5,
      y: tileRow * 10 + 5,
      direction: dir as TransitionPoint["direction"],
      tileCol,
      tileRow,
    });
  }

  return points;
}

// ─── Tileset terrain helpers ─────────────────────────────────────────────────

function findFloorTerrain(tileset: TilesetInfo, defaultTerrain: string, validPairs: Set<string>): string | null {
  // Look for common floor terrain names that can transition from the default
  const candidates = ["floor", "stone", "dirt", "sand", "grass", "wood"];
  for (const name of candidates) {
    const terrain = tileset.terrainTypes.find(t => t.name.toLowerCase().includes(name));
    if (terrain && canAdjoin(terrain.name.toLowerCase(), defaultTerrain, validPairs)) {
      return terrain.name.toLowerCase();
    }
  }
  // Fallback: any terrain that can transition from default
  for (const terrain of tileset.terrainTypes) {
    const name = terrain.name.toLowerCase();
    if (name !== defaultTerrain && canAdjoin(name, defaultTerrain, validPairs)) {
      return name;
    }
  }
  return null;
}

/** Terrain names that are never suitable as walkable clearings */
const IMPASSABLE_TERRAINS = new Set(["cliff", "pit", "chasm", "wall", "lava", "water", "rocky", "mountain"]);

function findClearingTerrain(tileset: TilesetInfo, defaultTerrain: string, validPairs: Set<string>): string | null {
  const candidates = ["grass", "dirt", "sand", "clearing", "floor", "stone"];
  for (const name of candidates) {
    const terrain = tileset.terrainTypes.find(t => t.name.toLowerCase().includes(name));
    if (terrain && !IMPASSABLE_TERRAINS.has(terrain.name.toLowerCase()) && canAdjoin(terrain.name.toLowerCase(), defaultTerrain, validPairs)) {
      return terrain.name.toLowerCase();
    }
  }
  for (const terrain of tileset.terrainTypes) {
    const name = terrain.name.toLowerCase();
    if (name !== defaultTerrain && !IMPASSABLE_TERRAINS.has(name) && canAdjoin(name, defaultTerrain, validPairs)) {
      return name;
    }
  }
  return null;
}

function findTerrainByName(tileset: TilesetInfo, keywords: string[]): string | null {
  for (const kw of keywords) {
    const terrain = tileset.terrainTypes.find(t => t.name.toLowerCase().includes(kw));
    if (terrain) return terrain.name.toLowerCase();
  }
  return null;
}

function findCrosserType(tileset: TilesetInfo, keywords: string[]): string | null {
  for (const kw of keywords) {
    const crosser = tileset.crosserTypes.find(c => c.name.toLowerCase().includes(kw));
    if (crosser) return crosser.name.toLowerCase();
  }
  // Fallback: first available crosser
  return tileset.crosserTypes.length > 0 ? tileset.crosserTypes[0].name.toLowerCase() : null;
}

/** Find an impassable border terrain for exterior area perimeters */
function findBorderTerrain(tileset: TilesetInfo, defaultTerrain: string, validPairs: Set<string>): string | null {
  // Prefer cliff, rocky, mountain — anything impassable that transitions from the default
  const candidates = ["cliff", "rocky", "mountain", "wall"];
  for (const name of candidates) {
    const terrain = tileset.terrainTypes.find(t => t.name.toLowerCase().includes(name));
    if (terrain && terrain.name.toLowerCase() !== defaultTerrain && canAdjoin(terrain.name.toLowerCase(), defaultTerrain, validPairs)) {
      return terrain.name.toLowerCase();
    }
  }
  // Fallback: any impassable terrain that transitions from default
  for (const terrain of tileset.terrainTypes) {
    const name = terrain.name.toLowerCase();
    if (name !== defaultTerrain && IMPASSABLE_TERRAINS.has(name) && canAdjoin(name, defaultTerrain, validPairs)) {
      return name;
    }
  }
  return null;
}

function canAdjoin(terrainA: string, terrainB: string, validPairs: Set<string>): boolean {
  return terrainA === terrainB || validPairs.has(`${terrainA}|${terrainB}`);
}
