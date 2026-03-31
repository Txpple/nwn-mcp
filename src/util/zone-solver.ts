/**
 * Zone-based terrain solver for NWN area tile painting.
 *
 * The LLM specifies terrain zones (regions of tiles) and crosser paths
 * (streams/roads with edge specs). The solver:
 *
 * 1. Builds a (W+1)x(H+1) corner terrain grid from zones
 * 2. Builds a crosser edge grid from paths
 * 3. Looks up each tile by exact corner+crosser match from the tileset
 *
 * No fixup cascade needed — transitions are inherent because adjacent tiles
 * share corner grid points. This mirrors how the NWN toolset internally
 * resolves terrain painting.
 */

import type { TilesetInfo, TileCorners, TileCrossers } from "./tileset.js";
import type { TilePlacement } from "./tile-solver.js";
import { getRotatedCorners, getRotatedCrossers } from "./tileset.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface TerrainZone {
  terrain: string;
  tiles: Array<{ x: number; y: number }>;
}

export interface CrosserPath {
  type: string;
  path: Array<{
    x: number;
    y: number;
    edges: { top?: boolean; right?: boolean; bottom?: boolean; left?: boolean };
  }>;
}

export interface FeatureTile {
  x: number;
  y: number;
  tileId: number;
  orientation: number;
}

export interface ZoneSolverResult {
  placements: Array<{
    x: number;
    y: number;
    tileId: number;
    orientation: number;
  }>;
  warnings: Array<{
    x: number;
    y: number;
    message: string;
  }>;
}

interface CrosserEdges {
  top: string;
  right: string;
  bottom: string;
  left: string;
}

// ─── Corner Grid ────────────────────────────────────────────────────────────

/**
 * Build the (W+1)x(H+1) corner terrain grid.
 *
 * Each tile (tx,ty) has corners:
 *   BL = corner(tx, ty)     BR = corner(tx+1, ty)
 *   TL = corner(tx, ty+1)   TR = corner(tx+1, ty+1)
 *
 * Algorithm:
 * 1. Fill all corners with defaultTerrain
 * 2. Lock feature tile corners (zones cannot override these)
 * 3. Apply zone corners in order (later zones win at shared boundaries)
 */
export function buildCornerGrid(
  width: number,
  height: number,
  defaultTerrain: string,
  zones: TerrainZone[],
  features: FeatureTile[],
  tileset: TilesetInfo,
): string[] {
  const cw = width + 1;
  const ch = height + 1;
  const grid = new Array<string>(cw * ch).fill(defaultTerrain);
  const locked = new Set<number>();

  // Helper to get/set corner
  const idx = (cx: number, cy: number) => cy * cw + cx;

  // Lock feature tile corners
  for (const f of features) {
    const tile = tileset.tiles[f.tileId];
    if (!tile) continue;
    const c = getRotatedCorners(tile, f.orientation);

    const corners: Array<[number, number, string]> = [
      [f.x,     f.y,     c.bottomLeft.toLowerCase()],
      [f.x + 1, f.y,     c.bottomRight.toLowerCase()],
      [f.x,     f.y + 1, c.topLeft.toLowerCase()],
      [f.x + 1, f.y + 1, c.topRight.toLowerCase()],
    ];
    for (const [cx, cy, terrain] of corners) {
      if (cx >= 0 && cx < cw && cy >= 0 && cy < ch) {
        const i = idx(cx, cy);
        grid[i] = terrain;
        locked.add(i);
      }
    }
  }

  // Apply zones in order — later zones win at shared boundaries
  for (const zone of zones) {
    for (const { x, y } of zone.tiles) {
      if (x < 0 || x >= width || y < 0 || y >= height) continue;

      const corners = [
        idx(x, y), idx(x + 1, y),
        idx(x, y + 1), idx(x + 1, y + 1),
      ];
      for (const i of corners) {
        if (!locked.has(i)) {
          grid[i] = zone.terrain;
        }
      }
    }
  }

  return grid;
}

// ─── Crosser Grid ───────────────────────────────────────────────────────────

