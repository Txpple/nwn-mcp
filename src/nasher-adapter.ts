import { execFile } from "child_process";
import fs from "fs/promises";
import path from "path";
import { promisify } from "util";
import {
  NASHER_BIN,
  NWN_FOLDER_DATA,
  NWN_FOLDER_USER,
  NWNT_BIN,
} from "./config.js";

const execFileAsync = promisify(execFile);
const NASHER_TIMEOUT = 120_000;
const ANSI_ESCAPE_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "g");

export interface ToolAvailability {
  available: boolean;
  command: string;
  version?: string;
  error?: string;
}

export interface NasherTargetInfo {
  name: string;
  file?: string;
  targetFile?: string;
  cacheDir: string;
  isDefault?: boolean;
}

export interface NasherDetection {
  workspaceRoot: string;
  configPath: string;
  hasConfig: boolean;
  cacheRoot: string;
  nasher: ToolAvailability;
  nwnt: ToolAvailability;
  targets: NasherTargetInfo[];
  defaultTarget?: NasherTargetInfo;
  warnings: string[];
}

export interface NasherCommandResult {
  command: string;
  args: string[];
  cwd: string;
  stdout: string;
  stderr: string;
}

export interface NasherUnpackOptions {
  removeDeleted?: boolean;
}

export function resolveNasherWorkspaceRoot(workspaceRoot?: string): string {
  return path.resolve(workspaceRoot || process.cwd());
}

export function buildNasherPackArgs(target?: string, clean = false): string[] {
  const args = ["pack"];
  if (target) args.push(target);
  if (clean) args.push("--clean");
  args.push("--packUnchanged", "--overwritePackedFile:always", "--no-color");
  return args;
}

export function buildNasherUnpackArgs(
  target: string | undefined,
  cacheDir: string,
  options: NasherUnpackOptions = {},
): string[] {
  const args = ["unpack"];
  if (target) args.push(target);
  args.push(
    `--file:${cacheDir}`,
    `--removeDeleted:${options.removeDeleted ? "true" : "false"}`,
    "--onMultipleSources:error",
    "--default",
    "--no-color",
  );
  return args;
}

export function parseNasherTargets(output: string, workspaceRoot: string): NasherTargetInfo[] {
  const targets = new Map<string, NasherTargetInfo>();

  for (const rawLine of stripAnsi(output).split(/\r?\n/)) {
    const parsed = parseTargetLine(rawLine, workspaceRoot);
    if (!parsed) continue;
    targets.set(parsed.name.toLowerCase(), parsed);
  }

  return [...targets.values()];
}

export async function detectNasherProject(workspaceRoot?: string): Promise<NasherDetection> {
  const resolvedRoot = resolveNasherWorkspaceRoot(workspaceRoot);
  const configPath = path.join(resolvedRoot, "nasher.cfg");
  const cacheRoot = path.join(resolvedRoot, ".nasher", "cache");
  const warnings: string[] = [];

  const hasConfig = await fileExists(configPath);
  const [nasher, nwnt] = await Promise.all([
    checkExecutable(NASHER_BIN, ["--version"], resolvedRoot),
    checkExecutable(NWNT_BIN, ["--version"], resolvedRoot),
  ]);

  let targets: NasherTargetInfo[] = [];
  let defaultTargetName: string | undefined;
  if (hasConfig) {
    try {
      const config = await parseNasherConfig(configPath, resolvedRoot);
      targets = config.targets;
      defaultTargetName = config.defaultTargetName;
    } catch (error) {
      warnings.push(`nasher.cfg parse failed: ${errorMessage(error)}`);
    }
  }

  if (hasConfig && nasher.available) {
    try {
      // `nasher list` without explicit targets lists all targets; --quiet keeps output to names only.
      const listOutput = await runNasherCommand(resolvedRoot, ["list", "--quiet", "--no-color"]);
      const listNames = parseNasherTargetNames(listOutput.stdout);
      if (listNames.length > 0) {
        targets = mergeNasherTargets(targets, listNames, resolvedRoot);
      }
    } catch (error) {
      warnings.push(`nasher list failed: ${errorMessage(error)}`);
    }
  }

  const defaultTarget = resolveDefaultNasherTarget(targets, defaultTargetName);

  return {
    workspaceRoot: resolvedRoot,
    configPath,
    hasConfig,
    cacheRoot,
    nasher,
    nwnt,
    targets,
    defaultTarget,
    warnings,
  };
}

