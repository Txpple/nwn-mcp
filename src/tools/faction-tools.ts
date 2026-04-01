/**
 * Faction management MCP tools.
 *
 * Tools:
 * - create_faction: Add a new faction to the module's .fac file
 * - set_faction_reputation: Modify reputation between two factions
 */

import { z } from "zod";

import { numParam, optNumParam, toI } from "../util/params.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { requireIndex } from "../module-loader.js";
import { jsonToGff } from "../nim-tools.js";
import { getFieldStr, getFieldNum, getFieldList, setField } from "../types/gff.js";
import type { GffObj, GffDocument } from "../types/gff.js";

/** Find the .fac document and resource entry from the module index. */
function findFacDoc(index: ReturnType<typeof requireIndex>): {
  doc: GffDocument; obj: GffObj; filePath: string;
} | null {
  for (const [key, entry] of index.resources) {
    if (entry.extension === "fac") {
      const doc = index.parsedGff.get(key);
      if (doc) return { doc, obj: doc as GffObj, filePath: entry.filePath };
    }
  }
  return null;
}

export function registerFactionTools(server: McpServer): void {

  // ─── create_faction ───────────────────────────────────────────────────

  server.tool(
    "create_faction",
    "Add a new faction to the module's .fac file with reputation entries for all existing factions.",
    {
      name: z.string().describe("Faction display name"),
      parentId: optNumParam("Parent faction ID (default 4294967295 = no parent)"),
      global: optNumParam("Global flag (0 or 1, default 0)"),
      defaultReputation: optNumParam("Default reputation toward all existing factions (0-100, default 50)"),
    },
    async ({ name, parentId, global: globalFlag, defaultReputation }) => {
      const parentIdN = toI(parentId, 4294967295);
      const globalN = toI(globalFlag, 0);
      const defaultRepN = toI(defaultReputation, 50);

      const index = requireIndex();
      const fac = findFacDoc(index);
      if (!fac) return { content: [{ type: "text", text: "No .fac file found in module." }] };

      const factionList = getFieldList(fac.obj, "FactionList");
      const repList = getFieldList(fac.obj, "RepList");

      const newFactionId = factionList.length;

      // Add the faction entry
      factionList.push({
        __struct_id: newFactionId,
        FactionName: { type: "cexostring", value: name },
        FactionParentID: { type: "dword", value: parentIdN },
        FactionGlobal: { type: "byte", value: globalN },
      });

      // Add bilateral reputation entries for all existing factions
      for (let i = 0; i < newFactionId; i++) {
        repList.push({
          __struct_id: repList.length,
          FactionID1: { type: "dword", value: newFactionId },
          FactionID2: { type: "dword", value: i },
          FactionRep: { type: "int", value: defaultRepN },
        });
      }

      await jsonToGff(fac.doc, fac.filePath);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            factionId: newFactionId,
            name,
            parentId: parentIdN,
            global: globalN,
            reputationEntriesAdded: newFactionId,
            defaultReputation: defaultRepN,
          }, null, 2),
        }],
      };
    },
  );

  // ─── set_faction_reputation ───────────────────────────────────────────

  server.tool(
    "set_faction_reputation",
    "Modify reputation between two factions. Creates a new entry if none exists.",
    {
      faction1: numParam("First faction ID"),
      faction2: numParam("Second faction ID"),
      reputation: numParam("Reputation value (0=hostile, 50=neutral, 100=friendly)"),
    },
    { idempotentHint: true },
    async ({ faction1, faction2, reputation }) => {
      const f1 = toI(faction1), f2 = toI(faction2), rep = toI(reputation);

      const index = requireIndex();
      const fac = findFacDoc(index);
      if (!fac) return { content: [{ type: "text", text: "No .fac file found in module." }] };

      const factionList = getFieldList(fac.obj, "FactionList");
      const repList = getFieldList(fac.obj, "RepList");

      // Validate faction IDs
      if (f1 < 0 || f1 >= factionList.length) {
        return { content: [{ type: "text", text: `Invalid faction1 ID: ${f1}. Valid range: 0-${factionList.length - 1}` }] };
      }
      if (f2 < 0 || f2 >= factionList.length) {
        return { content: [{ type: "text", text: `Invalid faction2 ID: ${f2}. Valid range: 0-${factionList.length - 1}` }] };
      }

      // Find existing entry (either direction)
      let found = false;
      for (const entry of repList) {
        const id1 = getFieldNum(entry, "FactionID1");
        const id2 = getFieldNum(entry, "FactionID2");
        if ((id1 === f1 && id2 === f2) || (id1 === f2 && id2 === f1)) {
          setField(entry, "FactionRep", "int", rep);
          found = true;
          break;
        }
      }

      // Create new entry if not found
      if (!found) {
        repList.push({
          __struct_id: repList.length,
          FactionID1: { type: "dword", value: f1 },
          FactionID2: { type: "dword", value: f2 },
          FactionRep: { type: "int", value: rep },
        });
      }

      await jsonToGff(fac.doc, fac.filePath);

      const f1Name = getFieldStr(factionList[f1], "FactionName");
      const f2Name = getFieldStr(factionList[f2], "FactionName");

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            faction1: { id: f1, name: f1Name },
            faction2: { id: f2, name: f2Name },
            reputation: rep,
            action: found ? "updated" : "created",
          }, null, 2),
        }],
      };
    },
  );
}
