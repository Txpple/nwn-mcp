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
 * Supports style types: dungeon, cave, dwelling, forest_clearing, village
 */

import type { TilesetInfo } from "./tileset.js";
import type { TerrainZone, CrosserPath } from "./zone-solver.js";
import { computeValidPairs } from "./zone-solver.js";

// ─── Public interface ────────────────────────────────────────────────────────

export interface LayoutStyle {
  type: "dungeon" | "cave" | "dwelling"
      | "forest" | "rural" | "city" | "plains" | "desert" | "castle" | "tundra";
  rooms?: number;          // dungeon/cave/dwelling: number of rooms (default 3)
  clearings?: number;      // exterior: number of clearings (default from preset)
  corridorStyle?: "straight" | "zigzag";  // dungeon: corridor style (default "straight")
  roadStyle?: "spine" | "grid" | "winding";  // exterior: road network style
}

export interface TransitionPoint {
  x: number;
  y: number;
  direction: "north" | "south" | "east" | "west";
  tileCol: number;
  tileRow: number;
}

export interface SuggestedFeature {
  feature: string;       // group name from tileset
  x: number;             // grid column (bottom-left)
  y: number;             // grid row (bottom-left)
  columns: number;       // width in tiles
  rows: number;          // height in tiles
  clearingIndex: number; // which clearing/room this belongs to
}

export interface LayoutResult {
  zones: TerrainZone[];
  crossers: CrosserPath[];
  transitionPoints: TransitionPoint[];
  suggestedFeatures: SuggestedFeature[];
  layoutDescription: string;
}

interface Room {
  x: number;      // tile column (left)
  y: number;      // tile row (bottom)
  w: number;      // width in tiles
  h: number;      // height in tiles
  name: string;
}

// ─── Interior style configuration ───────────────────────────────────────────

interface InteriorStyleConfig {
  splitVariance: number;           // 0.0-0.25: how far BSP split deviates from midpoint
  marginRange: [number, number];   // [min, max] margin in tiles between room edge and leaf edge (min >= 2)
  roomSizeRange: [number, number]; // [min, max] fraction of available leaf space to fill with room
  splitThreshold: number;          // minimum leaf dimension before stopping BSP split
  shortcutCount: number;           // number of shortcut corridors to attempt (T-junctions)
  sCurveChance: number;            // probability of S-curve on eligible straight corridors
  nonRectChance: number;           // probability of merging adjacent BSP leaves into L-shaped rooms
}

const INTERIOR_PRESETS: Record<string, InteriorStyleConfig> = {
  dungeon: {
    splitVariance: 0.15, marginRange: [2, 3], roomSizeRange: [0.6, 1.0],
    splitThreshold: 10, shortcutCount: 1, sCurveChance: 0.5, nonRectChance: 0.3,
  },
  cave: {
    splitVariance: 0.2, marginRange: [2, 4], roomSizeRange: [0.4, 0.7],
    splitThreshold: 8, shortcutCount: 3, sCurveChance: 0.7, nonRectChance: 0.1,
  },
  dwelling: {
    splitVariance: 0.05, marginRange: [2, 2], roomSizeRange: [0.85, 1.0],
    splitThreshold: 10, shortcutCount: 0, sCurveChance: 0.1, nonRectChance: 0.0,
  },
};

// ─── Exterior style configuration ───────────────────────────────────────────

interface ExteriorStyleConfig {
  borderKeywords: string[];          // search order for border terrain
  clearingKeywords: string[];        // search order for clearing terrain
  secondaryKeywords: string[];       // optional extra terrain (water, rocky)
  secondaryChance: number;           // per-clearing probability of secondary zone
  clearingSizeRange: [number, number]; // [min, max] clearing size in tiles
  clearingCountDefault: number;      // default clearing count
  roadStyle: "spine" | "grid" | "winding";
  roadKeywords: string[];            // primary crosser search
  secondaryCrosserKeywords: string[];// e.g. ["stream"] for water crossers
  secondaryCrosserChance: number;    // probability of secondary crosser network
  featureDensity: number;            // fraction of clearings getting feature suggestions
}

