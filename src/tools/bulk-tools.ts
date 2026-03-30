import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { requireIndex } from "../module-loader.js";
import { jsonToGff, readTextFile } from "../nim-tools.js";
import { numParam, optNumParam, toF } from "../util/params.js";
import { getFieldStr, getFieldNum, getFieldLocStr, getFieldList } from "../types/gff.js";
import type { GffObj } from "../types/gff.js";
import { getGitDoc, writeBackGit, updateAreaCounts } from "../util/git-helpers.js";
import { snapshotGitForUndo } from "../util/undo.js";
import { checkPlacementWalkable } from "../util/walkmesh.js";
import { buildResmanOptions } from "../module-loader.js";
import fs from "fs/promises";

/** List names excluded from walkability validation */
const WALK_CHECK_SKIP_LISTS = new Set(["Door List", "SoundList"]);

export function registerBulkTools(server: McpServer): void {

  server.tool(
    "rename_tag",
    "Rename a tag across all GFF resources and NWScript source files. Use dryRun=true to preview changes without modifying anything.",
    {
      oldTag: z.string().describe("Current tag value to find"),
      newTag: z.string().describe("New tag value to replace with"),
      dryRun: z.boolean().optional().default(true).describe("Preview changes without modifying (default: true)"),
    },
    async ({ oldTag, newTag, dryRun }) => {
      const index = requireIndex();
      const affected: Array<{ file: string; field: string; type: "gff" | "script" }> = [];

      // Find all GFF files with this tag
      for (const [key, doc] of index.parsedGff) {
        const changes = findTagFields(doc as GffObj, oldTag, "");
        for (const change of changes) {
          affected.push({ file: key, field: change, type: "gff" });
        }
      }

      // Find all script files referencing this tag
      for (const [key, entry] of index.resources) {
        if (entry.extension === "nss") {
          try {
            const source = await readTextFile(entry.filePath);
            if (source.includes(`"${oldTag}"`)) {
              affected.push({ file: key, field: "string literal", type: "script" });
            }
          } catch { /* skip unreadable */ }
        }
      }

      if (affected.length === 0) {
        return { content: [{ type: "text", text: `No occurrences of tag "${oldTag}" found.` }] };
      }

      if (dryRun) {
        return {
          content: [{
            type: "text",
            text: `Dry run: Would rename "${oldTag}" → "${newTag}" in ${affected.length} locations:\n` +
              JSON.stringify(affected, null, 2) +
              `\n\nRun with dryRun=false to apply changes.`,
          }],
        };
      }

      // Apply changes to GFF files
      let gffChanged = 0;
      for (const [key, doc] of index.parsedGff) {
        const changed = replaceTagFields(doc as GffObj, oldTag, newTag);
        if (changed > 0) {
          gffChanged += changed;
          // Write back to disk
          const entry = index.resources.get(key);
          if (entry) {
            await jsonToGff(doc, entry.filePath);
          }
        }
      }

      // Apply changes to script files
      let scriptChanged = 0;
      for (const [_key, entry] of index.resources) {
        if (entry.extension === "nss") {
          try {
            const source = await readTextFile(entry.filePath);
            if (source.includes(`"${oldTag}"`)) {
              const newSource = source.replaceAll(`"${oldTag}"`, `"${newTag}"`);
              await fs.writeFile(entry.filePath, newSource, "utf-8");
              scriptChanged++;
            }
          } catch { /* skip */ }
        }
      }

      return {
        content: [{
          type: "text",
          text: `Renamed "${oldTag}" → "${newTag}": ${gffChanged} GFF field(s), ${scriptChanged} script file(s) modified.\n` +
            `Remember to recompile affected scripts and repack the module.`,
        }],
      };
    }
  );

  server.tool(
    "find_by_resref_pattern",
    "Search for resources by resref pattern (case-insensitive substring match).",
    {
      pattern: z.string().describe("Substring to search for in resource names"),
      type: z.string().optional().describe("Filter by extension (e.g., 'nss', 'utc')"),
    },
    async ({ pattern, type }) => {
      const index = requireIndex();
      const patternLower = pattern.toLowerCase();
      const matches: Array<{ resref: string; extension: string; sizeBytes: number }> = [];

      for (const [, entry] of index.resources) {
        if (type && entry.extension !== type) continue;
        if (entry.resref.toLowerCase().includes(patternLower)) {
          matches.push({
            resref: entry.resref,
            extension: entry.extension,
            sizeBytes: entry.sizeBytes,
          });
        }
      }

      return { content: [{ type: "text", text: JSON.stringify(matches, null, 2) }] };
    }
  );

  // ─── bulk_remove_objects ──────────────────────────────────────────────

  server.tool(
    "bulk_remove_objects",
    "Remove objects matching a tag pattern from one or all areas. Use '*' as wildcard. Default: dry run (preview only).",
    {
      tagPattern: z.string().describe("Tag pattern. Use '*' as wildcard (e.g. 'goblin_*')"),
      listName: z.string().describe("GIT list name: 'Creature List', 'Placeable List', 'WaypointList', 'Door List', 'Trigger List', 'Encounter List', 'SoundList', 'StoreList'"),
      area: z.string().optional().describe("Area resref. Omit for all areas."),
      dryRun: z.boolean().optional().default(true).describe("Preview mode (default: true)"),
    },
    async ({ tagPattern, listName, area, dryRun }) => {
      const index = requireIndex();

      // Build regex from wildcard pattern
      const escaped = tagPattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
      const regex = new RegExp(`^${escaped}$`, "i");

      const areaResrefs = area ? [area] : [...index.areas.keys()];
      const matches: Array<{ area: string; tag: string; name: string; index: number }> = [];

      for (const areaResref of areaResrefs) {
        const gitDoc = index.parsedGff.get(`${areaResref}.git`);
        if (!gitDoc) continue;
        const git = gitDoc as GffObj;
        const list = getFieldList(git, listName);

        for (let i = 0; i < list.length; i++) {
          const tag = getFieldStr(list[i], "Tag");
          if (regex.test(tag)) {
            matches.push({
              area: areaResref,
              tag,
              name: getFieldLocStr(list[i], "FirstName") || getFieldLocStr(list[i], "LocalizedName") || getFieldLocStr(list[i], "LocName") || tag,
              index: i,
            });
          }
        }
      }

      if (matches.length === 0) {
        return { content: [{ type: "text", text: `No objects matching '${tagPattern}' in ${listName}.` }] };
      }

      if (dryRun) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              dryRun: true,
              pattern: tagPattern,
              matchCount: matches.length,
              matches,
              note: "Run with dryRun=false to remove.",
            }, null, 2),
          }],
        };
      }

      // Group by area and remove in reverse index order
      const byArea = new Map<string, number[]>();
      for (const m of matches) {
        const arr = byArea.get(m.area) || [];
        arr.push(m.index);
        byArea.set(m.area, arr);
      }

      for (const [areaResref, indices] of byArea) {
        const { doc: gitDoc, obj: git } = getGitDoc(index, areaResref);
        snapshotGitForUndo(gitDoc, areaResref, "bulk_remove_objects", `Bulk remove ${indices.length} from ${listName}`);
        const list = getFieldList(git, listName);
        // Sort descending to preserve indices during removal
        indices.sort((a, b) => b - a);
        for (const idx of indices) {
          list.splice(idx, 1);
        }
        await writeBackGit(index, areaResref, gitDoc);
        updateAreaCounts(index, areaResref);
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            pattern: tagPattern,
            removedCount: matches.length,
            areasAffected: byArea.size,
          }, null, 2),
        }],
      };
    },
  );

  // ─── bulk_move_objects ────────────────────────────────────────────────

  server.tool(
    "bulk_move_objects",
    "Move all objects with a given tag by an offset in an area.",
    {
      area: z.string().describe("Area resref"),
      tag: z.string().describe("Tag to match (exact)"),
      listName: z.string().describe("GIT list name"),
      offsetX: numParam("X offset"),
      offsetY: numParam("Y offset"),
      offsetZ: optNumParam("Z offset (default 0)"),
    },
    async ({ area, tag, listName, offsetX, offsetY, offsetZ }) => {
      const dx = toF(offsetX), dy = toF(offsetY), dz = toF(offsetZ);
      const index = requireIndex();
      const { doc: gitDoc, obj: git } = getGitDoc(index, area);
      const list = getFieldList(git, listName);

      // Determine position field names (placeables/doors use X/Y/Z; others use XPosition/YPosition/ZPosition)
      const usesXYZ = listName === "Placeable List" || listName === "Door List";
      const xField = usesXYZ ? "X" : "XPosition";
      const yField = usesXYZ ? "Y" : "YPosition";
      const zField = usesXYZ ? "Z" : "ZPosition";

      const matched = list.filter(obj => getFieldStr(obj, "Tag") === tag);
      if (matched.length === 0) {
        return { content: [{ type: "text", text: `No objects with tag '${tag}' in ${listName}.` }] };
      }

      // Walkmesh + buffer validation for each target position (skip doors and sounds)
      if (!WALK_CHECK_SKIP_LISTS.has(listName)) {
        const resmanOpts = await buildResmanOptions(index);
        const failures: string[] = [];
        for (const obj of matched) {
          const newX = getFieldNum(obj, xField) + dx;
          const newY = getFieldNum(obj, yField) + dy;
          const walkCheck = await checkPlacementWalkable(newX, newY, area.toLowerCase(), index, resmanOpts);
          if (!walkCheck.ok) {
            const objTag = getFieldStr(obj, "Tag");
            failures.push(`'${objTag}' at (${newX.toFixed(1)}, ${newY.toFixed(1)}): ${walkCheck.reason}`);
          }
        }
        if (failures.length > 0) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                error: "Bulk move blocked — target positions are not safe for placement",
                failures,
              }, null, 2),
            }],
          };
        }
      }

      snapshotGitForUndo(gitDoc, area, "bulk_move_objects", `Move ${matched.length} '${tag}' by (${dx}, ${dy}, ${dz})`);

      for (const obj of matched) {
        const curX = getFieldNum(obj, xField);
        const curY = getFieldNum(obj, yField);
        const curZ = getFieldNum(obj, zField);
        obj[xField] = { type: "float", value: curX + dx };
        obj[yField] = { type: "float", value: curY + dy };
        obj[zField] = { type: "float", value: curZ + dz };
      }

      await writeBackGit(index, area, gitDoc);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            area,
            tag,
            movedCount: matched.length,
            offset: { x: dx, y: dy, z: dz },
          }, null, 2),
        }],
      };
    },
  );
}

