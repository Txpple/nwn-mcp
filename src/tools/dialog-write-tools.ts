/**
 * Dialog creation MCP tools.
 *
 * Tools:
 * - create_dialog: Create a new DLG conversation file from a simplified tree
 * - add_dialog_node: Add a node to an existing dialog
 * - edit_dialog_node: Edit text/script/sound/comment on an existing dialog node
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import fs from "fs/promises";
import path from "path";
import { z } from "zod";
import { buildDialogSummary, requireIndex } from "../module-loader.js";
import { jsonToGff } from "../nim-tools.js";
import type { GffDocument, GffObj } from "../types/gff.js";
import { getFieldList, getFieldLocStr, setField } from "../types/gff.js";
import { numParam, toI } from "../util/params.js";

// ─── Types ──────────────────────────────────────────────────────────────────

interface InputNode {
  speaker: "npc" | "pc";
  text: string;
  script?: string;
  condition?: string;
  children?: InputNode[];
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Build a link struct for StartingList, RepliesList, or EntriesList. */
function makeLink(index: number, condition?: string): GffObj {
  return {
    __struct_id: 0,
    Index: { type: "dword", value: index },
    Active: { type: "resref", value: condition || "" },
    IsChild: { type: "byte", value: 0 },
  } as unknown as GffObj;
}

/** Build an NPC entry struct with all standard NWN DLG fields. */
function makeEntry(text: string, script?: string): GffObj {
  return {
    __struct_id: 0,
    Animation: { type: "dword", value: 0 },
    AnimLoop: { type: "byte", value: 1 },
    Comment: { type: "cexostring", value: "" },
    Delay: { type: "dword", value: 4294967295 },
    Quest: { type: "cexostring", value: "" },
    RepliesList: { type: "list", value: [] },
    Script: { type: "resref", value: script || "" },
    Sound: { type: "resref", value: "" },
    Speaker: { type: "cexostring", value: "" },
    Text: { type: "cexolocstring", value: { "0": text } },
  } as unknown as GffObj;
}

/** Build a PC reply struct with all standard NWN DLG fields. */
function makeReply(text: string, script?: string): GffObj {
  return {
    __struct_id: 0,
    Animation: { type: "dword", value: 0 },
    AnimLoop: { type: "byte", value: 1 },
    Comment: { type: "cexostring", value: "" },
    Delay: { type: "dword", value: 4294967295 },
    EntriesList: { type: "list", value: [] },
    Quest: { type: "cexostring", value: "" },
    Script: { type: "resref", value: script || "" },
    Sound: { type: "resref", value: "" },
    Text: { type: "cexolocstring", value: { "0": text } },
  } as unknown as GffObj;
}

/**
 * Validate that the tree alternates NPC↔PC correctly.
 * Returns an error message string, or null if valid.
 */
function validateTree(nodes: InputNode[], expectedSpeaker: "npc" | "pc"): string | null {
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (node.speaker !== expectedSpeaker) {
      return `Node "${node.text.slice(0, 40)}..." has speaker="${node.speaker}" but expected "${expectedSpeaker}"`;
    }
    if (node.children?.length) {
      const nextSpeaker = expectedSpeaker === "npc" ? "pc" : "npc";
      const childErr = validateTree(node.children, nextSpeaker as "npc" | "pc");
      if (childErr) return childErr;
    }
  }
  return null;
}

/**
 * Flatten a tree of InputNodes into EntryList (NPC), ReplyList (PC), and StartingList.
 */
