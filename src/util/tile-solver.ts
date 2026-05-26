/**
 * NWN tile utilities for default tile selection and placement validation.
 *
 * The main terrain solving logic is in zone-solver.ts (zone-based approach).
 * This file provides:
 * - findDefaultTile/findDefaultTileVariants: used by create_area for default fill
 * - validateTilePlacement: used by paint_tiles and paint_group to check neighbors
 *
 * Height tiles (any corner height > 0) are excluded from tile selection.
 */

import type { TileCorners, TileCrossers, TileDefinition, TilesetInfo } from "./tileset.js";
import { getRotatedCorners, getRotatedCrossers } from "./tileset.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface TilePlacement {
  tileId: number;
  orientation: number; // 0-3
}

export interface TileGridEntry {
  tileId: number;
  orientation: number;
}

export type DefaultTileFillMode = "safe" | "relaxed";

export interface DefaultTileVariant extends TilePlacement {
  score: number;
  terrainMatches: number;
  corners: TileCorners;
  crossers: TileCrossers;
  warnings: string[];
}

export interface DefaultTileGridWarning {
  x: number;
  y: number;
  tileId: number;
  orientation: number;
  message: string;
}

export interface DefaultTileGridResult {
  terrain: string;
  mode: DefaultTileFillMode;
  candidates: DefaultTileVariant[];
  placements: DefaultTileVariant[];
  warnings: DefaultTileGridWarning[];
}

// ─── Default Tile Matching ──────────────────────────────────────────────────

function resolveDefaultTerrain(tileset: TilesetInfo, terrain?: string): string | null {
  const resolved =
    terrain || tileset.defaultTerrain || tileset.terrainTypes[0]?.rawName || tileset.terrainTypes[0]?.name || null;
  return resolved ? resolved.toLowerCase() : null;
}

function crosserEntries(crossers: TileCrossers): string[] {
  return [
    crossers.top ? `top=${crossers.top}` : "",
    crossers.right ? `right=${crossers.right}` : "",
    crossers.bottom ? `bottom=${crossers.bottom}` : "",
    crossers.left ? `left=${crossers.left}` : "",
  ].filter(Boolean);
}

function scoreDefaultTileVariant(
  tile: TileDefinition,
  orientation: number,
  crossers: TileCrossers,
  terrainMatches: number,
  mode: DefaultTileFillMode,
): number {
  const hasCrossers = crosserEntries(crossers).length > 0;
  const naturalOrientation = Math.round(tile.orientation / 90) % 4;

  if (mode === "safe") {
    return 100 + (orientation === naturalOrientation ? 30 : 0) + (tile.doors === 0 ? 1 : 0);
  }

  let score = terrainMatches * 20;
  if (terrainMatches === 4) score += 35;
  if (!hasCrossers) score += 10;
  else score -= crosserEntries(crossers).length * 4;
  if (orientation === naturalOrientation) score += 12;

  // A fully matching, crosser-free tile remains preferred, but doors are not
  // scored here: callers can decide whether a door tile is useful.
  return score;
}

function makeDefaultTileWarnings(
  corners: TileCorners,
  crossers: TileCrossers,
  targetTerrain: string,
  terrainMatches: number,
): string[] {
  const warnings: string[] = [];
  if (terrainMatches < 4) {
    warnings.push(
      `Mixed terrain corners for '${targetTerrain}': TL=${corners.topLeft || "none"} TR=${corners.topRight || "none"} BL=${corners.bottomLeft || "none"} BR=${corners.bottomRight || "none"}`,
    );
  }
  const crosserWarnings = crosserEntries(crossers);
  if (crosserWarnings.length > 0) {
    warnings.push(`Crosser edges present: ${crosserWarnings.join(", ")}`);
  }
  return warnings;
}

