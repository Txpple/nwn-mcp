import type { GffDocument, GffField, GffObj } from "../types/gff.js";

/**
 * Navigate a GFF document by dot-separated path.
 * Example: "Creature List.0.ChallengeRating" navigates to
 *   root["Creature List"].value[0].ChallengeRating
 */
export function getGffByPath(doc: GffDocument, path: string): GffField | undefined {
  const parts = path.split(".");
  let current: unknown = doc;

  for (const part of parts) {
    if (current === null || current === undefined) return undefined;

    // If current is an array, index into it
    if (Array.isArray(current)) {
      const idx = parseInt(part, 10);
      if (Number.isNaN(idx) || idx < 0 || idx >= current.length) return undefined;
      current = current[idx];
      continue;
    }

    if (typeof current !== "object") return undefined;
    const obj = current as GffObj;

    // If the object has a GFF field with this name, navigate into it
    const field = obj[part] as GffField | undefined;
    if (field && typeof field === "object" && "type" in field && "value" in field) {
      // For struct/list types, descend into the value
      if (field.type === "list" || field.type === "struct") {
        current = field.value;
      } else {
        // For leaf types, return the field if this is the last part
        if (part === parts[parts.length - 1]) return field;
        current = field.value;
      }
    } else if (obj[part] !== undefined) {
      current = obj[part];
    } else {
      return undefined;
    }
  }

  // If we ended on a GFF field object, return it
  if (current && typeof current === "object" && "type" in current && "value" in current) {
    return current as GffField;
  }
  return undefined;
}

/**
 * Set a value at a GFF path. Returns the previous value.
 */
export function setGffByPath(
  doc: GffDocument,
  path: string,
  newValue: unknown,
  gffType?: string
): { previousValue: unknown } | { error: string } {
  const parts = path.split(".");
  const fieldName = parts.pop();
  if (!fieldName) return { error: "Empty path" };

  // Navigate to parent
  let current: unknown = doc;
  for (const part of parts) {
    if (current === null || current === undefined) return { error: `Path not found at: ${part}` };

    if (Array.isArray(current)) {
      const idx = parseInt(part, 10);
      if (Number.isNaN(idx) || idx < 0 || idx >= current.length) return { error: `Array index out of bounds: ${part}` };
      current = current[idx];
      continue;
    }

    if (typeof current !== "object") return { error: `Expected object at: ${part}` };
    const obj = current as GffObj;
    const field = obj[part] as GffField | undefined;
    if (field && typeof field === "object" && "type" in field && "value" in field) {
      if (field.type === "list" || field.type === "struct") {
        current = field.value;
      } else {
        current = field.value;
      }
    } else if (obj[part] !== undefined) {
      current = obj[part];
    } else {
      return { error: `Field not found: ${part}` };
    }
  }

  if (typeof current !== "object" || current === null) return { error: "Parent is not an object" };
  const parent = current as GffObj;
  const field = parent[fieldName] as GffField | undefined;

  if (!field || typeof field !== "object" || !("type" in field)) {
    // Create new field if gffType is specified
    if (gffType) {
      parent[fieldName] = { type: gffType, value: newValue };
      return { previousValue: undefined };
    }
    return { error: `Field not found: ${fieldName}` };
  }

  const previousValue = field.value;
  field.value = newValue;
  return { previousValue };
}
