/**
 * Journal CRUD MCP tools.
 *
 * Tools:
 * - get_journal: Read all journal entries organized by quest/category
 * - create_journal: Create a new .jrl file if none exists
 * - add_journal_quest: Add a new quest category
 * - add_journal_entry: Add an entry to an existing quest
 * - edit_journal_quest: Modify quest metadata
 * - edit_journal_entry: Modify an existing journal entry
 * - remove_journal_quest: Remove an entire quest category
 * - remove_journal_entry: Remove an entry from a quest
 */

import { z } from "zod";
import path from "path";
import fs from "fs/promises";

import { numParam, optNumParam, toI } from "../util/params.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { requireIndex } from "../module-loader.js";
import { jsonToGff } from "../nim-tools.js";
import { getFieldStr, getFieldNum, getFieldLocStr, getFieldList, setField } from "../types/gff.js";
import type { GffDocument, GffObj } from "../types/gff.js";
import type { ModuleIndex } from "../types/module.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Find the module's .jrl resource. Most modules have exactly one. */
function findJrl(index: ModuleIndex): { key: string; doc: GffDocument } | null {
  for (const [key, entry] of index.resources) {
    if (entry.extension === "jrl") {
      const doc = index.parsedGff.get(key);
      if (doc) return { key, doc };
    }
  }
  return null;
}

/** Get the Categories list from the JRL document. */
function getCategories(doc: GffDocument): GffObj[] {
  return getFieldList(doc as GffObj, "Categories");
}

/** Find a quest category by tag. */
function findQuestByTag(categories: GffObj[], tag: string): { quest: GffObj; index: number } | null {
  for (let i = 0; i < categories.length; i++) {
    if (getFieldStr(categories[i], "Tag") === tag) {
      return { quest: categories[i], index: i };
    }
  }
  return null;
}

/** Write the JRL back to disk. */
async function writeBackJrl(index: ModuleIndex, key: string, doc: GffDocument): Promise<void> {
  const entry = index.resources.get(key);
  if (entry) {
    await jsonToGff(doc, entry.filePath);
  }
}

// ─── Tool Registration ──────────────────────────────────────────────────────

