/**
 * Undo MCP tools.
 *
 * Tools:
 * - undo_last_change: Revert the most recent GIT mutation
 * - undo_history: View the undo stack metadata
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { requireIndex } from "../module-loader.js";
import { writeBackGit, updateAreaCounts } from "../util/git-helpers.js";
import { popUndo, getUndoStack } from "../util/undo.js";
import type { GffDocument } from "../types/gff.js";

export function registerUndoTools(server: McpServer): void {

  server.tool(
    "undo_last_change",
    "Revert the most recent GIT mutation (object placement, removal, linking, etc.).",
    {},
    async () => {
      const index = requireIndex();
      const entry = popUndo();

      if (!entry) {
        return { content: [{ type: "text", text: "Nothing to undo. The undo stack is empty." }] };
      }

      const key = `${entry.areaResref.toLowerCase()}.git`;
      const restoredDoc = JSON.parse(entry.snapshot) as GffDocument;

      // Restore the GIT document in memory and on disk
      index.parsedGff.set(key, restoredDoc);
      await writeBackGit(index, entry.areaResref, restoredDoc);
      updateAreaCounts(index, entry.areaResref);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            undone: {
              tool: entry.toolName,
              area: entry.areaResref,
              description: entry.description,
              timestamp: new Date(entry.timestamp).toISOString(),
            },
            remainingUndos: getUndoStack().length,
          }, null, 2),
        }],
      };
    },
  );

  server.tool(
    "undo_history",
    "View the undo stack — recent GIT mutations that can be reverted.",
    {},
    { readOnlyHint: true, idempotentHint: true },
    async () => {
      const stack = getUndoStack();
      if (stack.length === 0) {
        return { content: [{ type: "text", text: "Undo stack is empty." }] };
      }

      const entries = [...stack].reverse().map((e, i) => ({
        index: i,
        tool: e.toolName,
        area: e.areaResref,
        description: e.description,
        time: new Date(e.timestamp).toISOString(),
      }));

      return {
        content: [{
          type: "text",
          text: JSON.stringify({ count: entries.length, entries }, null, 2),
        }],
      };
    },
  );
}