/**
 * Build per-tile crosser edge grid.
 * Each tile gets 4 edge values (empty string = no crosser).
 */
export function buildCrosserGrid(
  width: number,
  height: number,
  crossers: CrosserPath[],
): CrosserEdges[] {
  const grid: CrosserEdges[] = [];
  for (let i = 0; i < width * height; i++) {
    grid.push({ top: "", right: "", bottom: "", left: "" });
  }

  for (const path of crossers) {
    for (const { x, y, edges } of path.path) {
      if (x < 0 || x >= width || y < 0 || y >= height) continue;
      const entry = grid[y * width + x];
      if (edges.top) entry.top = path.type;
      if (edges.right) entry.right = path.type;
      if (edges.bottom) entry.bottom = path.type;
      if (edges.left) entry.left = path.type;
    }
  }

  // Propagate crossers across shared edges so the user doesn't have to
  // specify both sides of every edge.  Propagation is unconditional — if
  // tile A has Bridge on its right edge, the neighbor's left gets Bridge.
  // This allows bridge-over-pit to connect to Floor boundary tiles (e.g.,
  // Pit/Floor/Pit/Floor tiles with L:Bridge exist in most tilesets).
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      const e = grid[idx];
      // Propagate right ↔ left
      if (x + 1 < width) {
        const neighbor = grid[idx + 1];
        if (e.right && !neighbor.left) neighbor.left = e.right;
        else if (neighbor.left && !e.right) e.right = neighbor.left;
      }
      // Propagate top ↔ bottom
      if (y + 1 < height) {
        const neighbor = grid[(y + 1) * width + x];
        if (e.top && !neighbor.bottom) neighbor.bottom = e.top;
        else if (neighbor.bottom && !e.top) e.top = neighbor.bottom;
      }
    }
  }

  return grid;
}

// ─── Tile Lookup ────────────────────────────────────────────────────────────

/**
 * Find a tile+orientation matching exact corners and crossers.
 * Picks randomly among matches for visual variety.
 * Prefers tiles without doors.
 */
export function findTileByCorners(
  wantCorners: { tl: string; tr: string; bl: string; br: string },
  wantCrossers: CrosserEdges,
  tileset: TilesetInfo,
): TilePlacement | null {
  const matches: TilePlacement[] = [];

  for (const tile of tileset.tiles) {
    if (tile.groupId !== null) continue;
    if (!tile.flat) continue;

    for (let ori = 0; ori < 4; ori++) {
      const c = getRotatedCorners(tile, ori);
      if (c.topLeft.toLowerCase() !== wantCorners.tl.toLowerCase()) continue;
      if (c.topRight.toLowerCase() !== wantCorners.tr.toLowerCase()) continue;
      if (c.bottomLeft.toLowerCase() !== wantCorners.bl.toLowerCase()) continue;
      if (c.bottomRight.toLowerCase() !== wantCorners.br.toLowerCase()) continue;

      const cr = getRotatedCrossers(tile, ori);
      if (cr.top.toLowerCase() !== wantCrossers.top.toLowerCase()) continue;
      if (cr.right.toLowerCase() !== wantCrossers.right.toLowerCase()) continue;
      if (cr.bottom.toLowerCase() !== wantCrossers.bottom.toLowerCase()) continue;
      if (cr.left.toLowerCase() !== wantCrossers.left.toLowerCase()) continue;

      matches.push({ tileId: tile.id, orientation: ori });
    }
  }

  if (matches.length === 0) return null;

  // Prefer tiles without doors for simpler geometry
  const noDoors = matches.filter(m => tileset.tiles[m.tileId].doors === 0);
  const pool = noDoors.length > 0 ? noDoors : matches;
  return pool[Math.floor(Math.random() * pool.length)];
}

// ─── Area Solver ────────────────────────────────────────────────────────────

/**
 * Solve the entire area tile grid from zones + crosser paths.
 *
 * Feature tiles are preserved (never overwritten). All other tiles are
 * resolved from the corner grid + crosser grid by exact tileset lookup.
 */