export async function runNasherPack(
  workspaceRoot: string,
  target: string | undefined,
  clean: boolean,
): Promise<NasherCommandResult> {
  return runNasherCommand(workspaceRoot, buildNasherPackArgs(target, clean));
}

export async function runNasherUnpack(
  workspaceRoot: string,
  target: string | undefined,
  cacheDir: string,
  options: NasherUnpackOptions = {},
): Promise<NasherCommandResult> {
  return runNasherCommand(workspaceRoot, buildNasherUnpackArgs(target, cacheDir, options));
}

export function resolveRequestedTarget(target?: string): string | undefined {
  return target || undefined;
}

export function resolveExpectedTarget(
  requestedTarget: string | undefined,
  detection: NasherDetection,
): NasherTargetInfo | undefined {
  if (requestedTarget) {
    return (
      detection.targets.find((target) => target.name.toLowerCase() === requestedTarget.toLowerCase()) || {
        name: requestedTarget,
        cacheDir: path.join(detection.cacheRoot, requestedTarget),
      }
    );
  }
  return detection.defaultTarget;
}

export async function resolveCacheDir(workspaceRoot: string, expectedTarget?: NasherTargetInfo): Promise<string> {
  if (expectedTarget) return expectedTarget.cacheDir;

  const cacheRoot = path.join(workspaceRoot, ".nasher", "cache");
  const entries = await fs.readdir(cacheRoot, { withFileTypes: true });
  const dirs = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const dir = path.join(cacheRoot, entry.name);
        const stat = await fs.stat(dir);
        return { dir, mtimeMs: stat.mtimeMs };
      }),
  );
  dirs.sort((a, b) => b.mtimeMs - a.mtimeMs);
  if (!dirs[0]) {
    throw new Error(`Nasher cache directory not found under ${cacheRoot}`);
  }
  return dirs[0].dir;
}

async function runNasherCommand(workspaceRoot: string, args: string[]): Promise<NasherCommandResult> {
  try {
    const { stdout, stderr } = await execFileAsync(NASHER_BIN, args, {
      cwd: workspaceRoot,
      env: nasherEnv(),
      timeout: NASHER_TIMEOUT,
      maxBuffer: 50 * 1024 * 1024,
      encoding: "utf-8",
    });
    return {
      command: NASHER_BIN,
      args,
      cwd: workspaceRoot,
      stdout: stdout as string,
      stderr: stderr as string,
    };
  } catch (error) {
    const err = error as { stderr?: string; stdout?: string; message?: string; code?: string | number };
    const detail = err.stderr || err.stdout || err.message || "Unknown error";
    throw new Error(`nasher ${args.join(" ")} failed: ${detail}`);
  }
}

async function checkExecutable(command: string, args: string[], cwd: string): Promise<ToolAvailability> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd,
      env: nasherEnv(),
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
      encoding: "utf-8",
    });
    const output = `${stdout as string}${stderr as string}`.trim();
    return {
      available: true,
      command,
      version: output.split(/\r?\n/).find(Boolean) || undefined,
    };
  } catch (error) {
    return {
      available: false,
      command,
      error: errorMessage(error),
    };
  }
}

function nasherEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (NWN_FOLDER_DATA && !env.NWN_ROOT) env.NWN_ROOT = NWN_FOLDER_DATA;
  if (NWN_FOLDER_USER && !env.NWN_HOME) env.NWN_HOME = NWN_FOLDER_USER;
  return env;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function stripAnsi(value: string): string {
  return value.replace(ANSI_ESCAPE_PATTERN, "");
}

