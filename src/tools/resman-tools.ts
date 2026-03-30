import { z } from "zod";
import path from "path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { requireIndex, buildResmanOptions } from "../module-loader.js";
import fs from "fs/promises";
import { resmanExtractToJson, resmanGrep, resmanStats, erfTlkify } from "../nim-tools.js";
import { getFieldStr, getFieldNum, getFieldLocStr, getFieldLocStrResolved, getFieldList } from "../types/gff.js";
import type { GffObj } from "../types/gff.js";
import { numParam, toI } from "../util/params.js";
import { buildTlkLookup } from "../util/area-data.js";

export function registerResmanTools(server: McpServer): void {

  server.tool(
    "resolve_blueprint",
    "Resolve any resource from the full resman stack (base game BIFs + HAKs + override + development) and return its GFF as JSON. Use this to look up base game or HAK blueprints by resref (e.g., 'nw_cloth001.uti', 'nw_dog.utc', 'plc_chest1.utp').",
    {
      resource: z.string().describe("Resource filename with extension (e.g., 'nw_cloth001.uti')"),
    },
    async ({ resource }) => {
      const index = requireIndex();

      // Check module's own parsed GFF first
      const moduleKey = resource.toLowerCase();
      const moduleDoc = index.parsedGff.get(moduleKey);
      if (moduleDoc) {
        return { content: [{ type: "text", text: JSON.stringify(formatGffSummary(moduleDoc as GffObj, resource), null, 2) }] };
      }

      // Resolve from resman stack via extract-then-parse (fast)
      const resman = await buildResmanOptions(index);
      try {
        const cacheDir = path.join(index.tempDir, "blueprint_cache");
        await fs.mkdir(cacheDir, { recursive: true });
        const doc = await resmanExtractToJson(resource, cacheDir, resman);
        return { content: [{ type: "text", text: JSON.stringify(formatGffSummary(doc as GffObj, resource), null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text", text: `Resource not found in resman: ${resource}\n${e}` }] };
      }
    }
  );

  server.tool(
    "resman_search",
    "Search for resources across the full resman stack (base game + HAKs + override + development) by name pattern or binary content.",
    {
      pattern: z.string().optional().describe("Resource name substring to search for (e.g., 'dragon', '.utc')"),
      binary: z.string().optional().describe("Binary/text content to search for within resource data"),
      invert: z.boolean().optional().describe("Invert match (find resources NOT matching)"),
    },
    async ({ pattern, binary, invert }) => {
      if (!pattern && !binary) {
        return { content: [{ type: "text", text: "Provide either pattern or binary (or both) to search." }] };
      }
      const index = requireIndex();
      const resman = await buildResmanOptions(index);
      try {
        const output = await resmanGrep({ ...resman, pattern, binary, invert, details: true });
        const lines = output.trim().split("\n").filter(Boolean);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ matchCount: lines.length, matches: lines }, null, 2),
          }],
        };
      } catch (e) {
        return { content: [{ type: "text", text: `resman search failed: ${e}` }] };
      }
    }
  );

  server.tool(
    "resman_stats",
    "Show the full resman stack for the loaded module: container sizes, file counts, shadowing info, and load order. Useful for diagnosing why a resource isn't loading as expected.",
    {
      detailed: z.boolean().optional().describe("Show per-container file lists (default: summary only)"),
    },
    async ({ detailed }) => {
      const index = requireIndex();
      const resman = await buildResmanOptions(index);
      try {
        const output = await resmanStats({ ...resman, detailed: detailed ?? false });
        return { content: [{ type: "text", text: output }] };
      } catch (e) {
        return { content: [{ type: "text", text: `resman stats failed: ${e}` }] };
      }
    }
  );

  server.tool(
    "tlkify_module",
    "Extract all hardcoded strings from the loaded module into a TLK file for localization review. Creates a new module with strref pointers and a companion TLK containing all extracted text.",
    {
      outputTlkPath: z.string().describe("Path to write the generated TLK file"),
      outputModPath: z.string().optional().describe("Path for the TLKified module (defaults to <original>.tlkified.mod)"),
    },
    async ({ outputTlkPath, outputModPath }) => {
      const index = requireIndex();
      const outMod = outputModPath || index.modPath.replace(/\.mod$/i, ".tlkified.mod");
      const resman = await buildResmanOptions(index);

      try {
        const output = await erfTlkify(outputTlkPath, index.modPath, outMod, resman);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              tlkFile: outputTlkPath,
              modFile: outMod,
              output: output || "Strings extracted successfully",
            }, null, 2),
          }],
        };
      } catch (e) {
        return { content: [{ type: "text", text: `tlkify failed: ${e}` }] };
      }
    }
  );

  // ─── list_blueprints ──────────────────────────────────────────────────────

  server.tool(
    "list_blueprints",
    "Search for blueprints across the full resman stack (base game + HAKs + module) by resref, tag, or display name (including TLK-resolved names). Returns type-specific summaries.",
    {
      type: z.enum(["utc", "uti", "utp", "utd", "utm", "ute"]).describe("Blueprint type to search"),
      pattern: z.string().describe("Search term — matches against resref, tag, and display name"),
      limit: z.string().optional().describe("Max results to return (default 20, max 50)"),
    },
    async ({ type: bpType, pattern: searchPattern, limit }) => {
      const index = requireIndex();
      const resman = await buildResmanOptions(index);
      const maxResults = Math.min(Math.max(toI(limit) || 20, 1), 50);
      const searchLower = searchPattern.toLowerCase();

      const hitResrefs = new Set<string>();

      // Layer 1: Resref name search
      try {
        const output = await resmanGrep({ ...resman, pattern: searchLower, details: true });
        for (const line of output.trim().split("\n").filter(Boolean)) {
          const match = line.match(/^(\S+)/);
          if (match && match[1].toLowerCase().endsWith(`.${bpType}`)) {
            hitResrefs.add(match[1].toLowerCase());
          }
        }
      } catch { /* no matches */ }

      // Layer 2: Binary content search (finds tags and hardcoded locstring names)
      try {
        const output = await resmanGrep({ ...resman, binary: searchPattern, details: true });
        for (const line of output.trim().split("\n").filter(Boolean)) {
          const match = line.match(/^(\S+)/);
          if (match && match[1].toLowerCase().endsWith(`.${bpType}`)) {
            hitResrefs.add(match[1].toLowerCase());
          }
        }
      } catch { /* no matches */ }

      // Layer 3: TLK name search — find strrefs containing the search term, then find blueprints referencing them
      const matchingStrrefs: number[] = [];
      if (index.baseTlk) {
        for (const [strref, text] of index.baseTlk) {
          if (text.toLowerCase().includes(searchLower)) {
            matchingStrrefs.push(strref);
            if (matchingStrrefs.length >= 100) break; // cap TLK search
          }
        }
      }
      if (index.customTlk) {
        for (const [strref, text] of index.customTlk) {
          if (text.toLowerCase().includes(searchLower)) {
            matchingStrrefs.push(strref + 0x01000000); // custom TLK offset
            if (matchingStrrefs.length >= 100) break;
          }
        }
      }
      // Binary-grep for strref references in GFF files (strrefs stored as decimal in JSON-serialized GFF)
      for (const strref of matchingStrrefs.slice(0, 10)) { // limit to 10 TLK greps
        try {
          const output = await resmanGrep({ ...resman, binary: String(strref), details: true });
          for (const line of output.trim().split("\n").filter(Boolean)) {
            const match = line.match(/^(\S+)/);
            if (match && match[1].toLowerCase().endsWith(`.${bpType}`)) {
              hitResrefs.add(match[1].toLowerCase());
            }
          }
        } catch { /* no matches */ }
      }

      if (hitResrefs.size === 0) {
        return { content: [{ type: "text", text: JSON.stringify({ matches: 0, results: [] }, null, 2) }] };
      }

      // Resolve summaries for up to maxResults hits
      const cacheDir = path.join(index.tempDir, "blueprint_cache");
      await fs.mkdir(cacheDir, { recursive: true });
      const tlkLookup = buildTlkLookup(index);
      const results: Record<string, unknown>[] = [];

      for (const resName of hitResrefs) {
        if (results.length >= maxResults) break;
        try {
          const doc = await resmanExtractToJson(resName, cacheDir, resman);
          const obj = doc as GffObj;
          const name = tlkLookup
            ? (getFieldLocStrResolved(obj, "LocalizedName", tlkLookup) || getFieldLocStrResolved(obj, "LocName", tlkLookup) || getFieldLocStrResolved(obj, "FirstName", tlkLookup))
            : (getFieldLocStr(obj, "LocalizedName") || getFieldLocStr(obj, "LocName") || getFieldLocStr(obj, "FirstName"));
          const tag = getFieldStr(obj, "Tag");
          const resref = resName.replace(`.${bpType}`, "");

          const entry: Record<string, unknown> = { resref, name, tag };

          switch (bpType) {
            case "utc":
              entry.cr = getFieldNum(obj, "ChallengeRating");
              entry.race = getFieldNum(obj, "Race");
              entry.faction = getFieldNum(obj, "FactionID");
              const classList = getFieldList(obj, "ClassList");
              if (classList.length > 0) {
                entry.classes = classList.map(c => ({
                  classId: getFieldNum(c, "Class"),
                  level: getFieldNum(c, "ClassLevel"),
                }));
              }
              break;
            case "uti":
              entry.baseItem = getFieldNum(obj, "BaseItem");
              entry.cost = getFieldNum(obj, "Cost");
              entry.plot = getFieldNum(obj, "Plot");
              break;
            case "utp":
              entry.appearance = getFieldNum(obj, "Appearance");
              entry.hasInventory = getFieldNum(obj, "HasInventory");
              entry.useable = getFieldNum(obj, "Useable");
              break;
            case "utd":
              entry.appearance = getFieldNum(obj, "GenericType");
              entry.locked = getFieldNum(obj, "Locked");
              entry.openLockDC = getFieldNum(obj, "OpenLockDC");
              break;
            case "utm":
              // Name and tag are sufficient for stores
              break;
            case "ute":
              entry.maxCreatures = getFieldNum(obj, "MaxCreatures");
              break;
          }

          results.push(entry);
        } catch { /* failed to resolve */ }
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({ matches: hitResrefs.size, returned: results.length, results }, null, 2),
        }],
      };
    },
  );
}