/** Recursively find all GFF paths where a Tag field matches the given value */
function findTagFields(obj: GffObj, tag: string, basePath: string): string[] {
  const paths: string[] = [];

  for (const [key, rawField] of Object.entries(obj)) {
    if (key === "__struct_id" || key === "__data_type") continue;
    const field = rawField as { type?: string; value?: unknown };
    if (!field || typeof field !== "object" || !("type" in field)) continue;

    const currentPath = basePath ? `${basePath}.${key}` : key;

    if (key === "Tag" && field.type === "cexostring" && field.value === tag) {
      paths.push(currentPath);
    }

    if (field.type === "list" && Array.isArray(field.value)) {
      for (let i = 0; i < (field.value as unknown[]).length; i++) {
        paths.push(...findTagFields((field.value as GffObj[])[i], tag, `${currentPath}[${i}]`));
      }
    } else if (field.type === "struct" && typeof field.value === "object" && field.value) {
      paths.push(...findTagFields(field.value as GffObj, tag, currentPath));
    }
  }

  return paths;
}

/** Recursively replace all Tag field values matching oldTag with newTag. Returns count of changes. */
function replaceTagFields(obj: GffObj, oldTag: string, newTag: string): number {
  let count = 0;

  for (const [key, rawField] of Object.entries(obj)) {
    if (key === "__struct_id" || key === "__data_type") continue;
    const field = rawField as { type?: string; value?: unknown };
    if (!field || typeof field !== "object" || !("type" in field)) continue;

    if (key === "Tag" && field.type === "cexostring" && field.value === oldTag) {
      field.value = newTag;
      count++;
    }

    if (field.type === "list" && Array.isArray(field.value)) {
      for (const item of field.value as GffObj[]) {
        count += replaceTagFields(item, oldTag, newTag);
      }
    } else if (field.type === "struct" && typeof field.value === "object" && field.value) {
      count += replaceTagFields(field.value as GffObj, oldTag, newTag);
    }
  }

  return count;
}