function parseNasherTargetNames(output: string): string[] {
  return stripAnsi(output)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function mergeNasherTargets(
  configTargets: NasherTargetInfo[],
  listNames: string[],
  workspaceRoot: string,
): NasherTargetInfo[] {
  const byName = new Map(configTargets.map((target) => [target.name.toLowerCase(), target]));
  const merged: NasherTargetInfo[] = [];
  const seen = new Set<string>();

  const orderedNames = listNames.length > 0 ? listNames : configTargets.map((target) => target.name);
  for (const name of orderedNames) {
    const key = name.toLowerCase();
    const existing = byName.get(key);
    if (existing) {
      merged.push(existing);
    } else {
      merged.push({
        name,
        cacheDir: path.join(workspaceRoot, ".nasher", "cache", name),
      });
    }
    seen.add(key);
  }

  for (const target of configTargets) {
    const key = target.name.toLowerCase();
    if (!seen.has(key)) {
      merged.push(target);
    }
  }

  return merged;
}

function resolveDefaultNasherTarget(
  targets: NasherTargetInfo[],
  defaultTargetName?: string,
): NasherTargetInfo | undefined {
  if (defaultTargetName) {
    const match = targets.find((target) => target.name.toLowerCase() === defaultTargetName.toLowerCase());
    if (match) return match;
  }
  return targets.find((target) => target.isDefault) || (targets.length === 1 ? targets[0] : undefined);
}

async function parseNasherConfig(
  configPath: string,
  workspaceRoot: string,
): Promise<{ targets: NasherTargetInfo[]; defaultTargetName?: string }> {
  const text = await fs.readFile(configPath, "utf-8");
  const lines = text.split(/\r?\n/);
  const targets: Array<{
    name?: string;
    file?: string;
    default?: boolean;
    order: number;
  }> = [];

  let packageFile: string | undefined;
  let packageDefault: string | undefined;
  let currentTarget: (typeof targets)[number] | null = null;
  let currentSection = "";

  for (const rawLine of lines) {
    const line = stripNasherComments(rawLine).trim();
    if (!line) continue;

    const sectionMatch = line.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      currentSection = sectionMatch[1].trim().toLowerCase();
      if (currentSection === "target") {
        currentTarget = { order: targets.length };
        targets.push(currentTarget);
      } else if (!currentSection.startsWith("target.")) {
        currentTarget = null;
      }
      continue;
    }

    const kvMatch = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
    if (!kvMatch) continue;
    const key = kvMatch[1].toLowerCase();
    const value = parseNasherScalar(kvMatch[2]);

    if (currentSection === "package") {
      if (key === "file") {
        packageFile = value.string;
      } else if (key === "default") {
        packageDefault = value.string;
      }
      continue;
    }

    if (currentSection === "target" && currentTarget) {
      if (key === "name") {
        currentTarget.name = value.string;
      } else if (key === "file") {
        currentTarget.file = value.string;
      } else if (key === "default") {
        currentTarget.default = value.boolean ?? false;
      }
    }
  }

  const resolvedTargets: NasherTargetInfo[] = [];
  for (const target of targets) {
    if (!target.name) continue;
    const rawFile = target.file || packageFile;
    const resolvedFile = rawFile ? resolveNasherTemplate(rawFile, target.name) : undefined;
    const targetFile = resolvedFile ? resolveMaybeRelative(workspaceRoot, resolvedFile) : undefined;
    resolvedTargets.push({
      name: target.name,
      file: resolvedFile,
      targetFile,
      cacheDir: path.join(workspaceRoot, ".nasher", "cache", target.name),
      isDefault: target.default || packageDefault?.toLowerCase() === target.name.toLowerCase(),
    });
  }

  if (resolvedTargets.length > 0 && !resolvedTargets.some((target) => target.isDefault)) {
    resolvedTargets[0].isDefault = true;
  }

  return {
    targets: resolvedTargets,
    defaultTargetName: packageDefault,
  };
}