function flattenTree(roots: InputNode[]): {
  entryList: GffObj[];
  replyList: GffObj[];
  startingList: GffObj[];
} {
  const entryList: GffObj[] = [];
  const replyList: GffObj[] = [];
  const startingList: GffObj[] = [];

  function processEntry(node: InputNode): number {
    const entry = makeEntry(node.text, node.script);
    const idx = entryList.length;
    entryList.push(entry);

    if (node.children) {
      const replies = getFieldList(entry, "RepliesList");
      for (const child of node.children) {
        const replyIdx = processReply(child);
        replies.push(makeLink(replyIdx, child.condition));
      }
    }
    return idx;
  }

  function processReply(node: InputNode): number {
    const reply = makeReply(node.text, node.script);
    const idx = replyList.length;
    replyList.push(reply);

    if (node.children) {
      const entries = getFieldList(reply, "EntriesList");
      for (const child of node.children) {
        const entryIdx = processEntry(child);
        entries.push(makeLink(entryIdx, child.condition));
      }
    }
    return idx;
  }

  for (const root of roots) {
    const entryIdx = processEntry(root);
    startingList.push(makeLink(entryIdx, root.condition));
  }

  return { entryList, replyList, startingList };
}

// ─── Tool Registration ──────────────────────────────────────────────────────

