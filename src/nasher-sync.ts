import { runNasherUnpack } from "./nasher-adapter.js";
import type { ModuleIndex } from "./types/module.js";

export interface NasherSyncOptions {
  reason?: string;
  removeDeleted?: boolean;
}

export interface NasherSyncResult {
  synced: true;
  reason?: string;
  workspaceRoot: string;
  target?: string;
  cacheDir: string;
  targetFile?: string;
  removeDeleted: boolean;
  unpack: {
    command: string;
    args: string[];
    stdout: string;
    stderr: string;
  };
}

export async function syncNasherSourceForIndex(
  index: ModuleIndex,
  options: NasherSyncOptions = {},
): Promise<NasherSyncResult | undefined> {
  const context = index.sourceContext;
  if (!context || context.type !== "nasher") return undefined;

  const removeDeleted = options.removeDeleted ?? false;
  const unpackResult = await runNasherUnpack(context.workspaceRoot, context.target, context.cacheDir, {
    removeDeleted,
  });

  return {
    synced: true,
    reason: options.reason,
    workspaceRoot: context.workspaceRoot,
    target: context.target,
    cacheDir: context.cacheDir,
    targetFile: context.targetFile,
    removeDeleted,
    unpack: {
      command: unpackResult.command,
      args: unpackResult.args,
      stdout: unpackResult.stdout.trim(),
      stderr: unpackResult.stderr.trim(),
    },
  };
}
