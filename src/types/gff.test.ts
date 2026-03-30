import { describe, it, expect } from "vitest";
import {
  getLocString,
  getLocStringStrref,
  getFieldLocStrResolved,
  getField,
  getFieldStr,
  getFieldNum,
  getFieldLocStr,
  getFieldList,
  setField,
  setFieldNum,
  setFieldStr,
} from "./gff.js";

// ─── getLocString ───────────────────────────────────────────────────────────

describe("getLocString", () => {
  it("returns English (key 0) text", () => {
    expect(getLocString({ "0": "Hello" })).toBe("Hello");
  });

  it("falls back to another language when English is missing", () => {
    expect(getLocString({ "1": "Bonjour" })).toBe("Bonjour");
  });

  it("returns TLK reference when only id is present", () => {
    expect(getLocString({ id: 42 })).toBe("[TLK:42]");
  });

  it("prefers English over other languages", () => {
    expect(getLocString({ "0": "English", "1": "French" })).toBe("English");
  });

  it("prefers text over TLK id", () => {
    expect(getLocString({ "0": "Text", id: 99 })).toBe("Text");
  });

  it("returns empty string for null", () => {
    expect(getLocString(null)).toBe("");
  });

  it("returns empty string for undefined", () => {
    expect(getLocString(undefined)).toBe("");
  });

  it("returns empty string for non-object", () => {
    expect(getLocString("just a string")).toBe("");
  });

  it("returns empty string for empty object", () => {
    expect(getLocString({})).toBe("");
  });

  it("returns TLK reference for id: 0", () => {
    expect(getLocString({ id: 0 })).toBe("[TLK:0]");
  });
});

// ─── getLocStringStrref ─────────────────────────────────────────────────────

describe("getLocStringStrref", () => {
  it("returns strref when id is present", () => {
    expect(getLocStringStrref({ id: 123 })).toBe(123);
  });

  it("returns -1 when no id", () => {
    expect(getLocStringStrref({ "0": "text only" })).toBe(-1);
  });

  it("returns -1 for null", () => {
    expect(getLocStringStrref(null)).toBe(-1);
  });

  it("returns -1 for undefined", () => {
    expect(getLocStringStrref(undefined)).toBe(-1);
  });

  it("returns id: 0 correctly", () => {
    expect(getLocStringStrref({ id: 0 })).toBe(0);
  });
});

// ─── getFieldLocStrResolved ─────────────────────────────────────────────────

describe("getFieldLocStrResolved", () => {
  const obj = {
    Name: { type: "cexolocstring", value: { "0": "Plain Name" } },
    TlkName: { type: "cexolocstring", value: { id: 100 } },
    MixedName: { type: "cexolocstring", value: { "0": "Local", id: 200 } },
  };

  it("returns plain text when no TLK ref", () => {
    expect(getFieldLocStrResolved(obj, "Name")).toBe("Plain Name");
  });

  it("returns TLK placeholder when no lookup provided", () => {
    expect(getFieldLocStrResolved(obj, "TlkName")).toBe("[TLK:100]");
  });

  it("resolves TLK ref via lookup function", () => {
    const lookup = (strref: number) => strref === 100 ? "Resolved Name" : undefined;
    expect(getFieldLocStrResolved(obj, "TlkName", lookup)).toBe("Resolved Name");
  });

  it("returns TLK placeholder when lookup returns undefined", () => {
    const lookup = () => undefined;
    expect(getFieldLocStrResolved(obj, "TlkName", lookup)).toBe("[TLK:100]");
  });

  it("prefers local text over TLK id", () => {
    const lookup = (strref: number) => strref === 200 ? "Should not appear" : undefined;
    expect(getFieldLocStrResolved(obj, "MixedName", lookup)).toBe("Local");
  });

  it("returns empty string for missing field", () => {
    expect(getFieldLocStrResolved(obj, "Missing")).toBe("");
  });
});

// ─── getField / getFieldStr / getFieldNum / getFieldLocStr / getFieldList ───

describe("getField", () => {
  it("returns the value from a typed field", () => {
    const obj = { Tag: { type: "cexostring", value: "hello" } };
    expect(getField(obj, "Tag")).toBe("hello");
  });

  it("returns undefined for missing field", () => {
    expect(getField({}, "Missing")).toBeUndefined();
  });

  it("returns undefined for field without value property", () => {
    expect(getField({ Bad: "not a field" }, "Bad")).toBeUndefined();
  });

  it("returns undefined for null-ish field", () => {
    expect(getField({ X: null }, "X")).toBeUndefined();
  });
});

describe("getFieldStr", () => {
  it("returns string value", () => {
    const obj = { Tag: { type: "cexostring", value: "mytag" } };
    expect(getFieldStr(obj, "Tag")).toBe("mytag");
  });

  it("returns empty string for numeric field", () => {
    const obj = { HP: { type: "short", value: 10 } };
    expect(getFieldStr(obj, "HP")).toBe("");
  });

  it("returns empty string for missing field", () => {
    expect(getFieldStr({}, "Missing")).toBe("");
  });
});