export function solveArea(
  width: number,
  height: number,
  defaultTerrain: string,
  tileset: TilesetInfo,
  zones: TerrainZone[],
  crossers: CrosserPath[],
  features: FeatureTile[],
): ZoneSolverResult {
  // Normalize terrain/crosser names to lowercase for case-insensitive matching
  const lcDefault = defaultTerrain.toLowerCase();
  const lcZones = zones.map(z => ({ ...z, terrain: z.terrain.toLowerCase() }));
  const lcCrossers = crossers.map(c => ({ ...c, type: c.type.toLowerCase() }));

  const cornerGrid = buildCornerGrid(width, height, lcDefault, lcZones, features, tileset);
  const crosserGrid = buildCrosserGrid(width, height, lcCrossers);

  // Collect only terrains that actually appear in the corner grid.
  // fallbackSubstitute must never inject terrains outside this set.
  const allowedTerrains = new Set<string>();
  for (const t of cornerGrid) allowedTerrains.add(t);

  const cw = width + 1;
  const cornerAt = (cx: number, cy: number) => cornerGrid[cy * cw + cx];

  // ── Pre-solve adjacency validation ──────────────────────────────────
  // Build the set of valid terrain pairs from the tileset's flat, non-group
  // tiles.  Two terrains can be adjacent only if some tile has both in its
  // corners.  If the corner grid contains an adjacent pair not in this set,
  // the zone layout is invalid and will produce broken tiles.
  const validPairs = new Set<string>();
  for (const tile of tileset.tiles) {
    if (tile.groupId !== null || !tile.flat) continue;
    const c = [tile.corners.topLeft.toLowerCase(), tile.corners.topRight.toLowerCase(),
               tile.corners.bottomLeft.toLowerCase(), tile.corners.bottomRight.toLowerCase()];
    for (let i = 0; i < c.length; i++) {
      for (let j = i + 1; j < c.length; j++) {
        if (c[i] !== c[j]) {
          validPairs.add(`${c[i]}|${c[j]}`);
          validPairs.add(`${c[j]}|${c[i]}`);
        }
      }
    }
  }

  // Check every adjacent corner pair in the grid for compatibility
  const adjacencyErrors: Array<{ x: number; y: number; message: string }> = [];
  const reportedPairs = new Set<string>();
  for (let cy = 0; cy < height + 1; cy++) {
    for (let cx = 0; cx < cw; cx++) {
      const t = cornerAt(cx, cy);
      // Check right neighbor
      if (cx + 1 < cw) {
        const r = cornerAt(cx + 1, cy);
        if (t !== r && !validPairs.has(`${t}|${r}`)) {
          const pairKey = `${t}|${r}`;
          if (!reportedPairs.has(pairKey)) {
            reportedPairs.add(pairKey);
            adjacencyErrors.push({ x: cx, y: cy,
              message: `INCOMPATIBLE TERRAIN ADJACENCY: '${t}' and '${r}' have no transition tiles in this tileset. Add an intermediate terrain zone between them.` });
          }
        }
      }
      // Check top neighbor
      if (cy + 1 < height + 1) {
        const u = cornerAt(cx, cy + 1);
        if (t !== u && !validPairs.has(`${t}|${u}`)) {
          const pairKey = `${t}|${u}`;
          if (!reportedPairs.has(pairKey)) {
            reportedPairs.add(pairKey);
            adjacencyErrors.push({ x: cx, y: cy,
              message: `INCOMPATIBLE TERRAIN ADJACENCY: '${t}' and '${u}' have no transition tiles in this tileset. Add an intermediate terrain zone between them.` });
          }
        }
      }
    }
  }

  if (adjacencyErrors.length > 0) {
    // Return early with ONLY the adjacency errors — do not solve.
    // This forces the caller to fix the zone layout before proceeding.
    return { placements: [], warnings: adjacencyErrors };
  }

  // Trim crossers from terrain-boundary tiles.  A tile that mixes default
  // terrain with non-default terrain is at a zone edge — crossers should NOT
  // extend into these tiles because they need proper end-cap tiles one
  // row/column earlier.  Tiles that are uniformly default terrain keep their
  // crossers (they're valid crosser hosts, not boundaries).
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const bl = cornerAt(x, y);
      const br = cornerAt(x + 1, y);
      const tl = cornerAt(x, y + 1);
      const tr = cornerAt(x + 1, y + 1);
      const hasDefault = bl === lcDefault || br === lcDefault || tl === lcDefault || tr === lcDefault;
      const allDefault = bl === lcDefault && br === lcDefault && tl === lcDefault && tr === lcDefault;
      if (hasDefault && !allDefault) {
        const idx = y * width + x;
        const e = crosserGrid[idx];
        // Clear neighbor's matching edge before clearing ours
        if (e.top && y + 1 < height) crosserGrid[(y + 1) * width + x].bottom = "";
        if (e.bottom && y > 0) crosserGrid[(y - 1) * width + x].top = "";
        if (e.right && x + 1 < width) crosserGrid[y * width + x + 1].left = "";
        if (e.left && x > 0) crosserGrid[y * width + x - 1].right = "";
        e.top = ""; e.right = ""; e.bottom = ""; e.left = "";
      }
    }
  }

  // Build feature index set for quick lookup
  const featureSet = new Set<number>();
  for (const f of features) {
    featureSet.add(f.y * width + f.x);
  }

  const placements: ZoneSolverResult["placements"] = [];
  const warnings: ZoneSolverResult["warnings"] = [];

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;

      // Skip feature tiles
      if (featureSet.has(idx)) continue;

      const wantCorners = {
        tl: cornerAt(x, y + 1),
        tr: cornerAt(x + 1, y + 1),
        bl: cornerAt(x, y),
        br: cornerAt(x + 1, y),
      };
      const wantCrossers = crosserGrid[idx];

      let placement = findTileByCorners(wantCorners, wantCrossers, tileset);

      if (!placement) {
        const hasCrossers = wantCrossers.top || wantCrossers.right || wantCrossers.bottom || wantCrossers.left;
        if (hasCrossers) {
          const noCrossers = { top: "", right: "", bottom: "", left: "" };
          const allSameCorner = wantCorners.tl === wantCorners.tr &&
                                wantCorners.tr === wantCorners.bl &&
                                wantCorners.bl === wantCorners.br;

          if (allSameCorner) {
            // Uniform corners (e.g., all-Floor room tile with propagated
            // Corridor crosser).  Drop crossers to preserve terrain, since
            // the crosser was likely propagated and no matching tile exists.
            placement = findTileByCorners(wantCorners, noCrossers, tileset);
            if (placement) {
              warnings.push({ x, y, message: `No tile for corners+crossers; dropped crossers` });
            }
            // If still no match, try substituting corners with crossers
            if (!placement) {
              placement = fallbackSubstitute(wantCorners, wantCrossers, allowedTerrains, tileset);
              if (placement) {
                warnings.push({ x, y, message: `Substituted corners to preserve crossers (wanted TL=${wantCorners.tl} TR=${wantCorners.tr} BL=${wantCorners.bl} BR=${wantCorners.br})` });
              }
            }
          } else {
            // Mixed corners (e.g., terrain boundary with crosser).
            // Priority: exact corners > substituted corners, because
            // preserving the terrain boundary is more important than
            // keeping a (likely propagated) crosser.

            // Check if exact corners + no crossers works as a baseline
            const exactNoCrossers = findTileByCorners(wantCorners, noCrossers, tileset);

            // Try partial crosser subsets (exact corners first, then sub)
            const edges: Array<"top" | "right" | "bottom" | "left"> = ["top", "right", "bottom", "left"];
            const activeEdges = edges.filter(e => wantCrossers[e]);
            if (activeEdges.length > 1) {
              for (const edge of activeEdges) {
                const partial: CrosserEdges = { top: "", right: "", bottom: "", left: "" };
                partial[edge] = wantCrossers[edge];
                // Exact corners + partial crosser — best possible outcome
                placement = findTileByCorners(wantCorners, partial, tileset);
                if (placement) {
                  warnings.push({ x, y, message: `Partial crossers (kept ${edge})` });
                  break;
                }
              }
            }

            // Exact corners + single crosser (when only 1 active edge)
            if (!placement && activeEdges.length === 1) {
              placement = findTileByCorners(wantCorners, wantCrossers, tileset);
              // (already tried in step 0, but making logic explicit)
            }

            // If no exact-corner crosser match exists, prefer exact
            // corners with no crossers over substituted corners with
            // crossers — preserves terrain boundaries (room/pit edges)
            if (!placement && exactNoCrossers) {
              placement = exactNoCrossers;
              warnings.push({ x, y, message: `No tile for corners+crossers; dropped crossers` });
            }

            // Last resort: substitute corners to keep crossers
            if (!placement) {
              // Try partial crossers with corner substitution
              if (activeEdges.length > 1) {
                for (const edge of activeEdges) {
                  const partial: CrosserEdges = { top: "", right: "", bottom: "", left: "" };
                  partial[edge] = wantCrossers[edge];
                  placement = fallbackSubstitute(wantCorners, partial, allowedTerrains, tileset);
                  if (placement) {
                    warnings.push({ x, y, message: `Substituted corners + partial crossers (kept ${edge})` });
                    break;
                  }
                }
              }
              if (!placement) {
                placement = fallbackSubstitute(wantCorners, wantCrossers, allowedTerrains, tileset);
                if (placement) {
                  warnings.push({ x, y, message: `Substituted corners to preserve crossers (wanted TL=${wantCorners.tl} TR=${wantCorners.tr} BL=${wantCorners.bl} BR=${wantCorners.br})` });
                }
              }
            }
          }
        }
      }

      if (!placement) {
        // Fallback 3: try substituting corners without crossers
        placement = fallbackSubstitute(wantCorners, wantCrossers, allowedTerrains, tileset);
        if (!placement) {
          const noCrossers = { top: "", right: "", bottom: "", left: "" };
          placement = fallbackSubstitute(wantCorners, noCrossers, allowedTerrains, tileset);
        }
        if (placement) {
          warnings.push({ x, y, message: `Corner combo not in tileset; substituted corners (wanted TL=${wantCorners.tl} TR=${wantCorners.tr} BL=${wantCorners.bl} BR=${wantCorners.br})` });
        }
      }

      if (!placement) {
        // Ultimate fallback: all default terrain, no crossers
        placement = findTileByCorners(
          { tl: lcDefault, tr: lcDefault, bl: lcDefault, br: lcDefault },
          { top: "", right: "", bottom: "", left: "" },
          tileset,
        );
        if (placement) {
          warnings.push({ x, y, message: `No compatible transition tile using zone-defined terrains; fell back to default terrain '${lcDefault}' (wanted TL=${wantCorners.tl} TR=${wantCorners.tr} BL=${wantCorners.bl} BR=${wantCorners.br})` });
        }
      }

      if (placement) {
        placements.push({ x, y, tileId: placement.tileId, orientation: placement.orientation });
      } else {
        warnings.push({ x, y, message: `No tile found at all — this should never happen if the tileset has a default tile` });
      }
    }
  }

  // Validate crosser continuity between adjacent tiles
  const crosserWarnings = validateCrosserContinuity(width, height, crosserGrid, placements, features, tileset);
  warnings.push(...crosserWarnings);

  return { placements, warnings };
}