function edgeCompatibilityScore(
  candidate: DefaultTileVariant,
  neighbor: DefaultTileVariant,
  edge: "left" | "bottom",
): number {
  if (edge === "left") {
    let score = 0;
    score += candidate.corners.topLeft === neighbor.corners.topRight ? 5 : -20;
    score += candidate.corners.bottomLeft === neighbor.corners.bottomRight ? 5 : -20;
    score += candidate.crossers.left === neighbor.crossers.right ? 4 : -24;
    return score;
  }

  let score = 0;
  score += candidate.corners.bottomLeft === neighbor.corners.topLeft ? 5 : -20;
  score += candidate.corners.bottomRight === neighbor.corners.topRight ? 5 : -20;
  score += candidate.crossers.bottom === neighbor.crossers.top ? 4 : -24;
  return score;
}

function repetitionPenalty(candidate: DefaultTileVariant, neighbor: DefaultTileVariant | null): number {
  if (!neighbor) return 0;
  if (candidate.tileId !== neighbor.tileId) return 0;
  return candidate.orientation === neighbor.orientation ? -18 : -10;
}

function pickBestScoredVariant(variants: DefaultTileVariant[], index: number, width: number): DefaultTileVariant {
  const pickIndex = (index + Math.floor(index / Math.max(width, 1))) % variants.length;
  return variants[pickIndex];
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
    nx: number,
    ny: number,
    label: string,
    ourCorner1: string,
    ourCorner2: string,
    theirCorner1Key: keyof TileCorners,
    theirCorner2Key: keyof TileCorners,
    ourCrosser: string,
    theirCrosserKey: keyof TileCrossers,
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
      violations.push(
        `${label}: crosser mismatch (${ourCrosser || "none"} vs ${nCrossers[theirCrosserKey] || "none"})`,
      );
    }
  };

  checkNeighbor(
    x - 1,
    y,
    "Left",
    corners.topLeft,
    corners.bottomLeft,
    "topRight",
    "bottomRight",
    crossers.left,
    "right",
  );
  checkNeighbor(
    x + 1,
    y,
    "Right",
    corners.topRight,
    corners.bottomRight,
    "topLeft",
    "bottomLeft",
    crossers.right,
    "left",
  );
  checkNeighbor(
    x,
    y - 1,
    "Bottom",
    corners.bottomLeft,
    corners.bottomRight,
    "topLeft",
    "topRight",
    crossers.bottom,
    "top",
  );
  checkNeighbor(
    x,
    y + 1,
    "Top",
    corners.topLeft,
    corners.topRight,
    "bottomLeft",
    "bottomRight",
    crossers.top,
    "bottom",
  );

  return violations;
}

/**
 * Find default-fill candidates for an area.
 *
 * Safe mode accepts only flat, non-group tiles whose four corners are the target
 * terrain and whose edges have no crossers. Relaxed mode also keeps partial
 * terrain/crosser candidates, scores them lower, and attaches warnings so
 * callers can report possible semantic cleanup points without blocking output.
 */
export function findDefaultTileVariants(
  tileset: TilesetInfo,
  terrain?: string,
  mode: DefaultTileFillMode = "relaxed",
): { terrain: string; variants: DefaultTileVariant[] } {
  const targetTerrain = resolveDefaultTerrain(tileset, terrain);
  if (!targetTerrain) return { terrain: "", variants: [] };

  const variants: DefaultTileVariant[] = [];

  for (const tile of tileset.tiles) {
    if (tile.groupId !== null) continue;
    if (!tile.flat) continue;

    for (let orientation = 0; orientation < 4; orientation++) {
      const corners = getRotatedCorners(tile, orientation);
      const crossers = getRotatedCrossers(tile, orientation);
      const allCorners = [corners.topLeft, corners.topRight, corners.bottomLeft, corners.bottomRight].map((corner) =>
        corner.toLowerCase(),
      );
      const terrainMatches = allCorners.filter((corner) => corner === targetTerrain).length;
      const hasCrossers = crosserEntries(crossers).length > 0;

      if (mode === "safe" && (terrainMatches !== 4 || hasCrossers)) continue;
      if (mode === "relaxed" && terrainMatches === 0) continue;

      variants.push({
        tileId: tile.id,
        orientation,
        score: scoreDefaultTileVariant(tile, orientation, crossers, terrainMatches, mode),
        terrainMatches,
        corners,
        crossers,
        warnings: mode === "relaxed" ? makeDefaultTileWarnings(corners, crossers, targetTerrain, terrainMatches) : [],
      });
    }
  }

  variants.sort((a, b) => b.score - a.score || a.tileId - b.tileId || a.orientation - b.orientation);
  return { terrain: targetTerrain, variants };
}