const EXTERIOR_PRESETS: Record<string, ExteriorStyleConfig> = {
  forest: {
    borderKeywords: ["cliff", "trees", "rocky", "mountain"],
    clearingKeywords: ["grass", "dirt", "clearing", "floor"],
    secondaryKeywords: ["water", "pond", "lake"],
    secondaryChance: 0.4,
    clearingSizeRange: [3, 5],
    clearingCountDefault: 3,
    roadStyle: "winding",
    roadKeywords: ["road", "path", "trail"],
    secondaryCrosserKeywords: ["stream", "river"],
    secondaryCrosserChance: 0.5,
    featureDensity: 0.3,
  },
  rural: {
    borderKeywords: ["trees", "cliff", "rocky", "mountain"],
    clearingKeywords: ["grass", "snow", "sand", "dirt", "clearing"],
    secondaryKeywords: ["water", "pond"],
    secondaryChance: 0.3,
    clearingSizeRange: [3, 5],
    clearingCountDefault: 4,
    roadStyle: "spine",
    roadKeywords: ["road", "path", "trail", "street"],
    secondaryCrosserKeywords: ["stream", "river"],
    secondaryCrosserChance: 0.4,
    featureDensity: 0.6,
  },
  city: {
    borderKeywords: ["building", "castle", "wall", "trees"],
    clearingKeywords: ["cobble", "stone", "floor", "grass"],
    secondaryKeywords: ["water"],
    secondaryChance: 0.2,
    clearingSizeRange: [3, 5],
    clearingCountDefault: 5,
    roadStyle: "grid",
    roadKeywords: ["road", "street", "path"],
    secondaryCrosserKeywords: ["stream", "dock"],
    secondaryCrosserChance: 0.2,
    featureDensity: 0.8,
  },
  plains: {
    borderKeywords: ["cliff", "mountain", "rocky", "trees"],
    clearingKeywords: ["grass", "sand", "dirt"],
    secondaryKeywords: ["water", "chasm"],
    secondaryChance: 0.3,
    clearingSizeRange: [3, 5],
    clearingCountDefault: 3,
    roadStyle: "spine",
    roadKeywords: ["road", "path", "trail", "ridge"],
    secondaryCrosserKeywords: ["stream", "river"],
    secondaryCrosserChance: 0.3,
    featureDensity: 0.4,
  },
  desert: {
    borderKeywords: ["cliff", "rocky", "mountain"],
    clearingKeywords: ["desert", "sand", "dirt"],
    secondaryKeywords: ["water", "oasis"],
    secondaryChance: 0.2,
    clearingSizeRange: [3, 4],
    clearingCountDefault: 3,
    roadStyle: "spine",
    roadKeywords: ["road", "trench", "path"],
    secondaryCrosserKeywords: [],
    secondaryCrosserChance: 0,
    featureDensity: 0.3,
  },
  castle: {
    borderKeywords: ["castlewall", "cliff", "wall", "trees"],
    clearingKeywords: ["grass", "dirt", "cobble"],
    secondaryKeywords: ["water"],
    secondaryChance: 0.2,
    clearingSizeRange: [3, 5],
    clearingCountDefault: 3,
    roadStyle: "spine",
    roadKeywords: ["road", "path", "lists"],
    secondaryCrosserKeywords: ["river", "stream"],
    secondaryCrosserChance: 0.2,
    featureDensity: 0.5,
  },
  tundra: {
    borderKeywords: ["trees", "cliff", "rocky", "mountain"],
    clearingKeywords: ["snow", "camp", "dirt", "floor"],
    secondaryKeywords: ["water"],
    secondaryChance: 0.15,
    clearingSizeRange: [3, 4],
    clearingCountDefault: 3,
    roadStyle: "spine",
    roadKeywords: ["road", "path", "trail"],
    secondaryCrosserKeywords: ["stream"],
    secondaryCrosserChance: 0.2,
    featureDensity: 0.3,
  },
};

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
    case "dwelling":
      return generateInteriorLayout(tileset, width, height, style, validPairs, transitionCount, transitionDirections);
    case "forest":
    case "rural":
    case "city":
    case "plains":
    case "desert":
    case "castle":
    case "tundra":
      return generateExteriorLayout(tileset, width, height, style, validPairs, transitionCount, transitionDirections);
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
  const config = INTERIOR_PRESETS[style.type] ?? INTERIOR_PRESETS.dungeon;

  // Find the floor terrain — first terrain that isn't the default (wall)
  const floorTerrain = findFloorTerrain(tileset, defaultTerrain, validPairs);
  if (!floorTerrain) {
    return { zones: [], crossers: [], transitionPoints: [], suggestedFeatures: [], layoutDescription: "ERROR: Cannot find a floor terrain that transitions from the default wall terrain." };
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

  const rooms = bspPartition(playableX, playableY, playableW, playableH, roomCount, config);

  // Attempt L-shape merging: adjacent BSP rooms may combine into one zone
  const roomGroups = attemptLShapeMerge(rooms, config);

  // Build floor zones from room groups and collect floor tile set for corridor routing
  const zones: TerrainZone[] = [];
  const floorTiles = new Set<string>();
  for (const group of roomGroups) {
    const tiles: Array<{ x: number; y: number }> = [];
    for (const room of group) {
      for (let x = room.x; x < room.x + room.w; x++) {
        for (let y = room.y; y < room.y + room.h; y++) {
          tiles.push({ x, y });
          floorTiles.add(`${x},${y}`);
        }
      }
    }
    zones.push({ terrain: floorTerrain, tiles });
  }

  // Connect adjacent room groups with corridor crossers through wall tiles.
  // For L-shaped groups, pick the sub-room closest to the target group.
  const crossers: CrosserPath[] = [];
  const corridorStyleStr = style.corridorStyle ?? "straight";
  for (let i = 0; i < roomGroups.length - 1; i++) {
    const aRoom = pickClosestSubRoom(roomGroups[i], roomGroups[i + 1]);
    const bRoom = pickClosestSubRoom(roomGroups[i + 1], roomGroups[i]);
    const corridor = connectRoomsInterior(aRoom, bRoom, corridorCrosser, corridorStyleStr, floorTiles, config.sCurveChance);
    if (corridor) crossers.push(corridor);
  }

  // Shortcut corridors: create T-junctions / crossroads by connecting
  // non-adjacent rooms.  Count controlled by style config.
  if (rooms.length >= 3 && config.shortcutCount > 0) {
    const candidates: Array<{ i: number; j: number; dist: number }> = [];
    for (let i = 0; i < rooms.length; i++) {
      for (let j = i + 2; j < rooms.length; j++) {
        const cx = (rooms[i].x + rooms[i].w / 2) - (rooms[j].x + rooms[j].w / 2);
        const cy = (rooms[i].y + rooms[i].h / 2) - (rooms[j].y + rooms[j].h / 2);
        const dist = Math.abs(cx) + Math.abs(cy);
        if (dist < (width + height) / 2) candidates.push({ i, j, dist });
      }
    }
    candidates.sort((a, b) => a.dist - b.dist);
    const usedBoth = new Set<string>();
    let added = 0;
    for (const cand of candidates) {
      if (added >= config.shortcutCount) break;
      const key = `${cand.i},${cand.j}`;
      if (usedBoth.has(key)) continue;
      const shortcut = connectRoomsInterior(
        rooms[cand.i], rooms[cand.j],
        corridorCrosser, corridorStyleStr, floorTiles, config.sCurveChance,
      );
      if (shortcut) {
        crossers.push(shortcut);
        usedBoth.add(key);
        added++;
      }
    }
  }

  // Compute transition points
  const transitionPoints = computeTransitions(rooms, width, height, transitionCount, transitionDirections);

  // Build description
  const roomDescs = rooms.map((r, i) => `Room ${String.fromCharCode(65 + i)} (${r.w}x${r.h} at col=${r.x},row=${r.y})`);
  const corridorDescs = crossers.map((c, i) => `Corridor ${i + 1}: ${c.type}`);
  const layoutDescription = `${roomCount}-room ${style.type}: ${roomDescs.join(", ")}. ${corridorDescs.join(", ")}.`;

  return { zones, crossers, transitionPoints, suggestedFeatures: [], layoutDescription };
}

