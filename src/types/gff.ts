export type GffType =
  | "byte" | "char" | "word" | "short" | "dword" | "int"
  | "dword64" | "int64" | "float" | "double"
  | "cexostring" | "resref" | "cexolocstring"
  | "void" | "struct" | "list";

export interface GffField {
  type: GffType;
  value: unknown;
}

export interface GffStruct {
  __struct_id: number;
  [key: string]: GffField | number; // number only for __struct_id
}

export interface GffDocument {
  __data_type: string;
  [key: string]: GffField | string; // string only for __data_type
}

/** Convenience alias for GFF objects in tool code. Both GffDocument and GffStruct are used
 *  interchangeably through this type since getter/setter helpers only need keyed access. */
export type GffObj = Record<string, unknown>;

export interface CExoLocString {
  [languageId: string]: string | number | undefined;
  id?: number;
}

/** Extract display text from a cexolocstring value. Prefers English (key "0"). */
export function getLocString(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const loc = value as Record<string, unknown>;
  // Prefer English (language 0), fall back to any language, then TLK id
  if (typeof loc["0"] === "string") return loc["0"];
  for (const key of Object.keys(loc)) {
    if (key !== "id" && typeof loc[key] === "string") return loc[key] as string;
  }
  if (typeof loc.id === "number") return `[TLK:${loc.id}]`;
  return "";
}

/** Extract the TLK strref from a cexolocstring value, or -1 if none */
export function getLocStringStrref(value: unknown): number {
  if (!value || typeof value !== "object") return -1;
  const loc = value as Record<string, unknown>;
  return typeof loc.id === "number" ? loc.id : -1;
}

/** Get field as localized string, resolving TLK strrefs via provided lookup */
export function getFieldLocStrResolved(
  obj: Record<string, unknown>,
  fieldName: string,
  tlkLookup?: (strref: number) => string | undefined,
): string {
  const val = getField(obj, fieldName);
  const text = getLocString(val);
  if (text.startsWith("[TLK:") && tlkLookup) {
    const strref = getLocStringStrref(val);
    if (strref >= 0) {
      const resolved = tlkLookup(strref);
      if (resolved) return resolved;
    }
  }
  return text;
}

/** Safely get a GFF field value from a parsed GFF object */
export function getField(obj: Record<string, unknown>, fieldName: string): unknown {
  const field = obj[fieldName] as GffField | undefined;
  if (!field || typeof field !== "object" || !("value" in field)) return undefined;
  return field.value;
}

/** Get field as string */
export function getFieldStr(obj: Record<string, unknown>, fieldName: string): string {
  const val = getField(obj, fieldName);
  return typeof val === "string" ? val : "";
}

/** Get field as number */
export function getFieldNum(obj: Record<string, unknown>, fieldName: string): number {
  const val = getField(obj, fieldName);
  return typeof val === "number" ? val : 0;
}

/** Get field as localized string text */
export function getFieldLocStr(obj: Record<string, unknown>, fieldName: string): string {
  return getLocString(getField(obj, fieldName));
}

/** Get field as list (array of structs) */
export function getFieldList(obj: Record<string, unknown>, fieldName: string): Record<string, unknown>[] {
  const val = getField(obj, fieldName);
  return Array.isArray(val) ? val as Record<string, unknown>[] : [];
}

// ─── Setters ────────────────────────────────────────────────────────────────

/** Set or create a GFF field. Updates existing field value or creates a new typed field. */
export function setField(obj: Record<string, unknown>, fieldName: string, gffType: string, value: unknown): void {
  const field = obj[fieldName] as GffField | undefined;
  if (field && typeof field === "object" && "type" in field) {
    field.value = value;
  } else {
    obj[fieldName] = { type: gffType, value };
  }
}

/** Set a numeric GFF field value. Creates the field if it doesn't exist. */
export function setFieldNum(obj: Record<string, unknown>, fieldName: string, value: number, gffType: string = "int"): void {
  setField(obj, fieldName, gffType, value);
}

/** Set a string GFF field value. Creates the field if it doesn't exist. */
export function setFieldStr(obj: Record<string, unknown>, fieldName: string, value: string, gffType: string = "cexostring"): void {
  setField(obj, fieldName, gffType, value);
}
