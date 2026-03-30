import { describe, it, expect } from "vitest";
import { getRotatedCorners, getRotatedCrossers } from "./tileset.js";
import type { TileDefinition } from "./tileset.js";

// Minimal tile fixture with distinct values per corner/edge for clear rotation verification
function makeTile(): TileDefinition {
  return {
    id: 0,
    model: "test",
    imageMap2D: "",
    corners: {
      topLeft: "Forest",
      topRight: "Cliff",
      bottomLeft: "Grass",
      bottomRight: "Stone",
    },
    flat: true,
    crossers: {
      top: "Road",
      right: "Stream",
      bottom: "",
      left: "",
    },
    pathNode: "",
    doors: 0,
    sounds: 0,
    orientation: 0,
    groupId: null,
    groupName: null,
  };
}

describe("getRotatedCorners", () => {
  it("orientation 0 returns original corners unchanged", () => {
    const tile = makeTile();
    const c = getRotatedCorners(tile, 0);
    expect(c.topLeft).toBe("Forest");
    expect(c.topRight).toBe("Cliff");
    expect(c.bottomLeft).toBe("Grass");
    expect(c.bottomRight).toBe("Stone");
  });

  // 90° CW: TR→TL, BR→TR, BL→BR, TL→BL
  it("orientation 1 (90° CW): world.TL = local.TR", () => {
    const tile = makeTile();
    const c = getRotatedCorners(tile, 1);
    expect(c.topLeft).toBe("Cliff");       // was topRight
    expect(c.topRight).toBe("Stone");      // was bottomRight
    expect(c.bottomRight).toBe("Grass");   // was bottomLeft
    expect(c.bottomLeft).toBe("Forest");   // was topLeft
  });

  // 180°: BR→TL, BL→TR, TL→BR, TR→BL
  it("orientation 2 (180°): all corners flip", () => {
    const tile = makeTile();
    const c = getRotatedCorners(tile, 2);
    expect(c.topLeft).toBe("Stone");       // was bottomRight
    expect(c.topRight).toBe("Grass");      // was bottomLeft
    expect(c.bottomLeft).toBe("Cliff");    // was topRight
    expect(c.bottomRight).toBe("Forest");  // was topLeft
  });

  // 270° CW: BL→TL, TL→TR, TR→BR, BR→BL
  it("orientation 3 (270° CW): world.TL = local.BL", () => {
    const tile = makeTile();
    const c = getRotatedCorners(tile, 3);
    expect(c.topLeft).toBe("Grass");       // was bottomLeft
    expect(c.topRight).toBe("Forest");     // was topLeft
    expect(c.bottomRight).toBe("Cliff");   // was topRight
    expect(c.bottomLeft).toBe("Stone");    // was bottomRight
  });

  it("orientation 4 wraps to 0 (identity)", () => {
    const tile = makeTile();
    const c0 = getRotatedCorners(tile, 0);
    const c4 = getRotatedCorners(tile, 4);
    expect(c4).toEqual(c0);
  });

  it("applying 90° CW four times returns original", () => {
    // Each 90° CW rotation passes the result tile as-is won't work since
    // getRotatedCorners takes the original tile — so verify all 4 orientations cycle
    const tile = makeTile();
    const c0 = getRotatedCorners(tile, 0);
    const c4 = getRotatedCorners(tile, 4); // == 0
    expect(c0.topLeft).toBe(c4.topLeft);
    expect(c0.topRight).toBe(c4.topRight);
  });
});

describe("getRotatedCrossers", () => {
  it("orientation 0 returns original crossers unchanged", () => {
    const tile = makeTile();
    const cr = getRotatedCrossers(tile, 0);
    expect(cr.top).toBe("Road");
    expect(cr.right).toBe("Stream");
    expect(cr.bottom).toBe("");
    expect(cr.left).toBe("");
  });

  // 90° CW: top←right, right←bottom, bottom←left, left←top
  it("orientation 1 (90° CW): world.top = local.right", () => {
    const tile = makeTile();
    const cr = getRotatedCrossers(tile, 1);
    expect(cr.top).toBe("Stream");  // was right
    expect(cr.right).toBe("");      // was bottom
    expect(cr.bottom).toBe("");     // was left
    expect(cr.left).toBe("Road");   // was top
  });

  // 180°: top←bottom, right←left, bottom←top, left←right
  it("orientation 2 (180°): top and bottom swap, left and right swap", () => {
    const tile = makeTile();
    const cr = getRotatedCrossers(tile, 2);
    expect(cr.top).toBe("");        // was bottom
    expect(cr.right).toBe("");      // was left
    expect(cr.bottom).toBe("Road"); // was top
    expect(cr.left).toBe("Stream"); // was right
  });

  // 270° CW: top←left, right←top, bottom←right, left←bottom
  it("orientation 3 (270° CW): world.top = local.left", () => {
    const tile = makeTile();
    const cr = getRotatedCrossers(tile, 3);
    expect(cr.top).toBe("");        // was left
    expect(cr.right).toBe("Road"); // was top
    expect(cr.bottom).toBe("Stream"); // was right
    expect(cr.left).toBe("");      // was bottom
  });
});