/** Format a GFF document into a more readable summary based on resource type */
function formatGffSummary(obj: GffObj, resource: string): GffObj {
  const ext = path.extname(resource).slice(1).toLowerCase();
  const base: GffObj = {
    resource,
    tag: getFieldStr(obj, "Tag"),
    resref: getFieldStr(obj, "TemplateResRef"),
  };

  // Common name fields
  const name = getFieldLocStr(obj, "LocalizedName") || getFieldLocStr(obj, "LocName") || getFieldLocStr(obj, "FirstName");
  if (name) base.name = name;
  const lastName = getFieldLocStr(obj, "LastName");
  if (lastName) base.lastName = lastName;

  const desc = getFieldLocStr(obj, "Description") || getFieldLocStr(obj, "DescIdentified");
  if (desc) base.description = desc;

  switch (ext) {
    case "uti": {
      base.baseItem = getFieldNum(obj, "BaseItem");
      base.cost = getFieldNum(obj, "Cost");
      base.addCost = getFieldNum(obj, "AddCost");
      base.identified = getFieldNum(obj, "Identified");
      base.plot = getFieldNum(obj, "Plot");
      base.stackSize = getFieldNum(obj, "StackSize");
      const props = getFieldList(obj, "PropertiesList");
      if (props.length > 0) {
        base.properties = props.map(p => ({
          propertyName: getFieldNum(p, "PropertyName"),
          subType: getFieldNum(p, "Subtype"),
          costTable: getFieldNum(p, "CostTable"),
          costValue: getFieldNum(p, "CostValue"),
          param1: getFieldNum(p, "Param1"),
          param1Value: getFieldNum(p, "Param1Value"),
        }));
      }
      break;
    }
    case "utc": {
      base.cr = getFieldNum(obj, "ChallengeRating");
      base.hp = getFieldNum(obj, "MaxHitPoints") || getFieldNum(obj, "CurrentHitPoints");
      base.race = getFieldNum(obj, "Race");
      base.gender = getFieldNum(obj, "Gender");
      base.faction = getFieldNum(obj, "FactionID");
      base.conversation = getFieldStr(obj, "Conversation");
      const classList = getFieldList(obj, "ClassList");
      if (classList.length > 0) {
        base.classes = classList.map(c => ({
          classId: getFieldNum(c, "Class"),
          level: getFieldNum(c, "ClassLevel"),
        }));
      }
      break;
    }
    case "utp": {
      base.appearance = getFieldNum(obj, "Appearance");
      base.hasInventory = getFieldNum(obj, "HasInventory");
      base.useable = getFieldNum(obj, "Useable");
      base.static = getFieldNum(obj, "Static");
      base.hp = getFieldNum(obj, "HP");
      base.hardness = getFieldNum(obj, "Hardness");
      break;
    }
    case "utd": {
      base.appearance = getFieldNum(obj, "GenericType");
      base.locked = getFieldNum(obj, "Locked");
      base.lockDC = getFieldNum(obj, "OpenLockDC");
      base.hp = getFieldNum(obj, "HP");
      base.hardness = getFieldNum(obj, "Hardness");
      base.linkedTo = getFieldStr(obj, "LinkedTo");
      break;
    }
    default: {
      // Return full raw GFF for unknown types
      base.rawGff = obj;
      break;
    }
  }

  return base;
}
