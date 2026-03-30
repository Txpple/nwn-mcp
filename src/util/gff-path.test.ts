import { describe, it, expect } from "vitest";
import { getGffByPath, setGffByPath } from "./gff-path.js";
import type { GffDocument, GffObj } from "../types/gff.js";

// Minimal GFF document fixtures
function makeDoc(): GffDocument {
  return {
    Tag: { type: "cexostring", value: "MY_TAG" },
    ChallengeRating: { type: "float", value: 3.5 },
    FactionID: { type: "dword", value: 1 },
    ClassList: {
      type: "list",
      value: [
        {
          __struct_id: 0,
          Class: { type: "int", value: 1 },
          ClassLevel: { type: "short", value: 5 },
        },
        {
          __struct_id: 0,
          Class: { type: "int", value: 4 },
          ClassLevel: { type: "short", value: 2 },
        },
      ],
    },
    Nested: {
      type: "struct",
      value: {
        __struct_id: 0,
        Inner: { type: "cexostring", value: "deep" },
      },
    },
  } as unknown as GffDocument;
}

describe("getGffByPath", () => {
  it("reads a top-level scalar field", () => {
    const doc = makeDoc();
    const field = getGffByPath(doc, "Tag");
    expect(field).toEqual({ type: "cexostring", value: "MY_TAG" });
  });

  it("reads a top-level numeric field", () => {
    const doc = makeDoc();
    const field = getGffByPath(doc, "ChallengeRating");
    expect(field?.value).toBe(3.5);
  });

  it("reads a list item by index", () => {
    const doc = makeDoc();
    const field = getGffByPath(doc, "ClassList.0.Class");
    expect(field?.value).toBe(1);
  });

  it("reads a second list item by index", () => {
    const doc = makeDoc();
    const field = getGffByPath(doc, "ClassList.1.ClassLevel");
    expect(field?.value).toBe(2);
  });

  it("navigates into nested struct", () => {
    const doc = makeDoc();
    const field = getGffByPath(doc, "Nested.Inner");
    expect(field?.value).toBe("deep");
  });

  it("returns undefined for missing top-level field", () => {
    const doc = makeDoc();
    expect(getGffByPath(doc, "NonExistent")).toBeUndefined();
  });

  it("returns undefined for out-of-bounds list index", () => {
    const doc = makeDoc();
    expect(getGffByPath(doc, "ClassList.99.Class")).toBeUndefined();
  });

  it("returns undefined for negative list index", () => {
    const doc = makeDoc();
    expect(getGffByPath(doc, "ClassList.-1.Class")).toBeUndefined();
  });

  it("returns undefined for missing nested field", () => {
    const doc = makeDoc();
    expect(getGffByPath(doc, "Nested.Missing")).toBeUndefined();
  });
});

describe("setGffByPath", () => {
  it("updates a top-level scalar field", () => {
    const doc = makeDoc();
    const result = setGffByPath(doc, "Tag", "NEW_TAG");
    expect("previousValue" in result && result.previousValue).toBe("MY_TAG");
    expect((doc as GffObj).Tag).toEqual({ type: "cexostring", value: "NEW_TAG" });
  });

  it("updates a list item field", () => {
    const doc = makeDoc();
    setGffByPath(doc, "ClassList.0.Class", 99);
    const field = getGffByPath(doc, "ClassList.0.Class");
    expect(field?.value).toBe(99);
  });

  it("returns error for missing field without gffType", () => {
    const doc = makeDoc();
    const result = setGffByPath(doc, "MissingField", "value");
    expect("error" in result).toBe(true);
  });

  it("creates a new field when gffType is provided", () => {
    const doc = makeDoc();
    setGffByPath(doc, "NewField", "hello", "cexostring");
    const field = getGffByPath(doc, "NewField");
    expect(field?.value).toBe("hello");
  });

  it("returns error for path that doesn't exist at intermediate node", () => {
    const doc = makeDoc();
    const result = setGffByPath(doc, "Nonexistent.Nested.Field", "value");
    expect("error" in result).toBe(true);
  });
});
