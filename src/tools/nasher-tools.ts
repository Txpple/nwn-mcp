import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Dirent } from "fs";
import fs from "fs/promises";
import path from "path";
import { z } from "zod";
import { getIndex } from "../module-loader.js";
import { detectNasherProject } from "../nasher-adapter.js";
import { syncNasherSourceForIndex } from "../nasher-sync.js";
import { loadNasherWorkspace, summarizeIndex } from "../nasher-workspace.js";
import type { NasherSourceContext } from "../types/module.js";

const SOURCE_EXTENSIONS = new Set([".json", ".nwnt", ".nss"]);
const SKIP_DIRS = new Set([".git", ".nasher", "node_modules", "dist", "build", "out", "coverage"]);

export function registerNasherTools(server: McpServer): void {
  server.tool(
    "detect_nasher_project",
    "Detect a Nasher project, Nasher/NWNT availability, targets, default target, and cache locations.",
    {
      workspaceRoot: z.string().optional().describe("Nasher project root. Defaults to cwd."),
    },
    { readOnlyHint: true, idempotentHint: true },
    async ({ workspaceRoot }) => {
      const detection = await detectNasherProject(workspaceRoot);
      return jsonResult(detection);
    },
  );

  server.tool(
    "load_nasher_workspace",
    "Build a Nasher target, then load its .nasher/cache/<target> loose resource directory as the current module.",
    {
      workspaceRoot: z.string().optional().describe("Nasher project root. Defaults to cwd."),
      target: z.string().optional().describe("Optional Nasher target name. If omitted, Nasher chooses its default."),
      clean: z.boolean().optional().describe("Run nasher pack --clean before loading. Defaults to false."),
    },
    async ({ workspaceRoot, target, clean }) => {
      return jsonResult(
        await loadNasherWorkspace({
          workspaceRoot,
          target,
          clean,
          entrypoint: "load_nasher_workspace",
        }),
      );
    },
  );

  server.tool(
    "sync_nasher_source",
    "Copy edited resources from the loaded Nasher cache back into the Nasher text source tree using nasher unpack.",
    {
      removeDeleted: z
        .boolean()
        .optional()
        .describe("Pass true to remove source files for resources deleted from the cache. Defaults to false."),
    },
    async ({ removeDeleted }) => {
      const index = getIndex();
      const context = index?.sourceContext;
      if (!context || context.type !== "nasher") {
        return jsonResult({
          success: false,
          message: "No Nasher workspace is loaded. Call load_nasher_workspace first.",
        });
      }

      const nasherSync = await syncNasherSourceForIndex(index, {
        reason: "sync_nasher_source",
        removeDeleted: removeDeleted ?? false,
      });
      return jsonResult({
        success: true,
        workspaceRoot: context.workspaceRoot,
        target: context.target,
        cacheDir: context.cacheDir,
        targetFile: context.targetFile,
        removeDeleted: removeDeleted ?? false,
        unpack: nasherSync?.unpack,
        nasherSync,
        recommendedNextAction: "Review the Nasher source tree with git diff.",
      });
    },
  );

  server.tool(
    "nasher_status",
    "Report the loaded Nasher context, cache timestamps, likely stale-cache signals, and next action.",
    {},
    { readOnlyHint: true, idempotentHint: true },
    async () => {
      const index = getIndex();
      const context = index?.sourceContext;
      if (!context || context.type !== "nasher") {
        return jsonResult({
          loaded: false,
          message: "No Nasher workspace is loaded. Use detect_nasher_project or load_nasher_workspace.",
        });
      }

      const timestamps = await getNasherTimestamps(context);
      const staleReasons = getStaleReasons(context, timestamps);
      return jsonResult({
        loaded: true,
        context,
        module: index ? summarizeIndex(index) : undefined,
        timestamps,
        likelyStale: staleReasons.length > 0,
        staleReasons,
        recommendedNextAction:
          staleReasons.length > 0
            ? "Reload with load_nasher_workspace before more edits; source files changed after this cache was loaded."
            : "Supported MCP writes auto-sync cache edits to Nasher text sources; use sync_nasher_source only to rerun unpack explicitly.",
      });
    },
  );
}

async function getNasherTimestamps(context: NasherSourceContext): Promise<Record<string, unknown>> {
  const configPath = path.join(context.workspaceRoot, "nasher.cfg");
  const [cacheDirMtime, configMtime, newestSource] = await Promise.all([
    getMtime(context.cacheDir),
    getMtime(configPath),
    findNewestNasherSource(context.workspaceRoot),
  ]);

  return {
    loadedAt: context.loadedAt,
    cacheDirMtime: cacheDirMtime?.toISOString(),
    configMtime: configMtime?.toISOString(),
    newestSourceFile: newestSource?.filePath,
    newestSourceMtime: newestSource?.mtime.toISOString(),
  };
}

function getStaleReasons(context: NasherSourceContext, timestamps: Record<string, unknown>): string[] {
  const loadedAt = Date.parse(context.loadedAt);
  const reasons: string[] = [];
  const configMtime = parseTimestamp(timestamps.configMtime);
  const newestSourceMtime = parseTimestamp(timestamps.newestSourceMtime);

  if (configMtime !== undefined && configMtime > loadedAt) {
    reasons.push("nasher.cfg is newer than the loaded cache context.");
  }
  if (newestSourceMtime !== undefined && newestSourceMtime > loadedAt) {
    reasons.push("A Nasher text source file is newer than the loaded cache context.");
  }

  return reasons;
}

async function findNewestNasherSource(root: string): Promise<{ filePath: string; mtime: Date } | null> {
  let newest: { filePath: string; mtime: Date } | null = null;

  async function walk(dir: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) {
          await walk(entryPath);
        }
        continue;
      }
      if (!entry.isFile() || !SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;

      const stat = await fs.stat(entryPath);
      if (!newest || stat.mtime > newest.mtime) {
        newest = { filePath: entryPath, mtime: stat.mtime };
      }
    }
  }

  await walk(root);
  return newest;
}

async function getMtime(filePath: string): Promise<Date | undefined> {
  try {
    return (await fs.stat(filePath)).mtime;
  } catch {
    return undefined;
  }
}

function parseTimestamp(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? undefined : timestamp;
}

function jsonResult(value: unknown): { content: Array<{ type: "text"; text: string }> } {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}