describe("getFieldNum", () => {
  it("returns numeric value", () => {
    const obj = { HP: { type: "short", value: 42 } };
    expect(getFieldNum(obj, "HP")).toBe(42);
  });

  it("returns 0 for string field", () => {
    const obj = { Tag: { type: "cexostring", value: "text" } };
    expect(getFieldNum(obj, "Tag")).toBe(0);
  });

  it("returns 0 for missing field", () => {
    expect(getFieldNum({}, "Missing")).toBe(0);
  });

  it("handles float values", () => {
    const obj = { CR: { type: "float", value: 3.5 } };
    expect(getFieldNum(obj, "CR")).toBeCloseTo(3.5);
  });
});

describe("getFieldLocStr", () => {
  it("extracts English text from cexolocstring", () => {
    const obj = { Name: { type: "cexolocstring", value: { "0": "Sword" } } };
    expect(getFieldLocStr(obj, "Name")).toBe("Sword");
  });

  it("returns TLK ref when only id", () => {
    const obj = { Name: { type: "cexolocstring", value: { id: 50 } } };
    expect(getFieldLocStr(obj, "Name")).toBe("[TLK:50]");
  });

  it("returns empty string for missing field", () => {
    expect(getFieldLocStr({}, "Name")).toBe("");
  });
});

describe("getFieldList", () => {
  it("returns array from list field", () => {
    const obj = {
      Items: {
        type: "list",
        value: [
          { __struct_id: 0, Tag: { type: "cexostring", value: "item1" } },
          { __struct_id: 1, Tag: { type: "cexostring", value: "item2" } },
        ],
      },
    };
    const list = getFieldList(obj, "Items");
    expect(list).toHaveLength(2);
  });

  it("returns empty array for missing field", () => {
    expect(getFieldList({}, "Items")).toEqual([]);
  });

  it("returns empty array for non-list field", () => {
    const obj = { Tag: { type: "cexostring", value: "text" } };
    expect(getFieldList(obj, "Tag")).toEqual([]);
  });
});

// ─── setField / setFieldNum / setFieldStr ───────────────────────────────────

describe("setField", () => {
  it("updates existing field value", () => {
    const obj: Record<string, unknown> = { Tag: { type: "cexostring", value: "old" } };
    setField(obj, "Tag", "cexostring", "new");
    expect((obj.Tag as { value: string }).value).toBe("new");
  });

  it("preserves existing field type", () => {
    const obj: Record<string, unknown> = { HP: { type: "short", value: 10 } };
    setField(obj, "HP", "int", 20); // gffType ignored for existing fields
    expect((obj.HP as { type: string }).type).toBe("short");
    expect((obj.HP as { value: number }).value).toBe(20);
  });

  it("creates new field when it does not exist", () => {
    const obj: Record<string, unknown> = {};
    setField(obj, "NewField", "dword", 42);
    expect(obj.NewField).toEqual({ type: "dword", value: 42 });
  });

  it("creates new field when existing key is not a GFF field", () => {
    const obj: Record<string, unknown> = { Bad: "not a field" };
    setField(obj, "Bad", "cexostring", "fixed");
    expect(obj.Bad).toEqual({ type: "cexostring", value: "fixed" });
  });
});

describe("setFieldNum", () => {
  it("sets numeric value with default int type", () => {
    const obj: Record<string, unknown> = {};
    setFieldNum(obj, "HP", 100);
    expect(obj.HP).toEqual({ type: "int", value: 100 });
  });

  it("sets numeric value with custom type", () => {
    const obj: Record<string, unknown> = {};
    setFieldNum(obj, "CR", 3.5, "float");
    expect(obj.CR).toEqual({ type: "float", value: 3.5 });
  });

  it("updates existing numeric field", () => {
    const obj: Record<string, unknown> = { HP: { type: "short", value: 10 } };
    setFieldNum(obj, "HP", 50);
    expect((obj.HP as { value: number }).value).toBe(50);
  });
});

describe("setFieldStr", () => {
  it("sets string value with default cexostring type", () => {
    const obj: Record<string, unknown> = {};
    setFieldStr(obj, "Tag", "hello");
    expect(obj.Tag).toEqual({ type: "cexostring", value: "hello" });
  });

  it("sets string value with custom type", () => {
    const obj: Record<string, unknown> = {};
    setFieldStr(obj, "Script", "my_script", "resref");
    expect(obj.Script).toEqual({ type: "resref", value: "my_script" });
  });

  it("updates existing string field", () => {
    const obj: Record<string, unknown> = { Tag: { type: "cexostring", value: "old" } };
    setFieldStr(obj, "Tag", "new");
    expect((obj.Tag as { value: string }).value).toBe("new");
  });
});
