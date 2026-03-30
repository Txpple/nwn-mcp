import { describe, it, expect } from "vitest";
import { toF, toI } from "./params.js";

describe("toF", () => {
  it("parses a string to float", () => {
    expect(toF("3.14")).toBeCloseTo(3.14);
  });

  it("parses an integer string to float", () => {
    expect(toF("42")).toBe(42);
  });

  it("passes through a number unchanged", () => {
    expect(toF(2.5)).toBe(2.5);
  });

  it("returns default when undefined", () => {
    expect(toF(undefined)).toBe(0);
  });

  it("returns custom default when undefined", () => {
    expect(toF(undefined, 99.5)).toBe(99.5);
  });

  it("handles negative values", () => {
    expect(toF("-7.3")).toBeCloseTo(-7.3);
  });

  it("handles zero string", () => {
    expect(toF("0")).toBe(0);
  });

  it("returns NaN for non-numeric strings", () => {
    expect(toF("abc")).toBeNaN();
  });

  it("handles empty string as NaN", () => {
    expect(toF("")).toBeNaN();
  });
});

describe("toI", () => {
  it("parses a string to integer", () => {
    expect(toI("42")).toBe(42);
  });

  it("truncates decimal strings", () => {
    expect(toI("3.7")).toBe(3);
  });

  it("passes through an integer number", () => {
    expect(toI(10)).toBe(10);
  });

  it("truncates a float number via parseInt", () => {
    // parseInt(String(5.9), 10) = parseInt("5.9", 10) = 5
    expect(toI(5.9)).toBe(5);
  });

  it("returns default when undefined", () => {
    expect(toI(undefined)).toBe(0);
  });

  it("returns custom default when undefined", () => {
    expect(toI(undefined, -1)).toBe(-1);
  });

  it("handles negative values", () => {
    expect(toI("-8")).toBe(-8);
  });

  it("handles zero string", () => {
    expect(toI("0")).toBe(0);
  });

  it("returns NaN for non-numeric strings", () => {
    expect(toI("abc")).toBeNaN();
  });
});
