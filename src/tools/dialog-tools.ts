import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { requireIndex } from "../module-loader.js";
import { flattenDialog, renderDialogText, extractDialogScripts } from "../util/dialog-walker.js";
import { getFieldNum, getFieldStr, getFieldLocStr, getFieldList } from "../types/gff.js";
import type { GffObj } from "../types/gff.js";

export function registerDialogTools(server: McpServer): void {

  server.tool(
    "get_dialog_tree",
    "Get the raw dialog structure for a conversation file.",
    { dialog: z.string().describe("Dialog resref (e.g., 'salino')") },
    async ({ dialog }) => {
      const index = requireIndex();
      const key = `${dialog.toLowerCase()}.dlg`;
      const doc = index.parsedGff.get(key);
      if (!doc) return { content: [{ type: "text", text: `Dialog not found: ${dialog}` }] };
      return { content: [{ type: "text", text: JSON.stringify(doc, null, 2) }] };
    }
  );

  server.tool(
    "flatten_dialog",
    "Get a human-readable conversation flow showing NPC/PC lines with branching.",
    {
      dialog: z.string().describe("Dialog resref"),
      maxDepth: z.coerce.number().optional().describe("Maximum conversation depth to traverse (default: 10)"),
    },
    async ({ dialog, maxDepth }) => {
      const index = requireIndex();
      const key = `${dialog.toLowerCase()}.dlg`;
      const doc = index.parsedGff.get(key);
      if (!doc) return { content: [{ type: "text", text: `Dialog not found: ${dialog}` }] };

      const summary = index.dialogs.get(dialog.toLowerCase());
      const tree = flattenDialog(doc, maxDepth ?? 10);
      const text = renderDialogText(tree);

      let header = `Dialog: ${dialog}\n`;
      if (summary) {
        header += `Entries: ${summary.entryCount}, Replies: ${summary.replyCount}\n`;
        if (summary.usedByCreatures.length > 0) {
          header += `Used by: ${summary.usedByCreatures.join(", ")}\n`;
        }
        if (summary.scriptsUsed.length > 0) {
          header += `Scripts: ${summary.scriptsUsed.join(", ")}\n`;
        }
        if (summary.conditionsUsed.length > 0) {
          header += `Conditions: ${summary.conditionsUsed.join(", ")}\n`;
        }
      }
      header += "---\n";

      return { content: [{ type: "text", text: header + text }] };
    }
  );

  server.tool(
    "trace_dialog_path",
    "Follow a specific conversation path by choosing PC reply indices at each step.",
    {
      dialog: z.string().describe("Dialog resref"),
      replyIndices: z.array(z.coerce.number()).describe("Sequence of PC reply indices to follow"),
    },
    async ({ dialog, replyIndices }) => {
      const index = requireIndex();
      const key = `${dialog.toLowerCase()}.dlg`;
      const doc = index.parsedGff.get(key);
      if (!doc) return { content: [{ type: "text", text: `Dialog not found: ${dialog}` }] };

      const dlg = doc as GffObj;
      const entries = getFieldList(dlg, "EntryList");
      const replies = getFieldList(dlg, "ReplyList");
      const startingList = getFieldList(dlg, "StartingList");

      const path: Array<{ type: string; index: number; text: string; script?: string; condition?: string }> = [];

      // Start with first starting entry
      if (startingList.length === 0) {
        return { content: [{ type: "text", text: "Dialog has no starting entries" }] };
      }

      let entryIdx = getFieldNum(startingList[0], "Index");
      const _startActive = getFieldStr(startingList[0], "Active");

      let replyChoiceIdx = 0;

      while (entryIdx >= 0 && entryIdx < entries.length) {
        const entry = entries[entryIdx];
        const entryText = getFieldLocStr(entry, "Text");
        const entryScript = getFieldStr(entry, "Script");

        path.push({
          type: "NPC",
          index: entryIdx,
          text: entryText,
          script: entryScript || undefined,
        });

        const replyLinks = getFieldList(entry, "RepliesList");
        if (replyLinks.length === 0) break; // End of conversation

        // Pick the reply
        const chosenReplyLinkIdx = replyChoiceIdx < replyIndices.length
          ? Math.min(replyIndices[replyChoiceIdx], replyLinks.length - 1)
          : 0;
        const replyLink = replyLinks[chosenReplyLinkIdx];
        const replyIdx = getFieldNum(replyLink, "Index");
        const replyActive = getFieldStr(replyLink, "Active");

        if (replyIdx < 0 || replyIdx >= replies.length) break;

        const reply = replies[replyIdx];
        const replyText = getFieldLocStr(reply, "Text");
        const replyScript = getFieldStr(reply, "Script");

        path.push({
          type: "PC",
          index: replyIdx,
          text: replyText,
          script: replyScript || undefined,
          condition: replyActive || undefined,
        });

        replyChoiceIdx++;

        // Follow to next entry
        const entryLinks = getFieldList(reply, "EntriesList");
        if (entryLinks.length === 0) break;
        entryIdx = getFieldNum(entryLinks[0], "Index");
      }

      return { content: [{ type: "text", text: JSON.stringify(path, null, 2) }] };
    }
  );

  server.tool(
    "find_dialog_scripts",
    "Find all scripts referenced in dialog files (actions and conditions).",
    { dialog: z.string().optional().describe("Specific dialog resref, or omit to search all dialogs") },
    async ({ dialog }) => {
      const index = requireIndex();
      const results: Array<unknown> = [];

      if (dialog) {
        const key = `${dialog.toLowerCase()}.dlg`;
        const doc = index.parsedGff.get(key);
        if (!doc) return { content: [{ type: "text", text: `Dialog not found: ${dialog}` }] };
        results.push(...extractDialogScripts(dialog, doc));
      } else {
        for (const [resref] of index.dialogs) {
          const doc = index.parsedGff.get(`${resref}.dlg`);
          if (doc) {
            results.push(...extractDialogScripts(resref, doc));
          }
        }
      }

      return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
    }
  );
}