export function registerJournalTools(server: McpServer): void {

  // ─── get_journal ──────────────────────────────────────────────────────

  server.tool(
    "get_journal",
    "Get all journal entries organized by quest/category.",
    {},
    { readOnlyHint: true, idempotentHint: true },
    async () => {
      const index = requireIndex();
      const quests: unknown[] = [];

      for (const [key, entry] of index.resources) {
        if (entry.extension === "jrl") {
          const doc = index.parsedGff.get(key);
          if (!doc) continue;
          const categories = getCategories(doc);

          for (const cat of categories) {
            const entries = getFieldList(cat, "EntryList").map(e => ({
              id: getFieldNum(e, "ID"),
              text: getFieldLocStr(e, "Text"),
              end: getFieldNum(e, "End"),
            }));

            quests.push({
              tag: getFieldStr(cat, "Tag"),
              name: getFieldLocStr(cat, "Name"),
              priority: getFieldNum(cat, "Priority"),
              comment: getFieldStr(cat, "Comment"),
              xp: getFieldNum(cat, "XP"),
              entries,
            });
          }
        }
      }

      return { content: [{ type: "text", text: JSON.stringify(quests, null, 2) }] };
    }
  );

  // ─── create_journal ───────────────────────────────────────────────────

  server.tool(
    "create_journal",
    "Create a new .jrl file if the module has none. Required before adding quests to a module without an existing journal.",
    {
      resref: z.string().optional().describe("JRL resref (default: 'module')"),
    },
    async ({ resref }) => {
      const index = requireIndex();

      // Check if a JRL already exists
      const existing = findJrl(index);
      if (existing) {
        return { content: [{ type: "text", text: `Journal already exists: ${existing.key}` }] };
      }

      const jrlResref = (resref || "module").toLowerCase();
      const key = `${jrlResref}.jrl`;

      const doc: GffDocument = {
        __data_type: "JRL ",
        Categories: { type: "list", value: [] },
      };

      const filePath = path.join(index.tempDir, `${jrlResref}.jrl`);
      await jsonToGff(doc, filePath);

      const stat = await fs.stat(filePath);
      index.resources.set(key, {
        resref: jrlResref,
        extension: "jrl",
        filePath,
        sizeBytes: stat.size,
      });
      index.parsedGff.set(key, doc);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            created: key,
            sizeBytes: stat.size,
          }, null, 2),
        }],
      };
    }
  );

  // ─── add_journal_quest ────────────────────────────────────────────────

  server.tool(
    "add_journal_quest",
    "Add a new quest category to the journal.",
    {
      tag: z.string().describe("Quest tag (unique identifier, used in scripts)"),
      name: z.string().describe("Quest display name"),
      priority: optNumParam("Quest priority (default 0)"),
      comment: z.string().optional().describe("Builder comment (not shown in-game)"),
      xp: optNumParam("Experience reward (default 0)"),
    },
    async ({ tag, name, priority, comment, xp }) => {
      const priorityN = toI(priority, 0), xpN = toI(xp, 0);
      const index = requireIndex();
      const jrl = findJrl(index);
      if (!jrl) {
        return { content: [{ type: "text", text: "No journal (.jrl) found in module. Use create_journal first." }] };
      }

      const categories = getCategories(jrl.doc);

      // Check for duplicate tag
      if (findQuestByTag(categories, tag)) {
        return { content: [{ type: "text", text: `Quest with tag '${tag}' already exists.` }] };
      }

      const quest: GffObj = {
        __struct_id: 0,
        Comment: { type: "cexostring", value: comment || "" },
        EntryList: { type: "list", value: [] },
        Name: { type: "cexolocstring", value: { "0": name } },
        Priority: { type: "dword", value: priorityN },
        Tag: { type: "cexostring", value: tag },
        XP: { type: "dword", value: xpN },
      };

      categories.push(quest);
      await writeBackJrl(index, jrl.key, jrl.doc);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            tag,
            name,
            questCount: categories.length,
          }, null, 2),
        }],
      };
    }
  );

  // ─── add_journal_entry ────────────────────────────────────────────────

  server.tool(
    "add_journal_entry",
    "Add an entry to an existing quest. Entries represent journal updates the player sees as the quest progresses.",
    {
      questTag: z.string().describe("Tag of the quest to add the entry to"),
      id: numParam("Entry ID (used in scripts with AddJournalQuestEntry)"),
      text: z.string().describe("Journal entry text shown to the player"),
      end: z.boolean().optional().describe("Whether this entry marks quest completion (default false)"),
    },
    async ({ questTag, id, text, end }) => {
      const idN = toI(id);
      const index = requireIndex();
      const jrl = findJrl(index);
      if (!jrl) {
        return { content: [{ type: "text", text: "No journal (.jrl) found in module." }] };
      }

      const categories = getCategories(jrl.doc);
      const result = findQuestByTag(categories, questTag);
      if (!result) {
        const available = categories.map(c => getFieldStr(c, "Tag")).filter(Boolean).join(", ");
        return { content: [{ type: "text", text: `Quest '${questTag}' not found. Available: ${available}` }] };
      }

      const entryList = getFieldList(result.quest, "EntryList");

      // Check for duplicate ID
      const existing = entryList.find(e => getFieldNum(e, "ID") === idN);
      if (existing) {
        return { content: [{ type: "text", text: `Entry with ID ${idN} already exists in quest '${questTag}'.` }] };
      }

      const entry: GffObj = {
        __struct_id: 0,
        End: { type: "word", value: end ? 1 : 0 },
        ID: { type: "dword", value: idN },
        Text: { type: "cexolocstring", value: { "0": text } },
      };

      entryList.push(entry);
      await writeBackJrl(index, jrl.key, jrl.doc);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            questTag,
            entryId: idN,
            end: end || false,
            entryCount: entryList.length,
          }, null, 2),
        }],
      };
    }
  );

  // ─── edit_journal_quest ───────────────────────────────────────────────

  server.tool(
    "edit_journal_quest",
    "Modify quest metadata (name, priority, comment, XP). Use add_journal_quest to create new quests.",
    {
      tag: z.string().describe("Tag of the quest to edit"),
      name: z.string().optional().describe("New quest display name"),
      priority: optNumParam("New priority"),
      comment: z.string().optional().describe("New builder comment"),
      xp: optNumParam("New experience reward"),
    },
    { idempotentHint: true },
    async ({ tag, name, priority, comment, xp }) => {
      const priorityN = priority !== undefined ? toI(priority) : undefined;
      const xpN = xp !== undefined ? toI(xp) : undefined;
      const index = requireIndex();
      const jrl = findJrl(index);
      if (!jrl) {
        return { content: [{ type: "text", text: "No journal (.jrl) found in module." }] };
      }

      const categories = getCategories(jrl.doc);
      const result = findQuestByTag(categories, tag);
      if (!result) {
        const available = categories.map(c => getFieldStr(c, "Tag")).filter(Boolean).join(", ");
        return { content: [{ type: "text", text: `Quest '${tag}' not found. Available: ${available}` }] };
      }

      if (name !== undefined) result.quest.Name = { type: "cexolocstring", value: { "0": name } };
      if (priorityN !== undefined) setField(result.quest, "Priority", "dword", priorityN);
      if (comment !== undefined) setField(result.quest, "Comment", "cexostring", comment);
      if (xpN !== undefined) setField(result.quest, "XP", "dword", xpN);

      await writeBackJrl(index, jrl.key, jrl.doc);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            tag,
            updated: {
              ...(name !== undefined && { name }),
              ...(priorityN !== undefined && { priority: priorityN }),
              ...(comment !== undefined && { comment }),
              ...(xpN !== undefined && { xp: xpN }),
            },
          }, null, 2),
        }],
      };
    }
  );

  // ─── edit_journal_entry ───────────────────────────────────────────────

  server.tool(
    "edit_journal_entry",
    "Modify an existing journal entry's text or completion flag.",
    {
      questTag: z.string().describe("Tag of the quest containing the entry"),
      id: numParam("Entry ID to edit"),
      text: z.string().optional().describe("New entry text"),
      end: z.boolean().optional().describe("Whether this entry marks quest completion"),
    },
    { idempotentHint: true },
    async ({ questTag, id, text, end }) => {
      const idN = toI(id);
      const index = requireIndex();
      const jrl = findJrl(index);
      if (!jrl) {
        return { content: [{ type: "text", text: "No journal (.jrl) found in module." }] };
      }

      const categories = getCategories(jrl.doc);
      const result = findQuestByTag(categories, questTag);
      if (!result) {
        return { content: [{ type: "text", text: `Quest '${questTag}' not found.` }] };
      }

      const entryList = getFieldList(result.quest, "EntryList");
      const entry = entryList.find(e => getFieldNum(e, "ID") === idN);
      if (!entry) {
        const ids = entryList.map(e => getFieldNum(e, "ID")).join(", ");
        return { content: [{ type: "text", text: `Entry ID ${idN} not found in quest '${questTag}'. Available IDs: ${ids}` }] };
      }

      if (text !== undefined) entry.Text = { type: "cexolocstring", value: { "0": text } };
      if (end !== undefined) setField(entry, "End", "word", end ? 1 : 0);

      await writeBackJrl(index, jrl.key, jrl.doc);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            questTag,
            entryId: idN,
            updated: {
              ...(text !== undefined && { text }),
              ...(end !== undefined && { end }),
            },
          }, null, 2),
        }],
      };
    }
  );

  // ─── remove_journal_quest ─────────────────────────────────────────────

  server.tool(
    "remove_journal_quest",
    "Remove an entire quest category and all its entries from the journal.",
    {
      tag: z.string().describe("Tag of the quest to remove"),
    },
    { destructiveHint: true },
    async ({ tag }) => {
      const index = requireIndex();
      const jrl = findJrl(index);
      if (!jrl) {
        return { content: [{ type: "text", text: "No journal (.jrl) found in module." }] };
      }

      const categories = getCategories(jrl.doc);
      const result = findQuestByTag(categories, tag);
      if (!result) {
        const available = categories.map(c => getFieldStr(c, "Tag")).filter(Boolean).join(", ");
        return { content: [{ type: "text", text: `Quest '${tag}' not found. Available: ${available}` }] };
      }

      const name = getFieldLocStr(result.quest, "Name");
      const entryCount = getFieldList(result.quest, "EntryList").length;
      categories.splice(result.index, 1);

      await writeBackJrl(index, jrl.key, jrl.doc);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            removed: { tag, name, entriesRemoved: entryCount },
            remainingQuests: categories.length,
          }, null, 2),
        }],
      };
    }
  );

  // ─── remove_journal_entry ─────────────────────────────────────────────

  server.tool(
    "remove_journal_entry",
    "Remove a specific entry from a quest by its ID.",
    {
      questTag: z.string().describe("Tag of the quest containing the entry"),
      id: numParam("Entry ID to remove"),
    },
    { destructiveHint: true },
    async ({ questTag, id }) => {
      const idN = toI(id);
      const index = requireIndex();
      const jrl = findJrl(index);
      if (!jrl) {
        return { content: [{ type: "text", text: "No journal (.jrl) found in module." }] };
      }

      const categories = getCategories(jrl.doc);
      const result = findQuestByTag(categories, questTag);
      if (!result) {
        return { content: [{ type: "text", text: `Quest '${questTag}' not found.` }] };
      }

      const entryList = getFieldList(result.quest, "EntryList");
      const entryIdx = entryList.findIndex(e => getFieldNum(e, "ID") === idN);
      if (entryIdx < 0) {
        const ids = entryList.map(e => getFieldNum(e, "ID")).join(", ");
        return { content: [{ type: "text", text: `Entry ID ${idN} not found in quest '${questTag}'. Available IDs: ${ids}` }] };
      }

      const removed = entryList[entryIdx];
      const text = getFieldLocStr(removed, "Text");
      entryList.splice(entryIdx, 1);

      await writeBackJrl(index, jrl.key, jrl.doc);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            questTag,
            removedEntry: { id, text: text?.substring(0, 80) },
            remainingEntries: entryList.length,
          }, null, 2),
        }],
      };
    }
  );
}
