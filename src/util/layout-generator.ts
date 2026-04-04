/**
 * Procedural area layout generator for the adventure creator pipeline.
 *
 * All styles (interior and exterior) use a unified BSP pipeline:
 *   1. Resolve wall/floor terrains from style config keywords
 *   2. BSP-partition the playable area into rooms
 *   3. Optionally merge adjacent rooms into L-shapes
 *   4. Place obstacle terrain patches inside rooms
 *   5. Pack feature/group tiles into rooms (mandatory, targeting 50%+ coverage)
 *   6. Connect rooms with corridor crossers through wall tiles
 *   7. Optionally add secondary crosser (stream/river)
 *
 * Supports: dungeon, cave, dwelling, forest, rural, city, plains, desert, castle, tundra
 */

import type { TilesetInfo } from "./tileset.js";
import { getTileDoorWorldPositions } from "./tileset.js";
import type { TerrainZone, CrosserPath } from "./zone-solver.js";
import { computeValidPairs } from "./zone-solver.js";

// ─── Public interface ────────────────────────────────────────────────────────

export interface LayoutStyle {
  type: "dungeon" | "cave" | "dwelling"
      | "forest" | "rural" | "city" | "plains" | "desert" | "castle" | "tundra";
  rooms?: number;          // number of rooms/clearings (default 3)
  clearings?: number;      // alias for rooms (backward compat)
  corridorStyle?: "straight" | "zigzag";
  preferredFeatures?: string[];  // group names to prefer (e.g., ["Farm 1 2x2", "Barn 1 2x2"])
}

export interface TransitionPoint {
  x: number;
  y: number;
  direction: "north" | "south" | "east" | "west";
  tileCol: number;
  tileRow: number;
  nearFeature?: string;  // name of the nearest feature in the same room (if any)
  atDoor?: boolean;      // true when snapped to a building feature's door position
}