// ─── Exterior layout (all outdoor styles) ────────────────────────────────────

function generateExteriorLayout(
  tileset: TilesetInfo,
  width: number,
  height: number,
  style: LayoutStyle,
  validPairs: Set<string>,
  transitionCount?: number,
  transitionDirections?: string[],
): LayoutResult {
  const config = EXTERIOR_PRESETS[style.type] ?? EXTERIOR_PRESETS.forest;
  const defaultTerrain = tileset.defaultTerrain.toLowerCase();
  const clearingCount = style.clearings ?? config.clearingCountDefault;
  const roadStyleOverride = style.roadStyle ?? config.roadStyle;

  // Resolve terrains from config keywords
  const clearingTerrain = findClearingTerrain(tileset, defaultTerrain, validPairs);
  const useDefaultForClearings = !clearingTerrain || clearingTerrain === defaultTerrain;
  const borderTerrain = findBorderTerrain(tileset, defaultTerrain, validPairs, config.borderKeywords);
  const roadCrosser = findCrosserType(tileset, config.roadKeywords);

  // Distribute clearings with randomized sizes
  const playableX = 1, playableY = 1;
  const playableW = width - 2, playableH = height - 2;
  const rooms = distributeRooms(playableX, playableY, playableW, playableH,
    clearingCount, config.clearingSizeRange);

  const zones: TerrainZone[] = [];

  // Perimeter border
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

  if (!useDefaultForClearings) {
    // Clearing zones
    for (const room of rooms) {
      const tiles: Array<{ x: number; y: number }> = [];
      for (let x = room.x; x < room.x + room.w; x++) {
        for (let y = room.y; y < room.y + room.h; y++) {
          tiles.push({ x, y });
        }
      }
      zones.push({ terrain: clearingTerrain, tiles });
    }

    // Secondary terrain patches (water, rocky) — per-clearing probability
    const secondaryTerrain = findTerrainByName(tileset, config.secondaryKeywords);
    const adjTarget = clearingTerrain ?? defaultTerrain;
    if (secondaryTerrain && canAdjoin(secondaryTerrain, adjTarget, validPairs)) {
      for (const room of rooms) {
        if (Math.random() >= config.secondaryChance) continue;
        // Place 2x2 patch adjacent to one edge of the clearing
        const side = Math.floor(Math.random() * 4); // 0=right, 1=top, 2=left, 3=bottom
        let sx: number, sy: number, sw = 2, sh = 2;
        switch (side) {
          case 0: sx = room.x + room.w; sy = room.y; break;
          case 1: sx = room.x; sy = room.y + room.h; break;
          case 2: sx = room.x - 2; sy = room.y; break;
          default: sx = room.x; sy = room.y - 2; break;
        }
        // Clamp to playable area (avoid perimeter)
        sx = Math.max(1, Math.min(sx, width - 3));
        sy = Math.max(1, Math.min(sy, height - 3));
        sw = Math.min(sw, width - 1 - sx);
        sh = Math.min(sh, height - 1 - sy);
        if (sw >= 1 && sh >= 1) {
          const tiles: Array<{ x: number; y: number }> = [];
          for (let x = sx; x < sx + sw; x++) {
            for (let y = sy; y < sy + sh; y++) {
              tiles.push({ x, y });
            }
          }
          zones.push({ terrain: secondaryTerrain, tiles });
        }
      }
    }
  }

  // Road network
  const crossers: CrosserPath[] = [];
  if (roadCrosser) {
    buildRoadNetwork(rooms, roadCrosser, roadStyleOverride, crossers);
  }

  // Secondary crosser network (stream/river)
  if (config.secondaryCrosserKeywords.length > 0 && Math.random() < config.secondaryCrosserChance) {
    const streamCrosser = findCrosserType(tileset, config.secondaryCrosserKeywords);
    if (streamCrosser && streamCrosser !== roadCrosser && rooms.length >= 2) {
      const stream = connectRoomsExteriorWinding(rooms[0], rooms[rooms.length - 1], streamCrosser, 2);
      if (stream) crossers.push(stream);
    }
  }

  // Feature suggestions
  const suggestedFeatures = suggestFeatures(rooms, tileset, config, crossers, width, height);

  const transitionPoints = computeTransitions(rooms, width, height, transitionCount, transitionDirections);

  const roomDescs = rooms.map((r, i) => `Clearing ${i + 1} (${r.w}x${r.h} at col=${r.x},row=${r.y})`);
  const crosserDescs = crossers.length > 0 ? ` ${crossers.length} crosser paths.` : "";
  const featureDescs = suggestedFeatures.length > 0 ? ` ${suggestedFeatures.length} feature suggestions.` : "";
  const layoutDescription = `${clearingCount}-clearing ${style.type}: ${roomDescs.join(", ")}.${crosserDescs}${featureDescs}`;

  return { zones, crossers, transitionPoints, suggestedFeatures, layoutDescription };
}