// ─── Fallback ───────────────────────────────────────────────────────────────

/**
 * Try substituting corners to find a tile match, preferring fewest changes.
 * Tries the defaultTerrain first, then each terrain present in the corners
 * (handles cases like Bridge-over-Pit where Floor corners need to become Pit).
 */
function fallbackSubstitute(
  corners: { tl: string; tr: string; bl: string; br: string },
  crossers: CrosserEdges,
  allowedTerrains: Set<string>,
  tileset: TilesetInfo,
): TilePlacement | null {
  const keys: Array<"tl" | "tr" | "bl" | "br"> = ["tl", "tr", "bl", "br"];

  // Only try terrains that appear in the corner grid (zone-defined + default).
  // Never inject a terrain that wasn't requested in the zone definitions.
  const terrainsToTry = [...allowedTerrains];

  for (const subTerrain of terrainsToTry) {
    // Try substituting 1 corner
    for (const key of keys) {
      if (corners[key] === subTerrain) continue;
      const modified = { ...corners, [key]: subTerrain };
      const result = findTileByCorners(modified, crossers, tileset);
      if (result) return result;
    }

    // Try substituting 2 corners
    for (let i = 0; i < keys.length; i++) {
      for (let j = i + 1; j < keys.length; j++) {
        if (corners[keys[i]] === subTerrain && corners[keys[j]] === subTerrain) continue;
        const modified = { ...corners, [keys[i]]: subTerrain, [keys[j]]: subTerrain };
        const result = findTileByCorners(modified, crossers, tileset);
        if (result) return result;
      }
    }

    // Try substituting 3 corners
    for (let skip = 0; skip < keys.length; skip++) {
      const modified = { ...corners };
      for (let i = 0; i < keys.length; i++) {
        if (i !== skip) modified[keys[i]] = subTerrain;
      }
      const result = findTileByCorners(modified, crossers, tileset);
      if (result) return result;
    }

    // Try all 4 corners to this terrain
    const allSame = { tl: subTerrain, tr: subTerrain, bl: subTerrain, br: subTerrain };
    if (allSame.tl !== corners.tl || allSame.tr !== corners.tr ||
        allSame.bl !== corners.bl || allSame.br !== corners.br) {
      const result = findTileByCorners(allSame, crossers, tileset);
      if (result) return result;
    }
  }

  return null;
}

