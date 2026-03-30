import { describe, it, expect } from "vitest";
import { pointInTriangle2D, rotateForOrientation } from "./walkmesh.js";

describe("pointInTriangle2D", () => {
  // Simple right triangle with vertices at (0,0), (4,0), (0,4)
  const ax = 0, ay = 0;
  const bx = 4, by = 0;
  const cx = 0, cy = 4;

  it("detects a point clearly inside the triangle", () => {
    expect(pointInTriangle2D(1, 1, ax, ay, bx, by, cx, cy)).toBe(true);
  });

  it("detects a point clearly outside the triangle", () => {
    expect(pointInTriangle2D(3, 3, ax, ay, bx, by, cx, cy)).toBe(false);
  });

  it("detects a point on a vertex", () => {
    expect(pointInTriangle2D(0, 0, ax, ay, bx, by, cx, cy)).toBe(true);
  });

  it("detects a point on an edge (midpoint of hypotenuse)", () => {
    expect(pointInTriangle2D(2, 2, ax, ay, bx, by, cx, cy)).toBe(true);
  });

  it("detects a point just outside the hypotenuse", () => {
    expect(pointInTriangle2D(2.1, 2.1, ax, ay, bx, by, cx, cy)).toBe(false);
  });

  it("returns false for a degenerate (zero-area) triangle", () => {
    // All three points collinear
    expect(pointInTriangle2D(1, 1, 0, 0, 2, 2, 4, 4)).toBe(false);
  });

  it("works for a unit square diagonal triangle", () => {
    // Triangle (0,0), (1,0), (0,1)
    expect(pointInTriangle2D(0.2, 0.2, 0, 0, 1, 0, 0, 1)).toBe(true);
    expect(pointInTriangle2D(0.6, 0.6, 0, 0, 1, 0, 0, 1)).toBe(false);
  });
});

describe("rotateForOrientation", () => {
  // Orientation semantics (inverse rotation, world→local):
  //   0 = identity
  //   1 = inverse of 90° CW → (y, -x)
  //   2 = 180° → (-x, -y)
  //   3 = inverse of 270° CW → (-y, x)

  it("orientation 0 is identity", () => {
    const [rx, ry] = rotateForOrientation(3, 4, 0);
    expect(rx).toBe(3);
    expect(ry).toBe(4);
  });

  it("orientation 1 applies inverse 90° CW: (x,y) → (y,-x)", () => {
    const [rx, ry] = rotateForOrientation(3, 4, 1);
    expect(rx).toBe(4);
    expect(ry).toBe(-3);
  });

  it("orientation 2 applies 180°: (x,y) → (-x,-y)", () => {
    const [rx, ry] = rotateForOrientation(3, 4, 2);
    expect(rx).toBe(-3);
    expect(ry).toBe(-4);
  });

  it("orientation 3 applies inverse 270° CW: (x,y) → (-y,x)", () => {
    const [rx, ry] = rotateForOrientation(3, 4, 3);
    expect(rx).toBe(-4);
    expect(ry).toBe(3);
  });

  it("orientation wraps modulo 4", () => {
    const [rx, ry] = rotateForOrientation(3, 4, 4); // same as 0
    expect(rx).toBe(3);
    expect(ry).toBe(4);
  });

  it("identity on (0,0) for all orientations", () => {
    for (let o = 0; o < 4; o++) {
      const [rx, ry] = rotateForOrientation(0, 0, o);
      // Use + 0 to normalize -0 to +0 before comparison
      expect(rx + 0).toBe(0);
      expect(ry + 0).toBe(0);
    }
  });

  it("double-applying orientation 2 is identity", () => {
    const [rx, ry] = rotateForOrientation(3, 4, 2);
    const [rx2, ry2] = rotateForOrientation(rx, ry, 2);
    expect(rx2).toBe(3);
    expect(ry2).toBe(4);
  });
});