// ─── BSP partitioning ────────────────────────────────────────────────────────

function bspPartition(x: number, y: number, w: number, h: number,
                      targetRooms: number, config: InteriorStyleConfig): Room[] {
  // Minimum leaf size for a viable room: margin(2) + room(3) = 5.
  // Can't split if either dimension < 2*minLeaf (both children need minLeaf).
  const minLeaf = 5;
  const canSplitH = h >= minLeaf * 2;
  const canSplitW = w >= minLeaf * 2;

  if (targetRooms <= 1 || (!canSplitH && !canSplitW)) {
    // Base case: place a single room in this leaf.
    const [minM, maxM] = config.marginRange;
    const margin = Math.max(2, minM + Math.floor(Math.random() * (maxM - minM + 1)));
    // Room size: fraction of available space, clamped to fit within leaf.
    const availW = Math.max(3, w - margin * 2);
    const availH = Math.max(3, h - margin * 2);
    const sizeFrac = config.roomSizeRange[0] +
      Math.random() * (config.roomSizeRange[1] - config.roomSizeRange[0]);
    const roomW = Math.max(3, Math.min(availW, Math.round(availW * sizeFrac)));
    const roomH = Math.max(3, Math.min(availH, Math.round(availH * sizeFrac)));
    // Offset within available space, then clamp so room stays inside leaf
    const slackW = Math.max(0, availW - roomW);
    const slackH = Math.max(0, availH - roomH);
    const offsetX = slackW > 0 ? Math.floor(Math.random() * (slackW + 1)) : 0;
    const offsetY = slackH > 0 ? Math.floor(Math.random() * (slackH + 1)) : 0;
    const rx = x + Math.min(margin + offsetX, Math.max(0, w - roomW));
    const ry = y + Math.min(margin + offsetY, Math.max(0, h - roomH));
    return [{ x: rx, y: ry, w: Math.min(roomW, w - (rx - x)), h: Math.min(roomH, h - (ry - y)), name: "" }];
  }

  // Split along the longer splittable axis with randomized split point.
  const splitHorizontal = canSplitH && (!canSplitW || h > w);
  const rooms: Room[] = [];

  if (splitHorizontal) {
    const mid = Math.floor(h / 2);
    const vr = Math.floor(h * config.splitVariance);
    const offset = vr > 0 ? Math.floor(Math.random() * (vr * 2 + 1)) - vr : 0;
    const splitAt = Math.max(minLeaf, Math.min(h - minLeaf, mid + offset));
    const topRooms = Math.ceil(targetRooms / 2);
    const bottomRooms = targetRooms - topRooms;
    rooms.push(...bspPartition(x, y, w, splitAt, bottomRooms, config));
    rooms.push(...bspPartition(x, y + splitAt, w, h - splitAt, topRooms, config));
  } else {
    const mid = Math.floor(w / 2);
    const vr = Math.floor(w * config.splitVariance);
    const offset = vr > 0 ? Math.floor(Math.random() * (vr * 2 + 1)) - vr : 0;
    const splitAt = Math.max(minLeaf, Math.min(w - minLeaf, mid + offset));
    const leftRooms = Math.ceil(targetRooms / 2);
    const rightRooms = targetRooms - leftRooms;
    rooms.push(...bspPartition(x, y, splitAt, h, leftRooms, config));
    rooms.push(...bspPartition(x + splitAt, y, w - splitAt, h, rightRooms, config));
  }

  for (let i = 0; i < rooms.length; i++) {
    rooms[i].name = String.fromCharCode(65 + i);
  }

  return rooms;
}