// ─── Crosser Validation ─────────────────────────────────────────────────────

/**
 * Check that crosser edges match between adjacent tiles.
 * A crosser on one tile's right edge should have a matching crosser
 * on the neighbor's left edge.
 */
function validateCrosserContinuity(
  width: number,
  height: number,
  crosserGrid: CrosserEdges[],
  placements: ZoneSolverResult["placements"],
  features: FeatureTile[],
  tileset: TilesetInfo,
): Array<{ x: number; y: number; message: string }> {
  const warnings: Array<{ x: number; y: number; message: string }> = [];

  // Build resolved crosser map: actual crossers on placed tiles
  const resolvedCrossers = new Map<number, TileCrossers>();
  for (const p of placements) {
    const tile = tileset.tiles[p.tileId];
    if (tile) {
      resolvedCrossers.set(p.y * width + p.x, getRotatedCrossers(tile, p.orientation));
    }
  }
  for (const f of features) {
    const tile = tileset.tiles[f.tileId];
    if (tile) {
      resolvedCrossers.set(f.y * width + f.x, getRotatedCrossers(tile, f.orientation));
    }
  }

  // Check horizontal adjacency (right edge of x matches left edge of x+1)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width - 1; x++) {
      const left = resolvedCrossers.get(y * width + x);
      const right = resolvedCrossers.get(y * width + x + 1);
      if (left && right && left.right !== right.left) {
        warnings.push({ x, y, message: `Crosser mismatch: (${x},${y}).right="${left.right}" vs (${x + 1},${y}).left="${right.left}"` });
      }
    }
  }

  // Check vertical adjacency (top edge of y matches bottom edge of y+1)
  for (let y = 0; y < height - 1; y++) {
    for (let x = 0; x < width; x++) {
      const bottom = resolvedCrossers.get(y * width + x);
      const top = resolvedCrossers.get((y + 1) * width + x);
      if (bottom && top && bottom.top !== top.bottom) {
        warnings.push({ x, y, message: `Crosser mismatch: (${x},${y}).top="${bottom.top}" vs (${x},${y + 1}).bottom="${top.bottom}"` });
      }
    }
  }

  return warnings;
}
