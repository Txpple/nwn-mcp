import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import path from "path";
import fs from "fs/promises";
import { loadModule, requireIndex } from "../module-loader.js";
import { gffToJson, readTextFile, disassembleNcs } from "../nim-tools.js";
import { GFF_EXTENSIONS, NWN_FOLDER_USER } from "../config.js";
import { getFieldLocStr, getFieldStr, getFieldNum, getFieldList } from "../types/gff.js";
import type { GffObj } from "../types/gff.js";

export function registerCoreReadTools(server: McpServer): void {

  server.tool(
    "load_module",
    "Load and index a NWN module (.mod) file. Must be called before using other tools. If just a filename is given (e.g., 'mymod.mod'), it is resolved from the NWN_FOLDER_USER/modules/ directory.",
    { modPath: z.string().describe("Module filename (e.g., 'mymod.mod') or absolute path") },
    async ({ modPath }) => {
      // Resolve relative names from NWN_FOLDER_USER/modules/
      let resolvedPath = modPath;
      if (!path.isAbsolute(modPath) && NWN_FOLDER_USER) {
        const candidate = path.join(NWN_FOLDER_USER, "modules", modPath);
        try {
          await fs.access(candidate);
          resolvedPath = candidate;
        } catch {
          // Fall through — will fail with a clear error from loadModule
        }
      }
      const index = await loadModule(resolvedPath);
      const typeCounts: Record<string, number> = {};
      for (const entry of index.resources.values()) {
        typeCounts[entry.extension] = (typeCounts[entry.extension] || 0) + 1;
      }
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            moduleName: index.moduleName,
            areaCount: index.areas.size,
            resourceCount: index.resources.size,
            creatureCount: index.creatures.length,
            itemCount: index.items.length,
            dialogCount: index.dialogs.size,
            haks: index.hakList,
            customTlk: index.customTlkName || null,
            customTlkLoaded: index.customTlk !== null,
            baseTlkLoaded: index.baseTlk !== null,
            twodaTablesLoaded: index.twodaTables.size,
            resourceTypes: typeCounts,
            warningCount: index.loadWarnings.length,
            loadWarnings: index.loadWarnings,
          }, null, 2),
        }],
      };
    }
  );

  server.tool(
    "list_resources",
    "List all resources in the loaded module, optionally filtered by type (extension).",
    { type: z.string().optional().describe("Filter by extension (e.g., 'uti', 'dlg', 'nss')") },
    async ({ type }) => {
      const index = requireIndex();
      const results: Array<{ resref: string; type: string; sizeBytes: number }> = [];
      for (const entry of index.resources.values()) {
        if (!type || entry.extension === type.toLowerCase()) {
          results.push({ resref: entry.resref, type: entry.extension, sizeBytes: entry.sizeBytes });
        }
      }
      return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
    }
  );

  server.tool(
    "get_resource",
    "Get the full content of a resource. Returns GFF as JSON, .nss as source text, .ncs as disassembly.",
    {
      resref: z.string().describe("Resource name without extension (e.g., 'innkey')"),
      type: z.string().describe("Resource extension (e.g., 'uti', 'dlg', 'nss')"),
    },
    async ({ resref, type }) => {
      const index = requireIndex();
      const key = `${resref.toLowerCase()}.${type.toLowerCase()}`;
      const entry = index.resources.get(key);
      if (!entry) return { content: [{ type: "text", text: `Resource not found: ${key}` }] };

      if (type.toLowerCase() === "nss") {
        const text = await readTextFile(entry.filePath);
        return { content: [{ type: "text", text }] };
      }

      if (type.toLowerCase() === "ncs") {
        try {
          const text = await disassembleNcs(entry.filePath);
          return { content: [{ type: "text", text }] };
        } catch (e) {
          return { content: [{ type: "text", text: `Disassembly failed: ${e}` }] };
        }
      }

      if (GFF_EXTENSIONS.has(type.toLowerCase())) {
        // Return cached parsed GFF if available
        const cached = index.parsedGff.get(key);
        if (cached) {
          return { content: [{ type: "text", text: JSON.stringify(cached, null, 2) }] };
        }
        // Parse on demand
        const doc = await gffToJson(entry.filePath);
        return { content: [{ type: "text", text: JSON.stringify(doc, null, 2) }] };
      }

      // For unknown types, try reading as text
      try {
        const text = await readTextFile(entry.filePath);
        return { content: [{ type: "text", text }] };
      } catch {
        return { content: [{ type: "text", text: `Binary resource: ${key} (${entry.sizeBytes} bytes)` }] };
      }
    }
  );

  server.tool(
    "get_module_info",
    "Get parsed module.ifo data: areas, entry point, scripts, time settings.",
    {},
    async () => {
      const index = requireIndex();
      const ifo = index.parsedGff.get("module.ifo");
      if (!ifo) return { content: [{ type: "text", text: "module.ifo not found" }] };

      const obj = ifo as GffObj;
      const areaList = getFieldList(obj, "Mod_Area_list").map(a => getFieldStr(a, "Area_Name"));

      const info = {
        moduleName: index.moduleName,
        entryArea: getFieldStr(obj, "Mod_Entry_Area"),
        entryPosition: {
          x: getFieldNum(obj, "Mod_Entry_X"),
          y: getFieldNum(obj, "Mod_Entry_Y"),
          z: getFieldNum(obj, "Mod_Entry_Z"),
        },
        areas: areaList,
        description: getFieldLocStr(obj, "Mod_Description"),
        dawnHour: getFieldNum(obj, "Mod_DawnHour"),
        duskHour: getFieldNum(obj, "Mod_DuskHour"),
        startMinute: getFieldNum(obj, "Mod_StartMinute"),
        startHour: getFieldNum(obj, "Mod_StartHour"),
        startDay: getFieldNum(obj, "Mod_StartDay"),
        startMonth: getFieldNum(obj, "Mod_StartMonth"),
        startYear: getFieldNum(obj, "Mod_StartYear"),
        xpScale: getFieldNum(obj, "Mod_XPScale"),
        customTlk: index.customTlkName || null,
        customTlkLoaded: index.customTlk !== null,
        haks: index.hakList,
        twodaTablesLoaded: index.twodaTables.size,
        // Module event scripts
        onHeartbeat: getFieldStr(obj, "Mod_OnHeartbeat"),
        onModLoad: getFieldStr(obj, "Mod_OnModLoad"),
        onModStart: getFieldStr(obj, "Mod_OnModStart"),
        onClientEnter: getFieldStr(obj, "Mod_OnClientEntr"),
        onClientLeave: getFieldStr(obj, "Mod_OnClientLeav"),
        onPlayerDeath: getFieldStr(obj, "Mod_OnPlrDeath"),
        onPlayerDying: getFieldStr(obj, "Mod_OnPlrDying"),
        onPlayerRest: getFieldStr(obj, "Mod_OnPlrRest"),
        onPlayerLevelUp: getFieldStr(obj, "Mod_OnPlrLvlUp"),
        onAcquireItem: getFieldStr(obj, "Mod_OnAcquirItem"),
        onUnacquireItem: getFieldStr(obj, "Mod_OnUnAqreItem"),
        onActivateItem: getFieldStr(obj, "Mod_OnActvtItem"),
      };

      return { content: [{ type: "text", text: JSON.stringify(info, null, 2) }] };
    }
  );

  server.tool(
    "search_by_tag",
    "Search for resources by Tag value across the entire module.",
    {
      tag: z.string().describe("Tag to search for"),
      exactMatch: z.boolean().optional().describe("If false, does case-insensitive substring match (default: false)"),
    },
    async ({ tag, exactMatch }) => {
      const index = requireIndex();
      const results: Array<{ tag: string; resourceFile: string; objectType: string; name?: string; gffPath: string }> = [];

      if (exactMatch) {
        const locations = index.tags.get(tag) || [];
        for (const loc of locations) {
          results.push({ tag, ...loc });
        }
      } else {
        const needle = tag.toLowerCase();
        for (const [tagValue, locations] of index.tags) {
          if (tagValue.toLowerCase().includes(needle)) {
            for (const loc of locations) {
              results.push({ tag: tagValue, ...loc });
            }
          }
        }
      }

      return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
    }
  );

  server.tool(
    "search_by_field",
    "Search for GFF fields by name and optionally by value across all parsed resources.",
    {
      fieldName: z.string().describe("Field name to search for (e.g., 'ChallengeRating', 'Conversation')"),
      value: z.string().optional().describe("Optional value to match (string comparison)"),
      type: z.string().optional().describe("Filter by resource type/extension"),
    },
    async ({ fieldName, value, type }) => {
      const index = requireIndex();
      const results: Array<{ resourceFile: string; path: string; value: unknown; gffType: string }> = [];

      for (const [key, doc] of index.parsedGff) {
        if (type && !key.endsWith(`.${type}`)) continue;
        searchGffFields(key, doc as GffObj, fieldName, value, "", results);
      }

      return { content: [{ type: "text", text: JSON.stringify(results.slice(0, 100), null, 2) }] };
    }
  );
}

function searchGffFields(
  resourceFile: string,
  obj: GffObj,
  fieldName: string,
  value: string | undefined,
  basePath: string,
  results: Array<{ resourceFile: string; path: string; value: unknown; gffType: string }>
): void {
  for (const [key, rawField] of Object.entries(obj)) {
    if (key === "__struct_id" || key === "__data_type") continue;

    const field = rawField as { type?: string; value?: unknown };
    if (!field || typeof field !== "object" || !("type" in field)) continue;

    const currentPath = basePath ? `${basePath}.${key}` : key;

    if (key === fieldName) {
      if (!value || String(field.value) === value || String(field.value).toLowerCase().includes(value.toLowerCase())) {
        results.push({ resourceFile, path: currentPath, value: field.value, gffType: field.type as string });
      }
    }

    // Recurse
    if (field.type === "list" && Array.isArray(field.value)) {
      (field.value as GffObj[]).forEach((item, i) => {
        searchGffFields(resourceFile, item, fieldName, value, `${currentPath}[${i}]`, results);
      });
    } else if (field.type === "struct" && typeof field.value === "object" && field.value) {
      searchGffFields(resourceFile, field.value as GffObj, fieldName, value, currentPath, results);
    }
  }
}