// ─── Room distribution (for exteriors) ───────────────────────────────────────

function distributeRooms(
  playX: number, playY: number, playW: number, playH: number,
  count: number, sizeRange: [number, number],
): Room[] {
  const rooms: Room[] = [];
  const [minSize, maxSize] = sizeRange;

  const cols = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / cols);
  const cellW = Math.floor(playW / cols);
  const cellH = Math.floor(playH / rows);

  let placed = 0;
  for (let r = 0; r < rows && placed < count; r++) {
    for (let c = 0; c < cols && placed < count; c++) {
      const cellX = playX + c * cellW;
      const cellY = playY + r * cellH;

      // Randomize size within range, capped by cell
      const roomW = Math.min(Math.max(minSize, cellW - 2), minSize + Math.floor(Math.random() * (maxSize - minSize + 1)));
      const roomH = Math.min(Math.max(minSize, cellH - 2), minSize + Math.floor(Math.random() * (maxSize - minSize + 1)));

      // Random offset within cell (jitter, not always centered)
      const slackW = Math.max(0, cellW - roomW);
      const slackH = Math.max(0, cellH - roomH);
      const offsetX = slackW > 0 ? Math.floor(Math.random() * slackW) : 0;
      const offsetY = slackH > 0 ? Math.floor(Math.random() * slackH) : 0;

      rooms.push({ x: cellX + offsetX, y: cellY + offsetY, w: roomW, h: roomH, name: String.fromCharCode(65 + placed) });
      placed++;
    }
  }

  return rooms;
}

// ─── L-shape room merging ────────────────────────────────────────────────────

/** Check if two rooms are adjacent (share axis range, separated by wall gap 2-8 tiles) */
function areAdjacentRooms(a: Room, b: Room): boolean {
  const aRight = a.x + a.w, aTop = a.y + a.h;
  const bRight = b.x + b.w, bTop = b.y + b.h;
  const yOverlap = Math.min(aTop, bTop) - Math.max(a.y, b.y);
  if (yOverlap > 0) {
    const gap = Math.max(b.x - aRight, a.x - bRight);
    return gap >= 2 && gap <= 8;
  }
  const xOverlap = Math.min(aRight, bRight) - Math.max(a.x, b.x);
  if (xOverlap > 0) {
    const gap = Math.max(b.y - aTop, a.y - bTop);
    return gap >= 2 && gap <= 8;
  }
  return false;
}

/**
 * Walk sequential room pairs and with probability nonRectChance, merge
 * adjacent pairs into L-shaped groups.  Returns groups of 1 or 2 rooms.
 * Each group becomes a single zone (the solver handles arbitrary shapes).
 */
function attemptLShapeMerge(rooms: Room[], config: InteriorStyleConfig): Room[][] {
  const groups: Room[][] = [];
  const used = new Set<number>();
  for (let i = 0; i < rooms.length - 1; i++) {
    if (used.has(i)) continue;
    if (Math.random() < config.nonRectChance && !used.has(i + 1) && areAdjacentRooms(rooms[i], rooms[i + 1])) {
      groups.push([rooms[i], rooms[i + 1]]);
      used.add(i);
      used.add(i + 1);
      continue;
    }
    groups.push([rooms[i]]);
    used.add(i);
  }
  if (!used.has(rooms.length - 1)) groups.push([rooms[rooms.length - 1]]);
  return groups;
}