export interface SuggestedFeature {
  feature: string;       // group name from tileset
  x: number;             // grid column (bottom-left)
  y: number;             // grid row (bottom-left)
  columns: number;       // width in tiles
  rows: number;          // height in tiles
  clearingIndex: number; // which room this belongs to
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

// ─── Unified style configuration ───────────────────────────────────────────

interface StyleConfig {
  // BSP parameters
  splitVariance: number;           // 0.0-0.25: how far BSP split deviates from midpoint
  marginRange: [number, number];   // [min, max] margin between room edge and BSP leaf edge
  roomSizeRange: [number, number]; // [min, max] fraction of available leaf space for room
  splitThreshold: number;          // minimum leaf dimension before stopping BSP split
  shortcutCount: number;           // number of shortcut corridors (T-junctions)
  sCurveChance: number;            // probability of S-curve on eligible corridors
  nonRectChance: number;           // probability of merging adjacent rooms into L-shapes
  // Terrain resolution
  wallKeywords: string[];          // what fills the wall/border space (tileset default if empty)
  floorKeywords: string[];         // what fills rooms/clearings
  crosserKeywords: string[];       // corridor/doorway for interior, road/path for exterior
  // Obstacles — terrain patches inside rooms
  obstacleKeywords: string[];
  obstacleChance: number;
  obstacleSize: [number, number];
  // Secondary crosser (stream/river)
  secondaryCrosserKeywords: string[];
  secondaryCrosserChance: number;
}

const STYLE_PRESETS: Record<string, StyleConfig> = {
  // ─── Interior styles ───
  dungeon: {
    splitVariance: 0.15, marginRange: [2, 3], roomSizeRange: [0.6, 1.0],
    splitThreshold: 10, shortcutCount: 1, sCurveChance: 0.5, nonRectChance: 0.3,
    wallKeywords: [], floorKeywords: ["floor", "stone"],
    crosserKeywords: ["corridor", "doorway", "door"],
    obstacleKeywords: [], obstacleChance: 0, obstacleSize: [1, 2],
    secondaryCrosserKeywords: [], secondaryCrosserChance: 0,
  },
  cave: {
    splitVariance: 0.2, marginRange: [2, 4], roomSizeRange: [0.4, 0.7],
    splitThreshold: 8, shortcutCount: 3, sCurveChance: 0.7, nonRectChance: 0.1,
    wallKeywords: [], floorKeywords: ["floor", "stone"],
    crosserKeywords: ["corridor", "doorway", "door"],
    obstacleKeywords: [], obstacleChance: 0, obstacleSize: [1, 2],
    secondaryCrosserKeywords: [], secondaryCrosserChance: 0,
  },
  dwelling: {
    splitVariance: 0.05, marginRange: [2, 2], roomSizeRange: [0.85, 1.0],
    splitThreshold: 10, shortcutCount: 0, sCurveChance: 0.1, nonRectChance: 0.0,
    wallKeywords: [], floorKeywords: ["livingroom", "kitchen", "inn", "shop", "floor"],
    crosserKeywords: ["corridor", "doorway", "door"],
    obstacleKeywords: [], obstacleChance: 0, obstacleSize: [1, 2],
    secondaryCrosserKeywords: [], secondaryCrosserChance: 0,
  },
  // ─── Exterior styles ───
  forest: {
    splitVariance: 0.15, marginRange: [2, 2], roomSizeRange: [0.6, 1.0],
    splitThreshold: 12, shortcutCount: 1, sCurveChance: 0.5, nonRectChance: 0.0,
    wallKeywords: ["cliff", "trees", "rocky", "mountain"],
    floorKeywords: ["grass", "dirt", "clearing", "floor", "forest"],
    crosserKeywords: ["road", "path", "trail"],
    obstacleKeywords: ["cliff", "trees", "rocky", "mountain"], obstacleChance: 0.6, obstacleSize: [1, 3],
    secondaryCrosserKeywords: ["stream", "river"], secondaryCrosserChance: 0.5,
  },
  rural: {
    splitVariance: 0.15, marginRange: [2, 2], roomSizeRange: [0.6, 1.0],
    splitThreshold: 12, shortcutCount: 1, sCurveChance: 0.3, nonRectChance: 0.0,
    wallKeywords: ["trees", "cliff", "rocky", "mountain"],
    floorKeywords: ["grass", "snow", "sand", "dirt", "clearing"],
    crosserKeywords: ["road", "path", "trail", "street"],
    obstacleKeywords: ["trees", "cliff", "rocky", "mountain"], obstacleChance: 0.6, obstacleSize: [1, 3],
    secondaryCrosserKeywords: ["stream", "river"], secondaryCrosserChance: 0.4,
  },
  city: {
    splitVariance: 0.05, marginRange: [2, 2], roomSizeRange: [0.85, 1.0],
    splitThreshold: 12, shortcutCount: 0, sCurveChance: 0.1, nonRectChance: 0.0,
    wallKeywords: ["building", "castle", "wall", "trees"],
    floorKeywords: ["cobble", "stone", "floor", "grass"],
    crosserKeywords: ["road", "street", "path"],
    obstacleKeywords: ["building", "castle", "wall"], obstacleChance: 0.3, obstacleSize: [1, 2],
    secondaryCrosserKeywords: [], secondaryCrosserChance: 0,
  },
  plains: {
    splitVariance: 0.15, marginRange: [2, 2], roomSizeRange: [0.6, 1.0],
    splitThreshold: 12, shortcutCount: 1, sCurveChance: 0.3, nonRectChance: 0.0,
    wallKeywords: ["cliff", "mountain", "rocky", "trees"],
    floorKeywords: ["grass", "sand", "dirt"],
    crosserKeywords: ["road", "path", "trail", "ridge"],
    obstacleKeywords: ["cliff", "mountain", "rocky", "trees"], obstacleChance: 0.6, obstacleSize: [1, 3],
    secondaryCrosserKeywords: ["stream", "river"], secondaryCrosserChance: 0.3,
  },
  desert: {
    splitVariance: 0.15, marginRange: [2, 2], roomSizeRange: [0.6, 1.0],
    splitThreshold: 12, shortcutCount: 1, sCurveChance: 0.3, nonRectChance: 0.0,
    wallKeywords: ["cliff", "rocky", "mountain"],
    floorKeywords: ["desert", "sand", "dirt"],
    crosserKeywords: ["road", "trench", "path"],
    obstacleKeywords: ["cliff", "rocky", "mountain"], obstacleChance: 0.6, obstacleSize: [1, 3],
    secondaryCrosserKeywords: [], secondaryCrosserChance: 0,
  },
  castle: {
    splitVariance: 0.15, marginRange: [2, 2], roomSizeRange: [0.6, 1.0],
    splitThreshold: 12, shortcutCount: 1, sCurveChance: 0.3, nonRectChance: 0.0,
    wallKeywords: ["castlewall", "cliff", "wall", "trees"],
    floorKeywords: ["grass", "dirt", "cobble"],
    crosserKeywords: ["road", "path", "lists"],
    obstacleKeywords: ["castlewall", "cliff", "wall", "trees"], obstacleChance: 0.6, obstacleSize: [1, 3],
    secondaryCrosserKeywords: ["river", "stream"], secondaryCrosserChance: 0.2,
  },
  tundra: {
    splitVariance: 0.15, marginRange: [2, 2], roomSizeRange: [0.6, 1.0],
    splitThreshold: 12, shortcutCount: 1, sCurveChance: 0.3, nonRectChance: 0.0,
    wallKeywords: ["trees", "cliff", "rocky", "mountain"],
    floorKeywords: ["snow", "camp", "dirt", "floor"],
    crosserKeywords: ["road", "path", "trail"],
    obstacleKeywords: ["trees", "cliff", "rocky", "mountain"], obstacleChance: 0.6, obstacleSize: [1, 3],
    secondaryCrosserKeywords: ["stream"], secondaryCrosserChance: 0.2,
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
  const config = STYLE_PRESETS[style.type] ?? STYLE_PRESETS.dungeon;
  const roomCount = style.rooms ?? style.clearings ?? 3;
  const defaultTerrain = tileset.defaultTerrain.toLowerCase();

  // ── 1. Resolve terrains ──────────────────────────────────────────────────
  // Wall terrain: use config keywords, fallback to tileset default
  const wallTerrain = config.wallKeywords.length > 0
    ? findWallTerrain(tileset, defaultTerrain, validPairs, config.wallKeywords)
    : null;
  // For exterior styles with explicit wall keywords, the "default" for the solver
  // is the tileset default. The wall terrain is painted as a zone on top.
  // For interior styles (wallKeywords=[]), the tileset default IS the wall.

  // Floor terrain: use config keywords first (skip impassable), then generic fallback
  const floorFromKeywords = findTerrainByName(tileset, config.floorKeywords);
  const floorTerrain = (floorFromKeywords && !IMPASSABLE_TERRAINS.has(floorFromKeywords) ? floorFromKeywords : null)
    ?? findFloorTerrain(tileset, defaultTerrain, validPairs);
  if (!floorTerrain) {
    return { zones: [], crossers: [], transitionPoints: [], suggestedFeatures: [],
      layoutDescription: "ERROR: Cannot find a floor terrain that transitions from the wall terrain." };
  }

  // Crosser type for corridors/roads
  const crosserType = findCrosserType(tileset, config.crosserKeywords);

  // ── 2. BSP partition ─────────────────────────────────────────────────────
  const playableX = 1, playableY = 1;
  const playableW = width - 2, playableH = height - 2;
  const rooms = bspPartition(playableX, playableY, playableW, playableH, roomCount, config);

  // ── 3. L-shape merge ─────────────────────────────────────────────────────
  const roomGroups = attemptLShapeMerge(rooms, config);

  // ── 4. Build zones ───────────────────────────────────────────────────────
  const zones: TerrainZone[] = [];
  const floorTiles = new Set<string>();

  // For exterior styles with explicit wall terrain: paint entire area with wall first
  if (wallTerrain) {
    const allTiles: Array<{ x: number; y: number }> = [];
    for (let x = 0; x < width; x++) {
      for (let y = 0; y < height; y++) {
        allTiles.push({ x, y });
      }
    }
    zones.push({ terrain: wallTerrain, tiles: allTiles });
  }

  // Floor zones from room groups
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

  // ── 5. Interior obstacles ────────────────────────────────────────────────
  if (config.obstacleKeywords.length > 0) {
    const adjTarget = floorTerrain;
    for (const kw of config.obstacleKeywords) {
      const obsTerrain = findTerrainByName(tileset, [kw]);
      if (!obsTerrain || obsTerrain === adjTarget || !canAdjoin(obsTerrain, adjTarget, validPairs)) continue;
      for (const room of rooms) {
        if (Math.random() >= config.obstacleChance) continue;
        const innerW = room.w - 2, innerH = room.h - 2;
        if (innerW < 1 || innerH < 1) continue;
        const [minObs, maxObs] = config.obstacleSize;
        const obsW = Math.min(innerW, minObs + Math.floor(Math.random() * (maxObs - minObs + 1)));
        const obsH = Math.min(innerH, minObs + Math.floor(Math.random() * (maxObs - minObs + 1)));
        const slackX = innerW - obsW, slackY = innerH - obsH;
        const ox = room.x + 1 + (slackX > 0 ? Math.floor(Math.random() * (slackX + 1)) : 0);
        const oy = room.y + 1 + (slackY > 0 ? Math.floor(Math.random() * (slackY + 1)) : 0);
        const tiles: Array<{ x: number; y: number }> = [];
        for (let x = ox; x < ox + obsW; x++) {
          for (let y = oy; y < oy + obsH; y++) {
            tiles.push({ x, y });
          }
        }
        zones.push({ terrain: obsTerrain, tiles });
      }
      break; // only use the first matching obstacle terrain
    }
  }

  // ── 6. Feature packing (mandatory — 50%+ coverage per room) ──────────────
  const suggestedFeatures = packFeatures(rooms, tileset, width, height, floorTerrain, style.preferredFeatures);

  // ── 7. Room connections ───────────────────────────────────────────────────
  // Exterior styles (wallKeywords set): connect with floor terrain corridors
  // Interior styles: connect with crosser corridors through wall tiles
  const isExterior = config.wallKeywords.length > 0;
  const crossers: CrosserPath[] = [];
  const corridorStyleStr = style.corridorStyle ?? "straight";

  // ── 7a. Internal corridors for L-shape merged groups ────────────────────
  for (const group of roomGroups) {
    if (group.length <= 1) continue;
    for (let gi = 0; gi < group.length - 1; gi++) {
      if (isExterior) {
        const path = computeCorridorPath(group[gi], group[gi + 1], corridorStyleStr, floorTiles, config.sCurveChance);
        if (path.length > 0) {
          const tiles: Array<{ x: number; y: number }> = [];
          for (const p of path) {
            if (!floorTiles.has(`${p.x},${p.y}`)) {
              tiles.push(p);
              floorTiles.add(`${p.x},${p.y}`);
            }
          }
          if (tiles.length > 0) zones.push({ terrain: floorTerrain, tiles });
        }
      } else {
        const corridor = connectRooms(group[gi], group[gi + 1], crosserType, corridorStyleStr, floorTiles, config.sCurveChance);
        if (corridor) crossers.push(corridor);
      }
    }
  }

  if (isExterior) {
    // Terrain corridors: carve floor terrain paths between rooms
    const connectTerrainCorridor = (a: Room, b: Room) => {
      const path = computeCorridorPath(a, b, corridorStyleStr, floorTiles, config.sCurveChance);
      if (path.length === 0) return;
      const tiles: Array<{ x: number; y: number }> = [];
      for (const p of path) {
        if (!floorTiles.has(`${p.x},${p.y}`)) {
          tiles.push(p);
          floorTiles.add(`${p.x},${p.y}`);
        }
      }
      if (tiles.length > 0) zones.push({ terrain: floorTerrain, tiles });
    };
    for (let i = 0; i < roomGroups.length - 1; i++) {
      const aRoom = pickClosestSubRoom(roomGroups[i], roomGroups[i + 1]);
      const bRoom = pickClosestSubRoom(roomGroups[i + 1], roomGroups[i]);
      connectTerrainCorridor(aRoom, bRoom);
    }
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
      let added = 0;
      for (const cand of candidates) {
        if (added >= config.shortcutCount) break;
        connectTerrainCorridor(rooms[cand.i], rooms[cand.j]);
        added++;
      }
    }
  } else {
    // Crosser corridors: connect with crosser paths through wall tiles
    for (let i = 0; i < roomGroups.length - 1; i++) {
      const aRoom = pickClosestSubRoom(roomGroups[i], roomGroups[i + 1]);
      const bRoom = pickClosestSubRoom(roomGroups[i + 1], roomGroups[i]);
      const corridor = connectRooms(aRoom, bRoom, crosserType, corridorStyleStr, floorTiles, config.sCurveChance);
      if (corridor) crossers.push(corridor);
    }
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
        const shortcut = connectRooms(
          rooms[cand.i], rooms[cand.j],
          crosserType, corridorStyleStr, floorTiles, config.sCurveChance,
        );
        if (shortcut) {
          crossers.push(shortcut);
          usedBoth.add(key);
          added++;
        }
      }
    }
  }

  // Short interior corridors are no longer collapsed to floor zones.
  // With minLeaf=6 and margin>=2, corridors always span 3+ wall tiles,
  // so crosser stripping in buildCrosserGrid leaves enough tiles for walkable paths.

  // ── 8. Secondary crosser (stream/river) — interior only ──────────────────
  // Exterior styles use terrain corridors, so crossers would cut into wall
  // terrain and cause invalid tiles. Only interior styles get secondary crossers.
  if (!isExterior && config.secondaryCrosserKeywords.length > 0 && Math.random() < config.secondaryCrosserChance) {
    const streamCrosser = findCrosserType(tileset, config.secondaryCrosserKeywords);
    if (streamCrosser && streamCrosser !== crosserType && rooms.length >= 2) {
      const roadTiles = new Set<string>();
      for (const c of crossers) {
        for (const p of c.path) roadTiles.add(`${p.x},${p.y}`);
      }
      const stream = connectRoomsWinding(rooms[0], rooms[rooms.length - 1], streamCrosser, 2, roadTiles);
      if (stream) crossers.push(stream);
    }
  }

  // ── 9. Transitions & description ─────────────────────────────────────────
  const transitionPoints = computeTransitions(rooms, width, height, transitionCount, transitionDirections, suggestedFeatures, floorTiles, tileset);

  const roomDescs = rooms.map((r, i) => `Room ${String.fromCharCode(65 + i)} (${r.w}x${r.h} at col=${r.x},row=${r.y})`);
  const corridorDescs = crossers.length > 0 ? ` ${crossers.length} corridors.` : "";
  const featureDescs = suggestedFeatures.length > 0 ? ` ${suggestedFeatures.length} features.` : "";
  const layoutDescription = `${roomCount}-room ${style.type}: ${roomDescs.join(", ")}.${corridorDescs}${featureDescs}`;

  return { zones, crossers, transitionPoints, suggestedFeatures, layoutDescription };
}

