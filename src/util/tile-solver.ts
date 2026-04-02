/**
 * NWN tile utilities for default tile selection and placement validation.
 *
 * The main terrain solving logic is in zone-solver.ts (zone-based approach).
 * This file provides:
 * - findDefaultTile: used by create_area to find a uniform fill tile
 * - validateTilePlacement: used by paint_tiles and paint_group to check neighbors
 *
 * Height tiles (any corner height > 0) are excluded from tile selection.
 */

import type {
  TilesetInfo, TileDefinition, TileCorners, TileCrossers,
} from "./tileset.js";
import { getRotatedCorners, getRotatedCrossers } from "./tileset.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface TilePlacement {
  tileId: number;
  orientation: number;  // 0-3
}

export interface TileGridEntry {
  tileId: number;
  orientation: number;
}

// ─── Internal Types ─────────────────────────────────────────────────────────

/** High-level tile request for findDefaultTile. */
interface TileRequest {
  terrain?: string;
}

// ─── Tile Matching (internal) ───────────────────────────────────────────────

/**
 * Find all valid tile+orientation combos matching a terrain request.
 * Used internally by findDefaultTile.
 */
function findMatchingTiles(
  request: TileRequest,
  tileset: TilesetInfo,
): TilePlacement[] {
  const results: TilePlacement[] = [];

  for (const tile of tileset.tiles) {
    if (tile.groupId !== null) continue;
    if (!tile.flat) continue;

    for (let ori = 0; ori < 4; ori++) {
      const corners = getRotatedCorners(tile, ori);
      const crossers = getRotatedCrossers(tile, ori);

      // Terrain: at least one corner should match
      if (request.terrain) {
        const allCorners = [corners.topLeft, corners.topRight, corners.bottomLeft, corners.bottomRight];
        if (!allCorners.some(c => c === request.terrain)) continue;
      }

      // No crossers — default tiles should be clean
      if (crossers.top || crossers.right || crossers.bottom || crossers.left) continue;

      results.push({ tileId: tile.id, orientation: ori });
    }
  }

  return results;
}

/**
 * Score a tile by how many corners match the requested terrain.
 * Higher = better (more uniform).
 */
function scoreTile(
  placement: TilePlacement,
  terrain: string,
  tileset: TilesetInfo,
): number {
  const tile = tileset.tiles[placement.tileId];
  if (!tile) return 0;
  const corners = getRotatedCorners(tile, placement.orientation);
  const allCorners = [corners.topLeft, corners.topRight, corners.bottomLeft, corners.bottomRight];
  let score = allCorners.filter(c => c === terrain).length * 10;
  if (tile.doors === 0) score += 1;
  return score;
}

// ─── Exported Functions ─────────────────────────────────────────────────────

/**
 * Validate a placed tile against all 4 neighbors, returning constraint violations.
 */
export function validateTilePlacement(
  grid: (TileGridEntry | null)[],
  x: number,
  y: number,
  width: number,
  height: number,
  tileset: TilesetInfo,
): string[] {
  const violations: string[] = [];
  const idx = y * width + x;
  const entry = grid[idx];
  if (!entry) return ["No tile at this position"];

  const tile = tileset.tiles[entry.tileId];
  if (!tile) return [`Unknown tile ID: ${entry.tileId}`];

  const corners = getRotatedCorners(tile, entry.orientation);
  const crossers = getRotatedCrossers(tile, entry.orientation);

  const getEntry = (gx: number, gy: number): TileGridEntry | null => {
    if (gx < 0 || gx >= width || gy < 0 || gy >= height) return null;
    return grid[gy * width + gx];
  };

  const checkNeighbor = (
    nx: number, ny: number,
    label: string,
    ourCorner1: string, ourCorner2: string,
    theirCorner1Key: keyof TileCorners, theirCorner2Key: keyof TileCorners,
    ourCrosser: string, theirCrosserKey: keyof TileCrossers,
  ) => {
    const neighbor = getEntry(nx, ny);
    if (!neighbor) return;
    const nTile = tileset.tiles[neighbor.tileId];
    if (!nTile) return;
    const nCorners = getRotatedCorners(nTile, neighbor.orientation);
    const nCrossers = getRotatedCrossers(nTile, neighbor.orientation);

    if (ourCorner1 !== nCorners[theirCorner1Key]) {
      violations.push(`${label}: corner mismatch (${ourCorner1} vs ${nCorners[theirCorner1Key]})`);
    }
    if (ourCorner2 !== nCorners[theirCorner2Key]) {
      violations.push(`${label}: corner mismatch (${ourCorner2} vs ${nCorners[theirCorner2Key]})`);
    }
    if (ourCrosser !== nCrossers[theirCrosserKey]) {
      violations.push(`${label}: crosser mismatch (${ourCrosser || "none"} vs ${nCrossers[theirCrosserKey] || "none"})`);
    }
  };

  checkNeighbor(x - 1, y, "Left", corners.topLeft, corners.bottomLeft, "topRight", "bottomRight", crossers.left, "right");
  checkNeighbor(x + 1, y, "Right", corners.topRight, corners.bottomRight, "topLeft", "bottomLeft", crossers.right, "left");
  checkNeighbor(x, y - 1, "Bottom", corners.bottomLeft, corners.bottomRight, "topLeft", "topRight", crossers.bottom, "top");
  checkNeighbor(x, y + 1, "Top", corners.topLeft, corners.topRight, "bottomLeft", "bottomRight", crossers.top, "bottom");

  return violations;
}

/**
 * Find the best default tile for an area: all corners = targetTerrain, no crossers.
 */
export function findDefaultTile(tileset: TilesetInfo, terrain?: string): TilePlacement | null {
  const targetTerrain = terrain || tileset.defaultTerrain || tileset.terrainTypes[0]?.name;
  if (!targetTerrain) return null;

  const matches = findMatchingTiles({ terrain: targetTerrain }, tileset);
  if (matches.length === 0) return null;

  // Pick the best-scoring match (most uniform terrain, no doors)
  let bestScore = -Infinity;
  let best: TilePlacement[] = [];
  for (const m of matches) {
    const score = scoreTile(m, targetTerrain, tileset);
    if (score > bestScore) {
      bestScore = score;
      best = [m];
    } else if (score === bestScore) {
      best.push(m);
    }
  }
  return best[Math.floor(Math.random() * best.length)];
}
