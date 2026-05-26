import type { TileGroup } from "./tileset.js";

export const GROUP_TRANSFORMS = ["none", "rotate90", "rotate180", "rotate270"] as const;

export type GroupTransform = (typeof GROUP_TRANSFORMS)[number];
export type GroupTransformRequest = GroupTransform | "random";

export interface TransformedGroupDimensions {
  columns: number;
  rows: number;
}

export interface TransformedGroupPlacement {
  gx: number;
  gy: number;
  tileId: number;
  orientation: number;
  sourceCol: number;
  sourceRow: number;
  localCol: number;
  localRow: number;
}

export function isGroupTransform(value: string): value is GroupTransform {
  return (GROUP_TRANSFORMS as readonly string[]).includes(value);
}

export function parseGroupTransformRequest(value: string | undefined): GroupTransformRequest | null {
  if (!value) return "none";
  const normalized = value.toLowerCase();
  if (normalized === "random") return "random";
  if (isGroupTransform(normalized)) return normalized;
  return null;
}

export function getGroupTransformDimensions(group: TileGroup, transform: GroupTransform): TransformedGroupDimensions {
  switch (transform) {
    case "rotate90":
    case "rotate270":
      return { columns: group.rows, rows: group.columns };
    case "none":
    case "rotate180":
      return { columns: group.columns, rows: group.rows };
  }
}

export function getTransformedGroupPlacements(
  group: TileGroup,
  x: number,
  y: number,
  transform: GroupTransform,
): TransformedGroupPlacement[] {
  const placements: TransformedGroupPlacement[] = [];

  for (let sourceRow = 0; sourceRow < group.rows; sourceRow++) {
    for (let sourceCol = 0; sourceCol < group.columns; sourceCol++) {
      const tileId = group.tileIds[sourceRow * group.columns + sourceCol];
      if (tileId < 0) continue;

      const { localCol, localRow, orientation } = transformGroupCell(
        sourceCol,
        sourceRow,
        group.columns,
        group.rows,
        transform,
      );

      placements.push({
        gx: x + localCol,
        gy: y + localRow,
        tileId,
        orientation,
        sourceCol,
        sourceRow,
        localCol,
        localRow,
      });
    }
  }

  return placements;
}

export function pickRandomGroupTransform(transforms: GroupTransform[]): GroupTransform {
  return transforms[Math.floor(Math.random() * transforms.length)] ?? "none";
}

function transformGroupCell(
  sourceCol: number,
  sourceRow: number,
  columns: number,
  rows: number,
  transform: GroupTransform,
): { localCol: number; localRow: number; orientation: number } {
  switch (transform) {
    case "none":
      return { localCol: sourceCol, localRow: sourceRow, orientation: 0 };
    case "rotate90":
      return { localCol: sourceRow, localRow: columns - 1 - sourceCol, orientation: 1 };
    case "rotate180":
      return { localCol: columns - 1 - sourceCol, localRow: rows - 1 - sourceRow, orientation: 2 };
    case "rotate270":
      return { localCol: rows - 1 - sourceRow, localRow: sourceCol, orientation: 3 };
  }
}