function stripNasherComments(line: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
    } else if (ch === "#" && !inSingle && !inDouble) {
      return line.slice(0, i);
    }
  }
  return line;
}

function parseNasherScalar(raw: string): { string?: string; boolean?: boolean } {
  const trimmed = raw.trim();
  if (/^(true|false)$/i.test(trimmed)) {
    return { boolean: trimmed.toLowerCase() === "true", string: trimmed.toLowerCase() };
  }
  const quoted = trimmed.match(/^(['"])(.*)\1$/);
  if (quoted) {
    return { string: quoted[2] };
  }
  return { string: trimmed };
}

function resolveNasherTemplate(value: string, targetName: string): string {
  let result = value.trim();
  result = result.replace(/\$\{target\}|\$target/g, targetName);
  result = result.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (_match, braceName, plainName) => {
      const varName = (braceName || plainName) as string;
      if (varName.toLowerCase() === "target") return targetName;
      return process.env[varName] || process.env[varName.toUpperCase()] || `$${varName}`;
    },
  );
  return result;
}

function parseTargetLine(rawLine: string, workspaceRoot: string): NasherTargetInfo | null {
  const trimmed = rawLine.trim();
  if (!trimmed || isListHeader(trimmed)) return null;

  const isDefault = /^\*/.test(trimmed) || /\bdefault\b/i.test(trimmed);
  const line = trimmed
    .replace(/^[-*]\s*/, "")
    .replace(/\[(?:default|active)\]/gi, "")
    .replace(/\((?:default|active)\)/gi, "")
    .trim();

  const file = extractTargetFile(line);
  let name = extractTargetName(line, file);

  if (!name && file) {
    name = path.basename(file, path.extname(file));
  }
  if (!name || isListHeader(name)) return null;

  const targetFile = file ? resolveMaybeRelative(workspaceRoot, file) : undefined;
  return {
    name,
    file,
    targetFile,
    cacheDir: path.join(workspaceRoot, ".nasher", "cache", name),
    isDefault,
  };
}

function isListHeader(line: string): boolean {
  return /^(available\s+)?targets?:?$/i.test(line) || /^name\s+file/i.test(line) || /^[-\s]+$/.test(line);
}

function extractTargetFile(line: string): string | undefined {
  const quoted = line.match(/["']([^"']+\.(?:mod|hak|erf|nwm))["']/i);
  const rawFile = quoted?.[1] || line.match(/([^\s:()]+?\.(?:mod|hak|erf|nwm))/i)?.[1];
  return rawFile?.replace(/^["']|["']$/g, "");
}

function extractTargetName(line: string, file?: string): string | undefined {
  const withoutFile = file ? line.replace(file, " ") : line;
  const colon = withoutFile.match(/^([^:=]+?)\s*[:=]/);
  const arrow = withoutFile.match(/^(.+?)\s*(?:->|=>)/);
  const candidate = (colon?.[1] || arrow?.[1] || withoutFile.split(/\s+/)[0] || "")
    .replace(/^target\s+/i, "")
    .replace(/^name\s+/i, "")
    .trim();

  return sanitizeTargetName(candidate);
}

function sanitizeTargetName(value: string): string | undefined {
  const cleaned = value
    .replace(/["']/g, "")
    .replace(/[()[\],]/g, "")
    .trim();
  if (!cleaned || /^(target|name|file|default)$/i.test(cleaned)) return undefined;
  return cleaned;
}

function resolveMaybeRelative(root: string, filePath: string): string {
  return path.isAbsolute(filePath) ? filePath : path.resolve(root, filePath);
}

function errorMessage(error: unknown): string {
  const err = error as { stderr?: string; stdout?: string; message?: string; code?: string | number };
  return err.stderr || err.stdout || err.message || String(error);
}