/** For corridor routing, pick the sub-room in a group closest to the target group's centroid */
function pickClosestSubRoom(group: Room[], towardGroup: Room[]): Room {
  const targetCx = towardGroup.reduce((s, r) => s + r.x + r.w / 2, 0) / towardGroup.length;
  const targetCy = towardGroup.reduce((s, r) => s + r.y + r.h / 2, 0) / towardGroup.length;
  let best = group[0];
  let bestDist = Infinity;
  for (const r of group) {
    const d = Math.abs(r.x + r.w / 2 - targetCx) + Math.abs(r.y + r.h / 2 - targetCy);
    if (d < bestDist) { bestDist = d; best = r; }
  }
  return best;
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
  sCurveChance = 0.5,
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

    // S-curve: offset middle segment by 1 tile vertically.
    // Bend positions are computed within the WALL segment only (xMin and xMax
    // are room floor tiles) to avoid placing L-bend crossers on boundary tiles
    // adjacent to rooms — those require impossible corner+crosser combos.
    const wallStartX = xMin + 1;
    const wallEndX = xMax - 1;
    const wallSpanX = wallEndX - wallStartX + 1;
    if (corridorStyle !== "zigzag" && wallSpanX >= 4 && Math.random() < sCurveChance) {
      const offsetDir = Math.random() < 0.5 ? 1 : -1;
      const bendStart = wallStartX + Math.max(1, Math.floor(wallSpanX / 3));
      const bendEnd = wallStartX + Math.min(wallSpanX - 2, Math.floor(2 * wallSpanX / 3));
      if (bendStart < bendEnd) {
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

    // S-curve: offset middle segment by 1 tile horizontally.
    // Same boundary-avoidance as horizontal — see comment above.
    const wallStartY = yMin + 1;
    const wallEndY = yMax - 1;
    const wallSpanY = wallEndY - wallStartY + 1;
    if (corridorStyle !== "zigzag" && wallSpanY >= 4 && Math.random() < sCurveChance) {
      const offsetDir = Math.random() < 0.5 ? 1 : -1;
      const bendStart = wallStartY + Math.max(1, Math.floor(wallSpanY / 3));
      const bendEnd = wallStartY + Math.min(wallSpanY - 2, Math.floor(2 * wallSpanY / 3));
      if (bendStart < bendEnd) {
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

// ─── Road network builder ────────────────────────────────────────────────────

function buildRoadNetwork(rooms: Room[], crosserType: string, roadStyle: string, crossers: CrosserPath[]): void {
  if (rooms.length < 2) return;

  if (roadStyle === "grid") {
    // City grid: connect horizontal and vertical neighbors
    const sorted = [...rooms].sort((a, b) => a.y !== b.y ? a.y - b.y : a.x - b.x);
    const connected = new Set<string>();
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const key = `${i},${j}`;
        if (connected.has(key)) continue;
        const a = sorted[i], b = sorted[j];
        // Connect if they're adjacent in the grid (share axis overlap)
        const xOverlap = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
        const yOverlap = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
        if (xOverlap > 0 || yOverlap > 0) {
          const path = connectRoomsExterior(a, b, crosserType);
          if (path) { crossers.push(path); connected.add(key); }
        }
      }
    }
    // Ensure all rooms connected: fallback to sequential
    if (connected.size < rooms.length - 1) {
      for (let i = 0; i < rooms.length - 1; i++) {
        const path = connectRoomsExterior(rooms[i], rooms[i + 1], crosserType);
        if (path) crossers.push(path);
      }
    }
  } else if (roadStyle === "winding") {
    // Forest winding: sequential connections with S-curves
    for (let i = 0; i < rooms.length - 1; i++) {
      const path = connectRoomsExteriorWinding(rooms[i], rooms[i + 1], crosserType, 1);
      if (path) crossers.push(path);
    }
  } else {
    // Spine: sequential straight connections
    for (let i = 0; i < rooms.length - 1; i++) {
      const path = connectRoomsExterior(rooms[i], rooms[i + 1], crosserType);
      if (path) crossers.push(path);
    }
  }
}

// ─── Exterior winding connector ─────────────────────────────────────────────

function connectRoomsExteriorWinding(a: Room, b: Room, crosserType: string, curvature: number): CrosserPath | null {
  const aCx = a.x + Math.floor(a.w / 2), aCy = a.y + Math.floor(a.h / 2);
  const bCx = b.x + Math.floor(b.w / 2), bCy = b.y + Math.floor(b.h / 2);
  const path: CrosserPath["path"] = [];
  const dx = Math.abs(bCx - aCx), dy = Math.abs(bCy - aCy);

  if (dx >= dy) {
    // Horizontal with vertical S-curve offset in middle third
    const startX = Math.min(aCx, bCx), endX = Math.max(aCx, bCx);
    const y = aCx < bCx ? aCy : bCy;
    const span = endX - startX + 1;
    const offsetDir = Math.random() < 0.5 ? curvature : -curvature;
    const bendStart = startX + Math.max(1, Math.floor(span / 3));
    const bendEnd = startX + Math.min(span - 2, Math.floor(2 * span / 3));
    for (let x = startX; x <= endX; x++) {
      const inBend = bendStart < bendEnd && x > bendStart && x < bendEnd;
      const curY = inBend ? y + offsetDir : y;
      const prevY = (x > startX && bendStart < bendEnd && x - 1 > bendStart && x - 1 < bendEnd) ? y + offsetDir : y;
      const nextY = (x < endX && bendStart < bendEnd && x + 1 > bendStart && x + 1 < bendEnd) ? y + offsetDir : y;
      if (x === bendStart && bendStart < bendEnd) {
        path.push({ x, y, edges: { left: x > startX, bottom: offsetDir < 0, top: offsetDir > 0 } });
        path.push({ x, y: y + offsetDir, edges: { right: true, bottom: offsetDir > 0, top: offsetDir < 0 } });
      } else if (x === bendEnd && bendStart < bendEnd) {
        path.push({ x, y: y + offsetDir, edges: { left: true, bottom: offsetDir > 0, top: offsetDir < 0 } });
        path.push({ x, y, edges: { right: x < endX, bottom: offsetDir < 0, top: offsetDir > 0 } });
      } else if (inBend) {
        path.push({ x, y: curY, edges: { left: true, right: true } });
      } else {
        path.push({ x, y, edges: { left: x > startX, right: x < endX } });
      }
    }
  } else {
    // Vertical with horizontal S-curve offset
    const startY = Math.min(aCy, bCy), endY = Math.max(aCy, bCy);
    const x = aCy < bCy ? aCx : bCx;
    const span = endY - startY + 1;
    const offsetDir = Math.random() < 0.5 ? curvature : -curvature;
    const bendStart = startY + Math.max(1, Math.floor(span / 3));
    const bendEnd = startY + Math.min(span - 2, Math.floor(2 * span / 3));
    for (let y = startY; y <= endY; y++) {
      const inBend = bendStart < bendEnd && y > bendStart && y < bendEnd;
      if (y === bendStart && bendStart < bendEnd) {
        path.push({ x, y, edges: { bottom: y > startY, left: offsetDir < 0, right: offsetDir > 0 } });
        path.push({ x: x + offsetDir, y, edges: { top: true, left: offsetDir > 0, right: offsetDir < 0 } });
      } else if (y === bendEnd && bendStart < bendEnd) {
        path.push({ x: x + offsetDir, y, edges: { bottom: true, left: offsetDir > 0, right: offsetDir < 0 } });
        path.push({ x, y, edges: { top: y < endY, left: offsetDir < 0, right: offsetDir > 0 } });
      } else if (inBend) {
        path.push({ x: x + offsetDir, y, edges: { bottom: true, top: true } });
      } else {
        path.push({ x, y, edges: { bottom: y > startY, top: y < endY } });
      }
    }
  }

  return { type: crosserType, path };
}

// ─── Feature placement suggestions ──────────────────────────────────────────

function suggestFeatures(
  rooms: Room[], tileset: TilesetInfo, config: ExteriorStyleConfig,
  crossers: CrosserPath[], areaWidth: number, areaHeight: number,
): SuggestedFeature[] {
  const suggestions: SuggestedFeature[] = [];
  const occupied = new Set<string>();

  // Mark crosser tiles as occupied
  for (const c of crossers) {
    for (const p of c.path) occupied.add(`${p.x},${p.y}`);
  }

  for (let i = 0; i < rooms.length; i++) {
    if (Math.random() >= config.featureDensity) continue;
    const room = rooms[i];

    // Filter groups that fit within this clearing
    const candidates = tileset.groups.filter(g =>
      g.columns <= room.w && g.rows <= room.h &&
      g.tileIds.some(id => id >= 0)
    );
    if (candidates.length === 0) continue;

    // Prefer larger groups for visual impact
    candidates.sort((a, b) => (b.columns * b.rows) - (a.columns * a.rows));
    const pick = candidates[Math.floor(Math.random() * Math.min(3, candidates.length))];

    // Center feature in clearing
    const fx = room.x + Math.floor((room.w - pick.columns) / 2);
    const fy = room.y + Math.floor((room.h - pick.rows) / 2);

    // Validate: within bounds, not on perimeter, no overlap with occupied tiles
    if (fx < 1 || fy < 1 || fx + pick.columns > areaWidth - 1 || fy + pick.rows > areaHeight - 1) continue;
    let overlap = false;
    for (let gx = fx; gx < fx + pick.columns && !overlap; gx++) {
      for (let gy = fy; gy < fy + pick.rows && !overlap; gy++) {
        if (occupied.has(`${gx},${gy}`)) overlap = true;
      }
    }
    if (overlap) continue;

    // Mark tiles as occupied
    for (let gx = fx; gx < fx + pick.columns; gx++) {
      for (let gy = fy; gy < fy + pick.rows; gy++) {
        occupied.add(`${gx},${gy}`);
      }
    }

    suggestions.push({
      feature: pick.name, x: fx, y: fy,
      columns: pick.columns, rows: pick.rows, clearingIndex: i,
    });
  }

  return suggestions;
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
  // Use rawName for matching — it preserves the original .set terrain name which
  // matches tile corner values and validPairs keys.  The display `name` may differ
  // after TLK resolution (e.g. "floor" → "Floor (Interior)").
  // NOTE: Corridor-only tilesets (e.g. Beholder Caves tib01) have a single terrain
  // type and use feature groups for rooms — zone-based layout generation cannot
  // support them.
  const candidates = ["floor", "stone", "dirt", "sand", "grass", "wood"];
  for (const name of candidates) {
    const terrain = tileset.terrainTypes.find(t => t.rawName.includes(name));
    if (terrain && !IMPASSABLE_TERRAINS.has(terrain.rawName) && canAdjoin(terrain.rawName, defaultTerrain, validPairs)) {
      return terrain.rawName;
    }
  }
  // Fallback: any non-impassable terrain that can transition from default
  for (const terrain of tileset.terrainTypes) {
    if (terrain.rawName !== defaultTerrain && !IMPASSABLE_TERRAINS.has(terrain.rawName) && canAdjoin(terrain.rawName, defaultTerrain, validPairs)) {
      return terrain.rawName;
    }
  }
  return null;
}

/** Terrain names that are never suitable as walkable clearings */
const IMPASSABLE_TERRAINS = new Set(["cliff", "pit", "chasm", "wall", "lava", "water", "rocky", "mountain"]);

function findClearingTerrain(tileset: TilesetInfo, defaultTerrain: string, validPairs: Set<string>): string | null {
  const candidates = ["grass", "dirt", "sand", "clearing", "floor", "stone"];
  for (const name of candidates) {
    const terrain = tileset.terrainTypes.find(t => t.rawName.includes(name));
    if (terrain && !IMPASSABLE_TERRAINS.has(terrain.rawName) && canAdjoin(terrain.rawName, defaultTerrain, validPairs)) {
      return terrain.rawName;
    }
  }
  for (const terrain of tileset.terrainTypes) {
    if (terrain.rawName !== defaultTerrain && !IMPASSABLE_TERRAINS.has(terrain.rawName) && canAdjoin(terrain.rawName, defaultTerrain, validPairs)) {
      return terrain.rawName;
    }
  }
  return null;
}

function findTerrainByName(tileset: TilesetInfo, keywords: string[]): string | null {
  for (const kw of keywords) {
    const terrain = tileset.terrainTypes.find(t => t.rawName.includes(kw));
    if (terrain) return terrain.rawName;
  }
  return null;
}

function findCrosserType(tileset: TilesetInfo, keywords: string[]): string | null {
  for (const kw of keywords) {
    const crosser = tileset.crosserTypes.find(c => c.name.toLowerCase().includes(kw));
    if (crosser) return crosser.name.toLowerCase();
  }
  return tileset.crosserTypes.length > 0 ? tileset.crosserTypes[0].name.toLowerCase() : null;
}

/** Find a border terrain for exterior area perimeters.
 *  Accepts keyword list to search for style-appropriate borders (trees, building, cliff, etc.)
 *  Falls back to any non-default terrain that can adjoin the default. */
function findBorderTerrain(tileset: TilesetInfo, defaultTerrain: string, validPairs: Set<string>, keywords?: string[]): string | null {
  const candidates = keywords ?? ["cliff", "rocky", "mountain", "wall", "trees", "building"];
  for (const name of candidates) {
    const terrain = tileset.terrainTypes.find(t => t.rawName.includes(name));
    if (terrain && terrain.rawName !== defaultTerrain && canAdjoin(terrain.rawName, defaultTerrain, validPairs)) {
      return terrain.rawName;
    }
  }
  // Fallback: any non-default terrain that adjoins default
  for (const terrain of tileset.terrainTypes) {
    if (terrain.rawName !== defaultTerrain && canAdjoin(terrain.rawName, defaultTerrain, validPairs)) {
      return terrain.rawName;
    }
  }
  return null;
}

function canAdjoin(terrainA: string, terrainB: string, validPairs: Set<string>): boolean {
  return terrainA === terrainB || validPairs.has(`${terrainA}|${terrainB}`);
}
