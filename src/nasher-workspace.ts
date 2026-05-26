import fs from "fs/promises";
import path from "path";
import { getIndex, loadModuleDirectory } from "./module-loader.js";
import type { NasherDetection, NasherTargetInfo } from "./nasher-adapter.js";
import {
  detectNasherProject,
  resolveCacheDir,
  resolveExpectedTarget,
  resolveNasherWorkspaceRoot,
  resolveRequestedTarget,
  runNasherPack,
} from "./nasher-adapter.js";
import type { ModuleIndex, NasherSourceContext } from "./types/module.js";

export interface LoadNasherWorkspaceOptions {
  workspaceRoot?: string;
  target?: string;
  clean?: boolean;
  autoRouted?: boolean;
  entrypoint?: string;
  reminders?: string[];
  detection?: NasherDetection;
}

export async function loadNasherWorkspace(options: LoadNasherWorkspaceOptions): Promise<Record<string, unknown>> {
  const root = resolveNasherWorkspaceRoot(options.workspaceRoot);
  const cleanBuild = options.clean ?? false;
  const warnings: string[] = [];
  const reminders = [...(options.reminders || [])];
  const loaded = getIndex();

  if (
    cleanBuild &&
    loaded?.sourceContext?.type === "nasher" &&
    path.resolve(loaded.sourceContext.workspaceRoot) === root
  ) {
    warnings.push(
      "clean:true rebuilds the Nasher cache. Supported MCP writes auto-sync to source, but manual cache-only edits may be discarded.",
    );
  }

  const detection = options.detection ?? (await detectNasherProject(root));
  warnings.push(...detection.warnings);
  if (!detection.hasConfig) {
    return {
      success: false,
      workspaceRoot: root,
      autoRouted: options.autoRouted ?? false,
      entrypoint: options.entrypoint,
      message: `nasher.cfg not found at ${detection.configPath}`,
      warningCount: warnings.length,
      warnings,
      reminderCount: reminders.length,
      reminders,
      detection,
    };
  }
  if (!detection.nasher.available) {
    return {
      success: false,
      workspaceRoot: root,
      autoRouted: options.autoRouted ?? false,
      entrypoint: options.entrypoint,
      message: detection.nasher.error || "Nasher executable is not available.",
      warningCount: warnings.length,
      warnings,
      reminderCount: reminders.length,
      reminders,
      detection,
    };
  }

  const requestedTarget = resolveRequestedTarget(options.target);
  const expectedTarget = resolveExpectedTarget(requestedTarget, detection);
  const packTarget = requestedTarget ? expectedTarget?.name || requestedTarget : undefined;
  const packResult = await runNasherPack(root, packTarget, cleanBuild);
  const cacheDir = await resolveLoadedCacheDir(root, requestedTarget, expectedTarget);
  const targetName = expectedTarget?.name || path.basename(cacheDir);
  const targetInfo = detection.targets.find((t) => t.name.toLowerCase() === targetName.toLowerCase()) || expectedTarget;

  const sourceContext: NasherSourceContext = {
    type: "nasher",
    workspaceRoot: root,
    target: targetName,
    cacheDir,
    targetFile: targetInfo?.targetFile,
    cleanBuild,
    loadedAt: new Date().toISOString(),
  };

  const index = await loadModuleDirectory(cacheDir, sourceContext);
  return {
    success: true,
    autoRouted: options.autoRouted ?? false,
    entrypoint: options.entrypoint,
    workspaceRoot: root,
    target: targetName,
    cacheDir,
    targetFile: sourceContext.targetFile,
    cleanBuild,
    module: summarizeIndex(index),
    warningCount: warnings.length + index.loadWarnings.length,
    warnings: [...warnings, ...index.loadWarnings.map((warning) => warning.message)],
    reminderCount: reminders.length,
    reminders,
    pack: {
      command: packResult.command,
      args: packResult.args,
      stdout: packResult.stdout.trim(),
      stderr: packResult.stderr.trim(),
    },
    sourceContext,
  };
}

export function summarizeIndex(index: ModuleIndex): Record<string, unknown> {
  const resourceTypes: Record<string, number> = {};
  for (const entry of index.resources.values()) {
    resourceTypes[entry.extension] = (resourceTypes[entry.extension] || 0) + 1;
  }

  return {
    moduleName: index.moduleName,
    modPath: index.modPath,
    areaCount: index.areas.size,
    resourceCount: index.resources.size,
    creatureCount: index.creatures.length,
    itemCount: index.items.length,
    dialogCount: index.dialogs.size,
    haks: index.hakList,
    customTlk: index.customTlkName || null,
    resourceTypes,
  };
}

async function resolveLoadedCacheDir(
  workspaceRoot: string,
  requestedTarget: string | undefined,
  expectedTarget: NasherTargetInfo | undefined,
): Promise<string> {
  if (expectedTarget) {
    if (await pathExists(expectedTarget.cacheDir)) return expectedTarget.cacheDir;
    if (requestedTarget) {
      throw new Error(
        `Nasher cache directory was not created for target "${requestedTarget}": ${expectedTarget.cacheDir}`,
      );
    }
  }
  const cacheDir = await resolveCacheDir(workspaceRoot);
  if (await pathExists(cacheDir)) return cacheDir;
  if (requestedTarget) {
    throw new Error(`Nasher cache directory was not created for target "${requestedTarget}": ${cacheDir}`);
  }
  return cacheDir;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