// ─── BSP partitioning ────────────────────────────────────────────────────────

function bspPartition(x: number, y: number, w: number, h: number,
                      targetRooms: number, config: StyleConfig): Room[] {
  // Minimum leaf = 6 tiles (room 3 + margin 2 on one side + 1 buffer).
  // Guarantees 2-tile wall gaps between adjacent rooms for visual separation.
  // A 12x12 area (10x10 playable) splits into 4 leaves of 5x5 each.
  const minLeaf = 6;
  const canSplitH = h >= minLeaf * 2;
  const canSplitW = w >= minLeaf * 2;

  if (targetRooms <= 1 || (!canSplitH && !canSplitW)) {
    const [minM, maxM] = config.marginRange;
    // Always enforce minimum margin of 2 for room separation — never collapse to 1
    const margin = Math.max(2, minM + Math.floor(Math.random() * (maxM - minM + 1)));
    const availW = Math.max(3, w - margin * 2);
    const availH = Math.max(3, h - margin * 2);
    const sizeFrac = config.roomSizeRange[0] +
      Math.random() * (config.roomSizeRange[1] - config.roomSizeRange[0]);
    const roomW = Math.max(3, Math.min(availW, Math.round(availW * sizeFrac)));
    const roomH = Math.max(3, Math.min(availH, Math.round(availH * sizeFrac)));
    const slackW = Math.max(0, availW - roomW);
    const slackH = Math.max(0, availH - roomH);
    const offsetX = slackW > 0 ? Math.floor(Math.random() * (slackW + 1)) : 0;
    const offsetY = slackH > 0 ? Math.floor(Math.random() * (slackH + 1)) : 0;
    const rx = x + Math.min(margin + offsetX, Math.max(0, w - roomW));
    const ry = y + Math.min(margin + offsetY, Math.max(0, h - roomH));
    return [{ x: rx, y: ry, w: Math.min(roomW, w - (rx - x)), h: Math.min(roomH, h - (ry - y)), name: "" }];
  }

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

// ─── L-shape room merging ────────────────────────────────────────────────────

function areAdjacentRooms(a: Room, b: Room): boolean {
  const aRight = a.x + a.w, aTop = a.y + a.h;
  const bRight = b.x + b.w, bTop = b.y + b.h;
  const yOverlap = Math.min(aTop, bTop) - Math.max(a.y, b.y);
  if (yOverlap > 0) {
    const gap = Math.max(b.x - aRight, a.x - bRight);
    return gap >= 2 && gap <= 4;
  }
  const xOverlap = Math.min(aRight, bRight) - Math.max(a.x, b.x);
  if (xOverlap > 0) {
    const gap = Math.max(b.y - aTop, a.y - bTop);
    return gap >= 2 && gap <= 4;
  }
  return false;
}

function attemptLShapeMerge(rooms: Room[], config: StyleConfig): Room[][] {
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

// ─── Corridor path computation ──────────────────────────────────────────────

/** Compute raw corridor path positions between two rooms (used for both
 *  crosser corridors and terrain corridors). Returns all tile positions
 *  along the path including room-edge tiles. */
function computeCorridorPath(
  a: Room, b: Room, corridorStyle: string,
  floorTiles: Set<string>, sCurveChance: number,
): Array<{ x: number; y: number }> {
  const aRight = a.x + a.w - 1, aTop = a.y + a.h - 1;
  const bRight = b.x + b.w - 1, bTop = b.y + b.h - 1;
  const yOverlapMin = Math.max(a.y, b.y), yOverlapMax = Math.min(aTop, bTop);
  const hasYOverlap = yOverlapMin <= yOverlapMax;
  const xOverlapMin = Math.max(a.x, b.x), xOverlapMax = Math.min(aRight, bRight);
  const hasXOverlap = xOverlapMin <= xOverlapMax;
  const path: Array<{ x: number; y: number }> = [];

  if (hasYOverlap) {
    const sharedY = Math.floor((yOverlapMin + yOverlapMax) / 2);
    const x0 = Math.min(aRight, bRight) === aRight ? aRight : bRight;
    const x1 = Math.max(a.x, b.x);
    const xMin = Math.min(x0, x1), xMax = Math.max(x0, x1);
    const wallStartX = xMin + 1, wallEndX = xMax - 1, wallSpanX = wallEndX - wallStartX + 1;
    if (corridorStyle !== "zigzag" && wallSpanX >= 3 && Math.random() < sCurveChance) {
      const offsetDir = Math.random() < 0.5 ? 1 : -1;
      const bendStart = wallStartX + Math.max(1, Math.floor(wallSpanX / 3));
      const bendEnd = wallStartX + Math.min(wallSpanX - 1, Math.floor(2 * wallSpanX / 3));
      if (bendStart < bendEnd) {
        for (let x = xMin; x <= xMax; x++) {
          if (x === bendStart) { path.push({ x, y: sharedY }); path.push({ x, y: sharedY + offsetDir }); }
          else if (x > bendStart && x < bendEnd) { path.push({ x, y: sharedY + offsetDir }); }
          else if (x === bendEnd) { path.push({ x, y: sharedY + offsetDir }); path.push({ x, y: sharedY }); }
          else { path.push({ x, y: sharedY }); }
        }
      } else {
        for (let x = xMin; x <= xMax; x++) path.push({ x, y: sharedY });
      }
    } else {
      for (let x = xMin; x <= xMax; x++) path.push({ x, y: sharedY });
    }
  } else if (hasXOverlap) {
    const sharedX = Math.floor((xOverlapMin + xOverlapMax) / 2);
    const y0 = Math.min(aTop, bTop), y1 = Math.max(a.y, b.y);
    const yMin = Math.min(y0, y1), yMax = Math.max(y0, y1);
    const wallStartY = yMin + 1, wallEndY = yMax - 1, wallSpanY = wallEndY - wallStartY + 1;
    if (corridorStyle !== "zigzag" && wallSpanY >= 3 && Math.random() < sCurveChance) {
      const offsetDir = Math.random() < 0.5 ? 1 : -1;
      const bendStart = wallStartY + Math.max(1, Math.floor(wallSpanY / 3));
      const bendEnd = wallStartY + Math.min(wallSpanY - 1, Math.floor(2 * wallSpanY / 3));
      if (bendStart < bendEnd) {
        for (let y = yMin; y <= yMax; y++) {
          if (y === bendStart) { path.push({ x: sharedX, y }); path.push({ x: sharedX + offsetDir, y }); }
          else if (y > bendStart && y < bendEnd) { path.push({ x: sharedX + offsetDir, y }); }
          else if (y === bendEnd) { path.push({ x: sharedX + offsetDir, y }); path.push({ x: sharedX, y }); }
          else { path.push({ x: sharedX, y }); }
        }
      } else {
        for (let y = yMin; y <= yMax; y++) path.push({ x: sharedX, y });
      }
    } else {
      for (let y = yMin; y <= yMax; y++) path.push({ x: sharedX, y });
    }
  } else {
    // L-shaped path
    const aCx = a.x + Math.floor(a.w / 2), aCy = a.y + Math.floor(a.h / 2);
    const bCx = b.x + Math.floor(b.w / 2), bCy = b.y + Math.floor(b.h / 2);
    if (corridorStyle === "zigzag") {
      for (let y = Math.min(aCy, bCy); y <= Math.max(aCy, bCy); y++) path.push({ x: aCx, y });
      for (let x = Math.min(aCx, bCx); x <= Math.max(aCx, bCx); x++) {
        if (x !== aCx) path.push({ x, y: bCy });
      }
    } else {
      for (let x = Math.min(aCx, bCx); x <= Math.max(aCx, bCx); x++) path.push({ x, y: aCy });
      for (let y = Math.min(aCy, bCy); y <= Math.max(aCy, bCy); y++) {
        if (y !== aCy) path.push({ x: bCx, y });
      }
    }
  }
  return path;
}

// ─── Room connection (crosser corridor through wall tiles) ──────────────────

function connectRooms(
  a: Room, b: Room,
  crosserType: string | null,
  corridorStyle: string,
  floorTiles: Set<string>,
  sCurveChance = 0.5,
): CrosserPath | null {
  if (!crosserType) return null;

  const fullPath = computeCorridorPath(a, b, corridorStyle, floorTiles, sCurveChance);

  // Filter to only wall tiles (tiles NOT in any floor zone)
  const wallOnly = fullPath.filter(p => !floorTiles.has(`${p.x},${p.y}`));
  if (wallOnly.length === 0) return null;

  // Identify room-corner tiles: diagonally adjacent to a room tile but NOT
  // cardinally adjacent. These tiles get a single non-wall corner from the
  // corner grid (e.g., wall/wall/wall/floor). No tileset has crosser tiles
  // for that 3-wall+1-floor pattern, so crosser edges on these tiles would
  // always be dropped by the solver. Suppress crosser edges on them.
  // Room-EDGE tiles (cardinally adjacent to rooms) are fine — the solver's
  // step 1.5 finds "corridor mouth" tiles for 2-wall+2-floor + crosser.
  const roomCornerTiles = new Set<string>();
  for (const p of wallOnly) {
    const isDiagAdj = [[-1,-1],[-1,1],[1,-1],[1,1]].some(
      ([dx, dy]) => floorTiles.has(`${p.x + dx},${p.y + dy}`)
    );
    const isCardAdj = [[0,-1],[0,1],[-1,0],[1,0]].some(
      ([dx, dy]) => floorTiles.has(`${p.x + dx},${p.y + dy}`)
    );
    if (isDiagAdj && !isCardAdj) {
      roomCornerTiles.add(`${p.x},${p.y}`);
    }
  }

  // Build crosser path with edge flags.
  // Only generate crosser edges toward other wall tiles in the corridor,
  // NOT toward room tiles or room-corner tiles. Room-corner tiles can't
  // carry crossers (3-wall+1-floor pattern has no crosser tiles), so they
  // must also be excluded from the wall set used for edge generation.
  const wallSet = new Set(
    wallOnly.filter(p => !roomCornerTiles.has(`${p.x},${p.y}`))
      .map(p => `${p.x},${p.y}`)
  );
  const path: CrosserPath["path"] = wallOnly
    .filter(p => !roomCornerTiles.has(`${p.x},${p.y}`))
    .map((p) => {
      const fullIdx = fullPath.findIndex(fp => fp.x === p.x && fp.y === p.y);
      const prev = fullIdx > 0 ? fullPath[fullIdx - 1] : null;
      const next = fullIdx < fullPath.length - 1 ? fullPath[fullIdx + 1] : null;
      // Only set edge if neighbor is also a wall corridor tile (not room-corner)
      const prevIsWall = prev !== null && wallSet.has(`${prev.x},${prev.y}`);
      const nextIsWall = next !== null && wallSet.has(`${next.x},${next.y}`);
      return {
        x: p.x, y: p.y,
        edges: {
          left:   (prevIsWall && prev!.x < p.x) || (nextIsWall && next!.x < p.x) ? true : undefined,
          right:  (prevIsWall && prev!.x > p.x) || (nextIsWall && next!.x > p.x) ? true : undefined,
          bottom: (prevIsWall && prev!.y < p.y) || (nextIsWall && next!.y < p.y) ? true : undefined,
          top:    (prevIsWall && prev!.y > p.y) || (nextIsWall && next!.y > p.y) ? true : undefined,
        },
      };
    });

  return { type: crosserType, path };
}

// ─── Winding connector (for secondary crossers like streams) ────────────────

function connectRoomsWinding(a: Room, b: Room, crosserType: string, curvature: number, avoidTiles?: Set<string>): CrosserPath | null {
  const aCx = a.x + Math.floor(a.w / 2), aCy = a.y + Math.floor(a.h / 2);
  const bCx = b.x + Math.floor(b.w / 2), bCy = b.y + Math.floor(b.h / 2);
  const path: CrosserPath["path"] = [];
  const dx = Math.abs(bCx - aCx), dy = Math.abs(bCy - aCy);

  if (dx >= dy) {
    const startX = Math.min(aCx, bCx), endX = Math.max(aCx, bCx);
    const y = aCx < bCx ? aCy : bCy;
    const span = endX - startX + 1;
    const offsetDir = Math.random() < 0.5 ? curvature : -curvature;
    const bendStart = startX + Math.max(1, Math.floor(span / 3));
    const bendEnd = startX + Math.min(span - 2, Math.floor(2 * span / 3));
    for (let x = startX; x <= endX; x++) {
      const inBend = bendStart < bendEnd && x > bendStart && x < bendEnd;
      if (x === bendStart && bendStart < bendEnd) {
        path.push({ x, y, edges: { left: x > startX, bottom: offsetDir < 0, top: offsetDir > 0 } });
        path.push({ x, y: y + offsetDir, edges: { right: true, bottom: offsetDir > 0, top: offsetDir < 0 } });
      } else if (x === bendEnd && bendStart < bendEnd) {
        path.push({ x, y: y + offsetDir, edges: { left: true, bottom: offsetDir > 0, top: offsetDir < 0 } });
        path.push({ x, y, edges: { right: x < endX, bottom: offsetDir < 0, top: offsetDir > 0 } });
      } else if (inBend) {
        path.push({ x, y: y + offsetDir, edges: { left: true, right: true } });
      } else {
        path.push({ x, y, edges: { left: x > startX, right: x < endX } });
      }
    }
  } else {
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

  if (avoidTiles) {
    for (const p of path) {
      if (avoidTiles.has(`${p.x},${p.y}`)) return null;
    }
  }

  return { type: crosserType, path };
}

// ─── Feature packing (mandatory — 50%+ tile coverage per room) ──────────────

/** Reject groups whose door tiles sit on terrain transitions or crosser edges.
 *  Freestanding buildings (all corners + edges match floor terrain) pass through. */
export function groupHasUnsupportedDoors(group: { tileIds: number[] }, tileset: TilesetInfo, floorTerrain: string): boolean {
  const lc = floorTerrain.toLowerCase();
  for (const tileId of group.tileIds) {
    if (tileId < 0) continue;
    const tile = tileset.tiles[tileId];
    if (!tile || tile.doors === 0) continue;
    // This tile has doors — check that ALL corners and ALL crosser edges are floor-only
    if (tile.corners.topLeft.toLowerCase() !== lc ||
        tile.corners.topRight.toLowerCase() !== lc ||
        tile.corners.bottomLeft.toLowerCase() !== lc ||
        tile.corners.bottomRight.toLowerCase() !== lc) return true;
    if (tile.crossers.top || tile.crossers.right ||
        tile.crossers.bottom || tile.crossers.left) return true;
  }
  return false;
}

export function groupHasCrossers(group: { tileIds: number[] }, tileset: TilesetInfo): boolean {
  for (const tileId of group.tileIds) {
    if (tileId < 0) continue;
    const tile = tileset.tiles[tileId];
    if (tile && (tile.crossers.top || tile.crossers.right || tile.crossers.bottom || tile.crossers.left)) return true;
  }
  return false;
}

/** Check that ALL corners of ALL tiles in a group match the given terrain.
 *  Features with mismatched corners create visual seams and force solver fallbacks. */
export function groupMatchesTerrain(group: { tileIds: number[] }, tileset: TilesetInfo, terrain: string): boolean {
  const lc = terrain.toLowerCase();
  for (const tileId of group.tileIds) {
    if (tileId < 0) continue;
    const tile = tileset.tiles[tileId];
    if (!tile) continue;
    if (tile.corners.topLeft.toLowerCase() !== lc ||
        tile.corners.topRight.toLowerCase() !== lc ||
        tile.corners.bottomLeft.toLowerCase() !== lc ||
        tile.corners.bottomRight.toLowerCase() !== lc) return false;
  }
  return true;
}

function packFeatures(
  rooms: Room[], tileset: TilesetInfo,
  areaWidth: number, areaHeight: number,
  floorTerrain: string,
  preferredFeatures?: string[],
): SuggestedFeature[] {
  const suggestions: SuggestedFeature[] = [];
  const occupied = new Set<string>();

  // Ordered preferred list — preserves LLM rank order (best fit first).
  // Only preferred features are placed; no random filler. One feature per room.
  // Each preferred feature is used at most once before any repeats.
  const preferredOrder = preferredFeatures ?? [];
  const usedFeatures = new Set<string>();

  for (let i = 0; i < rooms.length; i++) {
    const room = rooms[i];

    // Get all groups that have valid tile IDs, exclude groups with unsupported doors,
    // crossers, or mismatched terrain corners
    const validGroups = tileset.groups
      .filter(g => g.tileIds.some(id => id >= 0)
        && !groupHasUnsupportedDoors(g, tileset, floorTerrain)
        && !groupHasCrossers(g, tileset)
        && groupMatchesTerrain(g, tileset, floorTerrain));

    // Try preferred features in LLM rank order, skipping already-used ones.
    // If all are used, reset and allow repeats.
    let placed = false;
    for (let pass = 0; pass < 2 && !placed; pass++) {
      if (pass === 1) usedFeatures.clear(); // allow repeats on second pass
    for (const prefName of preferredOrder) {
      if (usedFeatures.has(prefName.toLowerCase())) continue;
      const group = validGroups.find(g => g.name.toLowerCase() === prefName.toLowerCase());
      if (!group || group.columns > room.w || group.rows > room.h) continue;

      // Try multiple positions within the room
      for (let attempt = 0; attempt < 20; attempt++) {
        const maxFx = room.x + room.w - group.columns;
        const maxFy = room.y + room.h - group.rows;
        const fx = room.x + Math.floor(Math.random() * (maxFx - room.x + 1));
        const fy = room.y + Math.floor(Math.random() * (maxFy - room.y + 1));

        // Validate: within area bounds, not on perimeter
        if (fx < 1 || fy < 1 || fx + group.columns > areaWidth - 1 || fy + group.rows > areaHeight - 1) continue;

        // Check no overlap with already-placed features
        let overlap = false;
        for (let gx = fx; gx < fx + group.columns && !overlap; gx++) {
          for (let gy = fy; gy < fy + group.rows && !overlap; gy++) {
            if (occupied.has(`${gx},${gy}`)) overlap = true;
          }
        }
        if (overlap) continue;

        // Place it
        for (let gx = fx; gx < fx + group.columns; gx++) {
          for (let gy = fy; gy < fy + group.rows; gy++) {
            occupied.add(`${gx},${gy}`);
          }
        }

        suggestions.push({
          feature: group.name, x: fx, y: fy,
          columns: group.columns, rows: group.rows, clearingIndex: i,
        });
        usedFeatures.add(prefName.toLowerCase());
        placed = true;
        break;
      }
      if (placed) break; // one feature per room — move to next room
    }
    } // end pass loop
  }

  return suggestions;
}

// ─── Feature door resolution ─────────────────────────────────────────────────

/**
 * Find the world-space door position for a building feature (house, inn, barn, etc.).
 * Collects ALL doors across ALL tiles of the feature, then returns the first one
 * whose 3m outward offset lands OUTSIDE the feature footprint (an exterior door).
 * Interior doors (connecting feature tiles to each other) are skipped.
 * Returns null if the feature has no exterior doors.
 */
function findFeatureDoorPosition(
  feature: SuggestedFeature,
  tileset: TilesetInfo,
): { x: number; y: number; bearing: number; tileCol: number; tileRow: number } | null {
  const group = tileset.groups.find(g => g.name === feature.feature);
  if (!group) return null;

  // Build set of feature tile positions for interior-door detection
  const featureTileSet = new Set<string>();
  for (let gc = 0; gc < group.columns; gc++) {
    for (let gr = 0; gr < group.rows; gr++) {
      featureTileSet.add(`${feature.x + gc},${feature.y + gr}`);
    }
  }

  const OFFSET = 3.0;
  // Collect all doors, prefer exterior ones
  const allDoors: Array<{ x: number; y: number; bearing: number; tileCol: number; tileRow: number; exterior: boolean }> = [];
  for (let gr = 0; gr < group.rows; gr++) {
    for (let gc = 0; gc < group.columns; gc++) {
      const tileId = group.tileIds[gr * group.columns + gc];
      if (tileId < 0) continue;
      const tile = tileset.tiles[tileId];
      if (!tile || tile.doors === 0) continue;
      const doorPositions = getTileDoorWorldPositions(tile, feature.x + gc, feature.y + gr, 0);
      for (const door of doorPositions) {
        const rad = (door.bearing * Math.PI) / 180;
        const offsetX = door.x + Math.cos(rad) * OFFSET;
        const offsetY = door.y + Math.sin(rad) * OFFSET;
        // Check if offset lands on a feature tile
        const offsetTileCol = Math.floor(offsetX / 10);
        const offsetTileRow = Math.floor(offsetY / 10);
        const isExterior = !featureTileSet.has(`${offsetTileCol},${offsetTileRow}`);
        allDoors.push({
          x: Math.round(door.x * 10) / 10,
          y: Math.round(door.y * 10) / 10,
          bearing: door.bearing,
          tileCol: feature.x + gc,
          tileRow: feature.y + gr,
          exterior: isExterior,
        });
      }
    }
  }

  // Return the first exterior door only — interior doors (facing other feature tiles)
  // would place the transition inside the building. If no exterior door exists,
  // return null so the caller falls back to edge-proximity tile placement.
  return allDoors.find(d => d.exterior) ?? null;
}

// ─── Transition point computation ────────────────────────────────────────────

function computeTransitions(
  rooms: Room[],
  width: number,
  height: number,
  transitionCount?: number,
  transitionDirections?: string[],
  features?: SuggestedFeature[],
  floorTiles?: Set<string>,
  tileset?: TilesetInfo,
): TransitionPoint[] {
  const count = transitionCount ?? 1;
  const directions = transitionDirections?.map(d => d.toLowerCase()) ??
    ["south", "north", "east", "west"].slice(0, count);

  // Build set of tiles occupied by features — transitions must avoid these
  const featureTiles = new Set<string>();
  // Build reverse index: room index → feature names in that room
  const roomFeatures = new Map<number, string[]>();
  if (features) {
    for (const f of features) {
      for (let dx = 0; dx < f.columns; dx++) {
        for (let dy = 0; dy < f.rows; dy++) {
          featureTiles.add(`${f.x + dx},${f.y + dy}`);
        }
      }
      const list = roomFeatures.get(f.clearingIndex) ?? [];
      list.push(f.feature);
      roomFeatures.set(f.clearingIndex, list);
    }
  }

  // Quadrant tracking: divide area at midpoints, track which quadrants have transitions
  const midCol = width / 2;
  const midRow = height / 2;
  const usedQuadrants = new Set<string>();

  function getQuadrant(col: number, row: number): string {
    return (col < midCol ? "W" : "E") + (row < midRow ? "S" : "N");
  }

  // Natural quadrant affinity per direction (prefer these quadrants first)
  const dirQuadrants: Record<string, string[]> = {
    south: ["WS", "ES"], north: ["WN", "EN"],
    west:  ["WS", "WN"], east:  ["ES", "EN"],
  };

  const points: TransitionPoint[] = [];
  const usedRoomIndices = new Set<number>();

  for (const dir of directions) {
    if (points.length >= count) break;

    // Score each room: distance-to-edge for this direction + quadrant + feature bonus
    const preferredQuads = dirQuadrants[dir] ?? [];
    const scored: Array<{ room: Room; idx: number; score: number }> = [];
    for (let i = 0; i < rooms.length; i++) {
      const room = rooms[i];
      const cx = room.x + room.w / 2;
      const cy = room.y + room.h / 2;

      // Base: inverse edge distance (closer to target edge = higher score)
      let edgeDist: number;
      switch (dir) {
        case "north": edgeDist = height - cy; break;
        case "south": edgeDist = cy; break;
        case "east":  edgeDist = width - cx; break;
        case "west":  edgeDist = cx; break;
        default:      edgeDist = Infinity;
      }
      // Normalize to 0..1 range (closer = higher)
      const maxDist = dir === "north" || dir === "south" ? height : width;
      const edgeScore = 1 - Math.min(edgeDist / maxDist, 1);

      // Quadrant bonus: prefer rooms in unused quadrants aligned with this direction
      const roomQuad = getQuadrant(cx, cy);
      let quadBonus = 0;
      if (preferredQuads.includes(roomQuad) && !usedQuadrants.has(roomQuad)) {
        quadBonus = 0.3;
      } else if (!usedQuadrants.has(roomQuad)) {
        quadBonus = 0.15;
      }

      // Feature bonus: prefer rooms with features (soft tiebreaker)
      const hasFeature = roomFeatures.has(i);
      const featureBonus = hasFeature ? 0.1 : 0;

      // Room reuse penalty
      const reusePenalty = usedRoomIndices.has(i) ? -0.5 : 0;

      scored.push({ room, idx: i, score: edgeScore + quadBonus + featureBonus + reusePenalty });
    }
    scored.sort((a, b) => b.score - a.score);

    // Among top candidates, maximize Manhattan distance to prior transitions
    let pick = scored[0];
    if (points.length > 0) {
      const eligible = scored.slice(0, Math.max(1, Math.ceil(scored.length * 0.5)));
      let bestMinDist = -1;
      for (const s of eligible) {
        const cx = s.room.x + Math.floor(s.room.w / 2);
        const cy = s.room.y + Math.floor(s.room.h / 2);
        const minDist = Math.min(...points.map(p => Math.abs(p.tileCol - cx) + Math.abs(p.tileRow - cy)));
        // Combine: 70% spacing score + 30% original score (so edge proximity still matters)
        const maxManhattan = width + height;
        const spacingScore = minDist / maxManhattan;
        const combined = spacingScore * 0.7 + s.score * 0.3;
        if (combined > bestMinDist) { bestMinDist = combined; pick = s; }
      }
    }

    const bestRoom = pick.room;
    const bestRoomIdx = pick.idx;
    usedRoomIndices.add(bestRoomIdx);
    usedQuadrants.add(getQuadrant(bestRoom.x + bestRoom.w / 2, bestRoom.y + bestRoom.h / 2));

    // Pick transition tile: prefer edge tile closest to non-floor (wall/border) terrain.
    // This places transitions at the "mouth" where the room meets wilderness.
    let tileCol: number, tileRow: number;
    const bestTile = findEdgeProximityTile(bestRoom, dir, floorTiles, featureTiles);
    if (bestTile) {
      tileCol = bestTile.col;
      tileRow = bestTile.row;
    } else {
      // Fallback: room edge center (original logic)
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
    }

    // If the chosen tile is occupied by a feature, scan along the room edge
    // for a free tile. Try alternating offsets ±1, ±2, etc.
    if (featureTiles.has(`${tileCol},${tileRow}`)) {
      const isVerticalEdge = dir === "east" || dir === "west";
      const edgeLen = isVerticalEdge ? bestRoom.h : bestRoom.w;
      let found = false;
      for (let offset = 1; offset < edgeLen; offset++) {
        for (const sign of [1, -1]) {
          const tc = isVerticalEdge ? tileCol : tileCol + offset * sign;
          const tr = isVerticalEdge ? tileRow + offset * sign : tileRow;
          if (tc < bestRoom.x || tc >= bestRoom.x + bestRoom.w) continue;
          if (tr < bestRoom.y || tr >= bestRoom.y + bestRoom.h) continue;
          if (!featureTiles.has(`${tc},${tr}`)) {
            tileCol = tc;
            tileRow = tr;
            found = true;
            break;
          }
        }
        if (found) break;
      }
    }

    // Find nearest feature in this room for context
    const roomFeatureNames = roomFeatures.get(bestRoomIdx);
    const nearFeature = roomFeatureNames?.[0];

    // If the nearest feature has a door (building entrance), snap transition to the door
    let doorPos: ReturnType<typeof findFeatureDoorPosition> = null;
    if (nearFeature && tileset && features) {
      const feat = features.find(f => f.feature === nearFeature && f.clearingIndex === bestRoomIdx);
      if (feat) doorPos = findFeatureDoorPosition(feat, tileset);
    }

    if (doorPos) {
      // Offset 3m outward along the door's facing direction so the portal
      // sits in front of the building entrance, not inside it.
      // NWN bearing: 0=east, 90=north, 180=west, 270=south.
      const DOOR_OFFSET = 3.0;
      const rad = (doorPos.bearing * Math.PI) / 180;
      const ox = Math.round((doorPos.x + Math.cos(rad) * DOOR_OFFSET) * 10) / 10;
      const oy = Math.round((doorPos.y + Math.sin(rad) * DOOR_OFFSET) * 10) / 10;
      points.push({
        x: ox,
        y: oy,
        direction: dir as TransitionPoint["direction"],
        tileCol: doorPos.tileCol,
        tileRow: doorPos.tileRow,
        nearFeature,
        atDoor: true,
      });
    } else {
      points.push({
        x: tileCol * 10 + 5,
        y: tileRow * 10 + 5,
        direction: dir as TransitionPoint["direction"],
        tileCol,
        tileRow,
        ...(nearFeature ? { nearFeature } : {}),
      });
    }
  }

  return points;
}

/**
 * Find the best floor tile on a room's edge facing `dir` that is closest to
 * non-floor (wall/border) terrain. Places transitions at the "mouth" of the
 * room where it meets wilderness/chasm/cliff.
 *
 * Returns null if floorTiles not available (falls back to center logic).
 */
function findEdgeProximityTile(
  room: Room,
  dir: string,
  floorTiles?: Set<string>,
  featureTiles?: Set<string>,
): { col: number; row: number } | null {
  if (!floorTiles) return null;

  // Collect candidate tiles on the room's edge facing the target direction
  const candidates: Array<{ col: number; row: number; wallDist: number }> = [];

  // Scan edge tiles
  const edgeTiles: Array<{ col: number; row: number }> = [];
  switch (dir) {
    case "north":
      for (let x = room.x; x < room.x + room.w; x++) edgeTiles.push({ col: x, row: room.y + room.h - 1 });
      break;
    case "south":
      for (let x = room.x; x < room.x + room.w; x++) edgeTiles.push({ col: x, row: room.y });
      break;
    case "east":
      for (let y = room.y; y < room.y + room.h; y++) edgeTiles.push({ col: room.x + room.w - 1, row: y });
      break;
    case "west":
      for (let y = room.y; y < room.y + room.h; y++) edgeTiles.push({ col: room.x, row: y });
      break;
  }

  for (const t of edgeTiles) {
    // Skip tiles occupied by features
    if (featureTiles?.has(`${t.col},${t.row}`)) continue;

    // Measure distance to nearest non-floor tile in the target direction
    let dist = 0;
    let probeCol = t.col, probeRow = t.row;
    const dx = dir === "east" ? 1 : dir === "west" ? -1 : 0;
    const dy = dir === "north" ? 1 : dir === "south" ? -1 : 0;
    for (let step = 1; step <= 10; step++) {
      probeCol += dx;
      probeRow += dy;
      if (!floorTiles.has(`${probeCol},${probeRow}`)) {
        dist = step;
        break;
      }
    }
    // If we didn't find a wall within 10 tiles, use max distance
    if (dist === 0) dist = 11;
    candidates.push({ ...t, wallDist: dist });
  }

  if (candidates.length === 0) return null;

  // Prefer tiles closest to wall terrain (smallest wallDist)
  candidates.sort((a, b) => a.wallDist - b.wallDist);
  return { col: candidates[0].col, row: candidates[0].row };
}

// ─── Tileset terrain helpers ─────────────────────────────────────────────────

const IMPASSABLE_TERRAINS = new Set(["cliff", "pit", "chasm", "wall", "lava", "water", "rocky", "mountain"]);

/** Resolve the floor terrain a style would use on this tileset.
 *  Reuses the same logic as generateLayout so the result is authoritative. */
export function resolveFloorTerrain(tileset: TilesetInfo, styleType: string): string | null {
  const config = STYLE_PRESETS[styleType] ?? STYLE_PRESETS.dungeon;
  const defaultTerrain = tileset.defaultTerrain.toLowerCase();
  const validPairs = computeValidPairs(tileset);
  const fromKeywords = findTerrainByName(tileset, config.floorKeywords);
  return (fromKeywords && !IMPASSABLE_TERRAINS.has(fromKeywords) ? fromKeywords : null)
    ?? findFloorTerrain(tileset, defaultTerrain, validPairs);
}

function findFloorTerrain(tileset: TilesetInfo, defaultTerrain: string, validPairs: Set<string>): string | null {
  const candidates = ["floor", "stone", "dirt", "sand", "grass", "wood"];
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

function findWallTerrain(tileset: TilesetInfo, defaultTerrain: string, validPairs: Set<string>, keywords: string[]): string | null {
  for (const name of keywords) {
    const terrain = tileset.terrainTypes.find(t => t.rawName.includes(name));
    if (terrain && terrain.rawName !== defaultTerrain && canAdjoin(terrain.rawName, defaultTerrain, validPairs)) {
      return terrain.rawName;
    }
  }
  for (const terrain of tileset.terrainTypes) {
    if (terrain.rawName !== defaultTerrain && canAdjoin(terrain.rawName, defaultTerrain, validPairs)) {
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

function canAdjoin(terrainA: string, terrainB: string, validPairs: Set<string>): boolean {
  return terrainA === terrainB || validPairs.has(`${terrainA}|${terrainB}`);
}