export function registerDialogWriteTools(server: McpServer): void {
  // ─── create_dialog ────────────────────────────────────────────────────

  server.tool(
    "create_dialog",
    "Create a new DLG conversation file from a simplified tree structure. Root nodes must be NPC lines (speaker: 'npc'). The tree alternates NPC→PC→NPC.",
    {
      resref: z.string().describe("Dialog filename without extension"),
      nodes: z
        .string()
        .describe(
          "JSON array of dialog tree nodes: [{ speaker: 'npc'|'pc', text: string, script?: string, condition?: string, children?: [...] }]",
        ),
    },
    async ({ resref, nodes }) => {
      const index = requireIndex();
      const resrefLower = resref.toLowerCase();
      const key = `${resrefLower}.dlg`;

      if (index.resources.has(key)) {
        return {
          content: [{ type: "text", text: `Dialog already exists: ${key}. Use add_dialog_node to modify it.` }],
          isError: true,
        };
      }

      let parsed: InputNode[];
      try {
        parsed = JSON.parse(nodes);
      } catch (e) {
        return {
          content: [{ type: "text", text: `Invalid JSON: ${(e as Error).message}` }],
          isError: true,
        };
      }

      if (!Array.isArray(parsed) || parsed.length === 0) {
        return {
          content: [{ type: "text", text: "nodes must be a non-empty JSON array" }],
          isError: true,
        };
      }

      const treeErr = validateTree(parsed, "npc");
      if (treeErr) {
        return {
          content: [{ type: "text", text: `Tree validation failed: ${treeErr}` }],
          isError: true,
        };
      }

      const { entryList, replyList, startingList } = flattenTree(parsed);

      const doc: GffDocument = {
        __data_type: "DLG ",
        DelayEntry: { type: "dword", value: 0 },
        DelayReply: { type: "dword", value: 0 },
        NumWords: { type: "dword", value: 0 },
        EndConverAbort: { type: "resref", value: "" },
        EndConversation: { type: "resref", value: "" },
        PreventZoomIn: { type: "byte", value: 0 },
        StartingList: { type: "list", value: startingList },
        EntryList: { type: "list", value: entryList },
        ReplyList: { type: "list", value: replyList },
      };

      const filePath = path.join(index.tempDir, key);
      await jsonToGff(doc, filePath);

      const stat = await fs.stat(filePath);
      index.resources.set(key, {
        resref: resrefLower,
        extension: "dlg",
        filePath,
        sizeBytes: stat.size,
      });
      index.parsedGff.set(key, doc);

      const summary = buildDialogSummary(resrefLower, doc, index.creatures);
      index.dialogs.set(resrefLower, summary);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                success: true,
                resref: resrefLower,
                entries: entryList.length,
                replies: replyList.length,
                startingNodes: startingList.length,
                sizeBytes: stat.size,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  // ─── add_dialog_node ──────────────────────────────────────────────────

  server.tool(
    "add_dialog_node",
    "Add a node to an existing dialog. If parentType is 'entry', adds a PC reply linked from that entry. If parentType is 'reply', adds an NPC entry linked from that reply. If parentType is 'dialog', adds a new NPC root entry to the StartingList (use for quest-stage branching with condition scripts). For 'dialog' mode, parentIndex controls insertion position: 0 inserts at the beginning (evaluated first), -1 or omit appends at the end (evaluated last).",
    {
      dialog: z.string().describe("Dialog resref"),
      parentIndex: numParam("Index of parent node in its list (EntryList or ReplyList). For parentType 'dialog': 0=insert at start, -1=append at end"),
      parentType: z.enum(["entry", "reply", "dialog"]).describe("Type of parent: 'entry' adds PC reply, 'reply' adds NPC entry, 'dialog' adds NPC root entry to StartingList"),
      text: z.string().describe("Dialog text for the new node"),
      script: z.string().optional().describe("Action script resref (runs when node plays)"),
      condition: z.string().optional().describe("Condition script on the link from parent"),
    },
    async ({ dialog, parentIndex, parentType, text, script, condition }) => {
      const index = requireIndex();
      const parentIdx = toI(parentIndex);
      const resrefLower = dialog.toLowerCase();
      const key = `${resrefLower}.dlg`;

      const doc = index.parsedGff.get(key);
      if (!doc) {
        return {
          content: [{ type: "text", text: `Dialog not found: ${key}` }],
          isError: true,
        };
      }

      const dlg = doc as GffObj;
      const entries = getFieldList(dlg, "EntryList");
      const replies = getFieldList(dlg, "ReplyList");

      // ─── parentType: "dialog" — add a new NPC root entry to StartingList ─
      if (parentType === "dialog") {
        const newEntry = makeEntry(text, script);
        const newIndex = entries.length;
        entries.push(newEntry);

        const startingList = getFieldList(dlg, "StartingList");
        const link = makeLink(newIndex, condition);

        if (parentIdx <= 0 || parentIdx >= startingList.length) {
          // -1 or 0: insert at the beginning (highest priority, evaluated first)
          // Also handles out-of-range: append at end
          if (parentIdx === -1) {
            startingList.push(link);
          } else {
            startingList.unshift(link);
          }
        } else {
          startingList.splice(parentIdx, 0, link);
        }

        // Write back to disk
        const entry = index.resources.get(key);
        if (!entry) {
          return {
            content: [{ type: "text", text: `Resource entry not found for ${key}` }],
            isError: true,
          };
        }
        await jsonToGff(doc, entry.filePath);

        const summary = buildDialogSummary(resrefLower, doc, index.creatures);
        index.dialogs.set(resrefLower, summary);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: true,
                  dialog: resrefLower,
                  addedType: "entry",
                  addedIndex: newIndex,
                  parentType: "dialog",
                  startingListPosition: parentIdx === -1 ? startingList.length - 1 : (parentIdx <= 0 ? 0 : parentIdx),
                  totalEntries: entries.length,
                  totalReplies: replies.length,
                  totalStartingNodes: startingList.length,
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      // ─── parentType: "entry" or "reply" — add child node ─────────────────
      const parentList = parentType === "entry" ? entries : replies;
      if (parentIdx < 0 || parentIdx >= parentList.length) {
        return {
          content: [
            { type: "text", text: `${parentType} index ${parentIdx} out of range (0-${parentList.length - 1})` },
          ],
          isError: true,
        };
      }

      const parentNode = parentList[parentIdx];
      const targetList = parentType === "entry" ? replies : entries;
      const linkListName = parentType === "entry" ? "RepliesList" : "EntriesList";
      const newNodeType = parentType === "entry" ? "reply" : "entry";

      // Build the new node
      const newNode = newNodeType === "entry" ? makeEntry(text, script) : makeReply(text, script);

      const newIndex = targetList.length;
      targetList.push(newNode);

      // Ensure parent has the link list (handles previously-leaf nodes)
      let links: GffObj[];
      try {
        links = getFieldList(parentNode, linkListName);
      } catch {
        setField(parentNode, linkListName, "list", []);
        links = getFieldList(parentNode, linkListName);
      }
      links.push(makeLink(newIndex, condition));

      // Write back to disk
      const entry = index.resources.get(key);
      if (!entry) {
        return {
          content: [{ type: "text", text: `Resource entry not found for ${key}` }],
          isError: true,
        };
      }
      await jsonToGff(doc, entry.filePath);

      // Rebuild dialog summary
      const summary = buildDialogSummary(resrefLower, doc, index.creatures);
      index.dialogs.set(resrefLower, summary);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                success: true,
                dialog: resrefLower,
                addedType: newNodeType,
                addedIndex: newIndex,
                parentType,
                parentIndex: parentIdx,
                totalEntries: entries.length,
                totalReplies: replies.length,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  // ─── edit_dialog_node ────────────────────────────────────────────────

  server.tool(
    "edit_dialog_node",
    "Edit an existing dialog node's text, script, sound, or comment. Supports partial updates — only provided fields are changed. Note: conditions live on links (Active field), not nodes — use modify_gff_field for those.",
    {
      dialog: z.string().describe("Dialog resref"),
      nodeType: z.enum(["entry", "reply"]).describe("Node type: 'entry' (NPC line) or 'reply' (PC line)"),
      nodeIndex: numParam("Index of the node in EntryList or ReplyList"),
      text: z.string().optional().describe("New dialog text"),
      script: z.string().optional().describe("New action script resref (runs when node plays)"),
      sound: z.string().optional().describe("New sound resref"),
      comment: z.string().optional().describe("New builder comment"),
    },
    { idempotentHint: true },
    async ({ dialog, nodeType, nodeIndex, text, script, sound, comment }) => {
      if (text === undefined && script === undefined && sound === undefined && comment === undefined) {
        return { content: [{ type: "text", text: "Must provide at least one field to edit (text, script, sound, or comment)" }], isError: true };
      }

      const index = requireIndex();
      const idx = toI(nodeIndex);
      const resrefLower = dialog.toLowerCase();
      const key = `${resrefLower}.dlg`;

      const doc = index.parsedGff.get(key);
      if (!doc) {
        return { content: [{ type: "text", text: `Dialog not found: ${key}` }], isError: true };
      }

      const dlg = doc as GffObj;
      const list = nodeType === "entry" ? getFieldList(dlg, "EntryList") : getFieldList(dlg, "ReplyList");

      if (idx < 0 || idx >= list.length) {
        return { content: [{ type: "text", text: `${nodeType} index ${idx} out of range (0-${list.length - 1})` }], isError: true };
      }

      const node = list[idx];
      const changes: Record<string, unknown> = {};
      const oldText = getFieldLocStr(node, "Text");

      if (text !== undefined) {
        setField(node, "Text", "cexolocstring", { "0": text });
        changes.text = text;
      }
      if (script !== undefined) {
        setField(node, "Script", "resref", script);
        changes.script = script;
      }
      if (sound !== undefined) {
        setField(node, "Sound", "resref", sound);
        changes.sound = sound;
      }
      if (comment !== undefined) {
        setField(node, "Comment", "cexostring", comment);
        changes.comment = comment;
      }

      // Write back to disk
      const entry = index.resources.get(key);
      if (!entry) {
        return { content: [{ type: "text", text: `Resource entry not found for ${key}` }], isError: true };
      }
      await jsonToGff(doc, entry.filePath);

      // Rebuild dialog summary
      const summary = buildDialogSummary(resrefLower, doc, index.creatures);
      index.dialogs.set(resrefLower, summary);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            dialog: resrefLower,
            nodeType,
            nodeIndex: idx,
            oldText,
            changes,
          }, null, 2),
        }],
      };
    },
  );
}
