import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { requireIndex } from "../module-loader.js";
import { getFieldStr, getFieldLocStr } from "../types/gff.js";
import type { GffObj } from "../types/gff.js";

import { numParam, toI } from "../util/params.js";

export function registerLookupTools(server: McpServer): void {

  server.tool(
    "resolve_2da",
    "Look up a value in a 2DA table by row index. Returns the full row or a specific column value. Uses base game + HAK 2DA tables loaded via resman.",
    {
      table: z.string().describe("2DA table name without extension (e.g., 'appearance', 'baseitems', 'itempropdef')"),
      row: numParam("Row index to look up"),
      column: z.string().optional().describe("Specific column to return (returns full row if omitted)"),
    },
    { readOnlyHint: true, idempotentHint: true },
    async ({ table, row: rowStr, column }) => {
      const index = requireIndex();
      const row = toI(rowStr);
      const twoDA = index.twodaTables.get(table.toLowerCase());
      if (!twoDA) {
        const available = [...index.twodaTables.keys()];
        return {
          content: [{
            type: "text",
            text: `2DA table "${table}" not found in module. Available tables: ${available.length ? available.join(", ") : "none (module contains no 2DA files)"}`,
          }],
        };
      }

      const rowData = twoDA.rows.get(row);
      if (!rowData) {
        return {
          content: [{
            type: "text",
            text: `Row ${row} not found in ${table}.2da. Table has ${twoDA.rows.size} rows.`,
          }],
        };
      }

      if (column) {
        const value = rowData[column];
        if (value === undefined) {
          return {
            content: [{
              type: "text",
              text: `Column "${column}" not found. Available columns: ${twoDA.columns.join(", ")}`,
            }],
          };
        }
        return { content: [{ type: "text", text: value }] };
      }

      return { content: [{ type: "text", text: JSON.stringify({ row, ...rowData }, null, 2) }] };
    }
  );

  server.tool(
    "search_2da",
    "Search a 2DA table for rows where a column matches a value (case-insensitive substring match).",
    {
      table: z.string().describe("2DA table name without extension"),
      column: z.string().describe("Column name to search"),
      value: z.string().describe("Value to search for (case-insensitive substring)"),
    },
    { readOnlyHint: true, idempotentHint: true },
    async ({ table, column, value }) => {
      const index = requireIndex();
      const twoDA = index.twodaTables.get(table.toLowerCase());
      if (!twoDA) {
        const available = [...index.twodaTables.keys()];
        return {
          content: [{
            type: "text",
            text: `2DA table "${table}" not found. Available: ${available.length ? available.join(", ") : "none"}`,
          }],
        };
      }

      const searchLower = value.toLowerCase();
      const matches: Array<Record<string, unknown>> = [];
      for (const [rowIdx, rowData] of twoDA.rows) {
        const cellValue = rowData[column];
        if (cellValue?.toLowerCase().includes(searchLower)) {
          matches.push({ row: rowIdx, ...rowData });
        }
      }

      if (matches.length === 0) {
        return { content: [{ type: "text", text: `No matches for "${value}" in ${table}.${column}` }] };
      }

      return { content: [{ type: "text", text: JSON.stringify(matches, null, 2) }] };
    }
  );

  server.tool(
    "list_2da_tables",
    "List all 2DA tables available in the loaded module.",
    {},
    { readOnlyHint: true, idempotentHint: true },
    async () => {
      const index = requireIndex();
      const tables = [...index.twodaTables.entries()].map(([name, table]) => ({
        name,
        columns: table.columns,
        rowCount: table.rows.size,
      }));
      return { content: [{ type: "text", text: JSON.stringify(tables, null, 2) }] };
    }
  );

  server.tool(
    "resolve_tlk",
    "Look up text for a TLK string reference. Checks custom TLK first (strrefs >= 0x01000000), then base game dialog.tlk.",
    {
      strref: numParam("String reference number to look up"),
    },
    { readOnlyHint: true, idempotentHint: true },
    async ({ strref: strrefStr }) => {
      const index = requireIndex();
      const strref = toI(strrefStr);

      // Custom TLK strrefs are offset by 0x01000000
      const CUSTOM_OFFSET = 0x01000000;
      if (strref >= CUSTOM_OFFSET && index.customTlk) {
        const text = index.customTlk.get(strref - CUSTOM_OFFSET);
        if (text !== undefined) {
          return { content: [{ type: "text", text: `[custom] ${text}` }] };
        }
      }

      // Also check custom TLK directly (in case strrefs are stored without offset)
      if (index.customTlk) {
        const text = index.customTlk.get(strref);
        if (text !== undefined) {
          return { content: [{ type: "text", text: `[custom] ${text}` }] };
        }
      }

      // Fall back to base game TLK
      if (index.baseTlk) {
        const text = index.baseTlk.get(strref);
        if (text !== undefined) {
          return { content: [{ type: "text", text: `[base] ${text}` }] };
        }
      }

      const sources: string[] = [];
      if (!index.customTlk) sources.push("no custom TLK loaded");
      if (!index.baseTlk) sources.push("no base game TLK loaded (set NWN_FOLDER_DATA env var)");
      return {
        content: [{
          type: "text",
          text: `String reference ${strref} not found. ${sources.join("; ")}`,
        }],
      };
    }
  );

  server.tool(
    "list_tlk_entries",
    "Browse TLK entries with optional substring filter and range. Returns up to 50 entries at a time.",
    {
      source: z.enum(["custom", "base", "both"]).optional().describe("Which TLK to search (default: custom)"),
      filter: z.string().optional().describe("Substring filter on text content"),
      start: numParam("Starting strref index (default: 0)").optional(),
      count: numParam("Max entries to return (default: 50, max: 200)").optional(),
    },
    { readOnlyHint: true, idempotentHint: true },
    async ({ source, filter, start: startStr, count: countStr }) => {
      const index = requireIndex();
      const src = source || "custom";
      const maxCount = Math.min(countStr ? toI(countStr) : 50, 200);
      const startIdx = startStr ? toI(startStr) : 0;

      const tables: Array<{ label: string; table: Map<number, string> }> = [];
      if ((src === "custom" || src === "both") && index.customTlk) {
        tables.push({ label: "custom", table: index.customTlk });
      }
      if ((src === "base" || src === "both") && index.baseTlk) {
        tables.push({ label: "base", table: index.baseTlk });
      }

      if (tables.length === 0) {
        return { content: [{ type: "text", text: `No TLK tables available for source "${src}".` }] };
      }

      const results: Array<{ source: string; strref: number; text: string }> = [];
      const filterLower = filter?.toLowerCase();

      for (const { label, table } of tables) {
        for (const [strref, text] of table) {
          if (strref < startIdx) continue;
          if (filterLower && !text.toLowerCase().includes(filterLower)) continue;
          results.push({ source: label, strref, text });
          if (results.length >= maxCount) break;
        }
        if (results.length >= maxCount) break;
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({ count: results.length, entries: results }, null, 2),
        }],
      };
    }
  );

  server.tool(
    "search_tlk",
    "Search TLK entries by text content (case-insensitive substring match).",
    {
      query: z.string().describe("Text to search for"),
      source: z.enum(["custom", "base", "both"]).optional().describe("Which TLK to search (default: both)"),
    },
    { readOnlyHint: true, idempotentHint: true },
    async ({ query, source }) => {
      const index = requireIndex();
      const src = source || "both";
      const queryLower = query.toLowerCase();

      const tables: Array<{ label: string; table: Map<number, string> }> = [];
      if ((src === "custom" || src === "both") && index.customTlk) {
        tables.push({ label: "custom", table: index.customTlk });
      }
      if ((src === "base" || src === "both") && index.baseTlk) {
        tables.push({ label: "base", table: index.baseTlk });
      }

      if (tables.length === 0) {
        return { content: [{ type: "text", text: `No TLK tables available for source "${src}".` }] };
      }

      const results: Array<{ source: string; strref: number; text: string }> = [];
      for (const { label, table } of tables) {
        for (const [strref, text] of table) {
          if (text.toLowerCase().includes(queryLower)) {
            results.push({ source: label, strref, text });
            if (results.length >= 100) break;
          }
        }
        if (results.length >= 100) break;
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({ matchCount: results.length, matches: results }, null, 2),
        }],
      };
    }
  );

  server.tool(
    "find_strref_usage",
    "Find which GFF resources reference a given TLK string reference number.",
    {
      strref: numParam("String reference number to search for"),
    },
    { readOnlyHint: true, idempotentHint: true },
    async ({ strref: strrefStr }) => {
      const index = requireIndex();
      const strref = toI(strrefStr);
      const results: Array<{ resourceFile: string; gffPath: string; fieldName: string; objectName?: string }> = [];

      function walkGff(obj: GffObj, resourceFile: string, basePath: string): void {
        for (const [key, rawField] of Object.entries(obj)) {
          if (key === "__struct_id" || key === "__data_type") continue;
          const field = rawField as { type?: string; value?: unknown };
          if (!field || typeof field !== "object" || !("type" in field)) continue;

          const currentPath = basePath ? `${basePath}.${key}` : key;

          if (field.type === "cexolocstring" && typeof field.value === "object" && field.value) {
            const locStr = field.value as GffObj;
            const strrefVal = locStr.id ?? locStr.strref;
            if (typeof strrefVal === "number" && strrefVal === strref) {
              const objName =
                getFieldLocStr(obj, "FirstName") ||
                getFieldLocStr(obj, "LocalizedName") ||
                getFieldLocStr(obj, "LocName") ||
                getFieldStr(obj, "Tag");
              results.push({ resourceFile, gffPath: currentPath, fieldName: key, objectName: objName || undefined });
            }
          }

          if (field.type === "list" && Array.isArray(field.value)) {
            (field.value as GffObj[]).forEach((item, i) => {
              walkGff(item, resourceFile, `${currentPath}[${i}]`);
            });
          } else if (field.type === "struct" && typeof field.value === "object" && field.value) {
            walkGff(field.value as GffObj, resourceFile, currentPath);
          }
        }
      }

      for (const [key, doc] of index.parsedGff) {
        walkGff(doc as GffObj, key, "");
      }

      return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
    }
  );
}