/**
 * Pick one default variant for a cell, preferring neighbor continuity first and
 * avoiding obvious adjacent repetition when multiple compatible variants exist.
 */
export function pickDefaultVariant(
  variants: DefaultTileVariant[],
  index: number,
  width: number,
  placed: Array<DefaultTileVariant | null>,
): DefaultTileVariant {
  const x = index % width;
  const y = Math.floor(index / width);
  const left = x > 0 ? placed[index - 1] : null;
  const bottom = y > 0 ? placed[index - width] : null;

  let bestScore = -Infinity;
  let best: DefaultTileVariant[] = [];
  for (const variant of variants) {
    let score = variant.score;
    if (left) score += edgeCompatibilityScore(variant, left, "left");
    if (bottom) score += edgeCompatibilityScore(variant, bottom, "bottom");
    score += repetitionPenalty(variant, left);
    score += repetitionPenalty(variant, bottom);

    if (score > bestScore) {
      bestScore = score;
      best = [variant];
    } else if (score === bestScore) {
      best.push(variant);
    }
  }

  return pickBestScoredVariant(best, index, width);
}

/**
 * Build a whole-area default tile grid using the variant pool.
 */
export function buildDefaultTileGrid(
  width: number,
  height: number,
  tileset: TilesetInfo,
  terrain?: string,
  mode: DefaultTileFillMode = "relaxed",
): DefaultTileGridResult | null {
  const { terrain: targetTerrain, variants } = findDefaultTileVariants(tileset, terrain, mode);
  if (!targetTerrain || variants.length === 0) return null;

  const placements: DefaultTileVariant[] = [];
  for (let index = 0; index < width * height; index++) {
    placements[index] = pickDefaultVariant(variants, index, width, placements);
  }

  const grid: TileGridEntry[] = placements.map((placement) => ({
    tileId: placement.tileId,
    orientation: placement.orientation,
  }));
  const warnings: DefaultTileGridWarning[] = [];

  for (let index = 0; index < placements.length; index++) {
    const x = index % width;
    const y = Math.floor(index / width);
    const placement = placements[index];
    for (const warning of placement.warnings) {
      warnings.push({ x, y, tileId: placement.tileId, orientation: placement.orientation, message: warning });
    }

    const violations = validateTilePlacement(grid, x, y, width, height, tileset);
    for (const violation of violations) {
      warnings.push({
        x,
        y,
        tileId: placement.tileId,
        orientation: placement.orientation,
        message: `Default fill continuity warning: ${violation}`,
      });
    }
  }

  return { terrain: targetTerrain, mode, candidates: variants, placements, warnings };
}

/**
 * Find the best default tile for an area: all corners = targetTerrain, no crossers.
 */
export function findDefaultTile(tileset: TilesetInfo, terrain?: string): TilePlacement | null {
  const { variants } = findDefaultTileVariants(tileset, terrain, "safe");
  if (variants.length === 0) return null;
  const bestScore = variants[0].score;
  const best = variants.filter((variant) => variant.score === bestScore);
  const picked = best[Math.floor(Math.random() * best.length)];
  return { tileId: picked.tileId, orientation: picked.orientation };
}
