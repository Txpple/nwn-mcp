import { execFile, spawn } from "child_process";
import { promisify } from "util";
import path from "path";
import fs from "fs/promises";
import { nimtool } from "./config.js";
import type { GffDocument } from "./types/gff.js";

const execFileAsync = promisify(execFile);

const EXEC_TIMEOUT = 30_000;

/** Common resman options shared across all resman-based tools */
export interface ResmanOptions {
  root?: string;        // NWN_FOLDER_DATA - game install dir
  userDir?: string;     // NWN_FOLDER_USER - user documents dir
  erfs?: string[];      // HAK/ERF file paths (later = higher priority in resman)
  dirs?: string[];      // Extra loose directories (later = higher priority)
}

/** Build the common resman CLI args from options */
function buildResmanArgs(options: ResmanOptions): string[] {
  const args: string[] = [];
  if (options.root) args.push("--root", options.root);
  if (options.userDir) args.push("--userdirectory", options.userDir);
  if (options.erfs?.length) args.push("--erfs", options.erfs.join(","));
  if (options.dirs?.length) args.push("--dirs", options.dirs.join(","));
  return args;
}

/** Run a nimtool and return stdout as string */
async function run(
  tool: string,
  args: string[],
  options?: { cwd?: string; timeout?: number }
): Promise<string> {
  const toolPath = nimtool(tool);
  try {
    const { stdout } = await execFileAsync(toolPath, args, {
      cwd: options?.cwd,
      timeout: options?.timeout ?? EXEC_TIMEOUT,
      maxBuffer: 50 * 1024 * 1024, // 50MB for large modules
      encoding: "utf-8",
    });
    return stdout;
  } catch (err: unknown) {
    const e = err as { stderr?: string; message?: string; code?: string };
    const detail = e.stderr || e.message || "Unknown error";
    throw new Error(`${tool} failed: ${detail}`);
  }
}

/**
 * Pipe two nimtools together: tool1 args1 | tool2 args2
 * Returns stdout of tool2 as string.
 */
function pipe(
  tool1: string, args1: string[],
  tool2: string, args2: string[],
  options?: { timeout?: number }
): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeout = options?.timeout ?? EXEC_TIMEOUT;
    let settled = false;
    const settle = (fn: () => void) => { if (!settled) { settled = true; clearTimeout(timer); fn(); } };

    const proc1 = spawn(nimtool(tool1), args1, { stdio: ["ignore", "pipe", "pipe"] });
    const proc2 = spawn(nimtool(tool2), args2, { stdio: [proc1.stdout, "pipe", "pipe"] });

    let stdout = "";
    let stderr1 = "";
    let stderr2 = "";
    proc1.stderr.on("data", (d: Buffer) => { stderr1 += d.toString("utf-8"); });
    proc2.stdout.on("data", (d: Buffer) => { stdout += d.toString("utf-8"); });
    proc2.stderr.on("data", (d: Buffer) => { stderr2 += d.toString("utf-8"); });

    const timer = setTimeout(() => {
      proc1.kill();
      proc2.kill();
      settle(() => reject(new Error(`pipe ${tool1}|${tool2} timed out after ${timeout}ms`)));
    }, timeout);

    // Only resolve/reject once both processes have closed
    let proc1Code: number | null = null;
    let proc2Code: number | null = null;
    const checkDone = () => {
      if (proc1Code === null || proc2Code === null) return;
      if (proc1Code !== 0) {
        settle(() => reject(new Error(`${tool1} exited with code ${proc1Code}: ${stderr1}`)));
      } else if (proc2Code !== 0) {
        settle(() => reject(new Error(`${tool2} exited with code ${proc2Code}: ${stderr2}`)));
      } else {
        settle(() => resolve(stdout));
      }
    };

    proc1.on("close", (code) => { proc1Code = code ?? 1; checkDone(); });
    proc2.on("close", (code) => { proc2Code = code ?? 1; checkDone(); });
    proc1.on("error", (e) => { proc2.kill(); settle(() => reject(e)); });
    proc2.on("error", (e) => { proc1.kill(); settle(() => reject(e)); });
  });
}

// ─── ERF (MOD/HAK) ──────────────────────────────────────────────────────────

/** List contents of an ERF/MOD/HAK file */
export async function erfList(modPath: string): Promise<string[]> {
  const stdout = await run("nwn_erf", ["-f", modPath, "-t"]);
  return stdout.trim().split("\n").filter(Boolean);
}

/** Extract all files from an ERF/MOD/HAK into a directory */
export async function erfExtract(modPath: string, destDir: string): Promise<void> {
  await fs.mkdir(destDir, { recursive: true });
  await run("nwn_erf", ["-f", modPath, "-x"], { cwd: destDir });
}

/** Pack files from a directory into an ERF/MOD.
 *  Excludes the resman_2da/ cache directory and any directories (ERF is flat). */
/** Extensions that nwn_erf can pack into a module. Anything else is skipped. */
const PACKABLE_EXTENSIONS = new Set([
  "are", "git", "gic", "ifo", "uti", "utc", "utp", "utd",
  "utt", "utm", "ute", "utw", "uts", "dlg", "fac", "itp",
  "bic", "jrl", "gui", "nss", "ncs", "2da", "txi", "plt",
  "ssf", "ndb",
]);

export async function erfPack(sourceDir: string, outPath: string): Promise<void> {
  const entries = await fs.readdir(sourceDir, { withFileTypes: true });
  const files = entries
    .filter(e => e.isFile())       // only files, skip directories like resman_2da/
    .map(e => e.name)
    .filter(name => {
      const ext = name.split(".").pop()?.toLowerCase() ?? "";
      return PACKABLE_EXTENSIONS.has(ext);
    });
  await run("nwn_erf", ["-f", outPath, "-e", "MOD", "-c", ...files], { cwd: sourceDir });
}

// ─── GFF ─────────────────────────────────────────────────────────────────────

/** Convert a GFF binary file to JSON */
export async function gffToJson(filePath: string): Promise<GffDocument> {
  const stdout = await run("nwn_gff", ["-i", filePath, "-k", "json"]);
  return JSON.parse(stdout) as GffDocument;
}

/** Convert JSON back to a GFF binary file */
export async function jsonToGff(jsonData: GffDocument, outPath: string): Promise<void> {
  const jsonStr = JSON.stringify(jsonData);
  const tempJson = `${outPath}.tmp.json`;
  await fs.writeFile(tempJson, jsonStr, "utf-8");
  try {
    await run("nwn_gff", ["-i", tempJson, "-l", "json", "-o", outPath]);
  } finally {
    await fs.unlink(tempJson).catch(() => {});
  }
}

// ─── TLK / 2DA ───────────────────────────────────────────────────────────────

/** Convert a TLK file to JSON */
export async function tlkToJson(filePath: string): Promise<unknown> {
  const stdout = await run("nwn_tlk", ["-i", filePath, "-k", "json"]);
  return JSON.parse(stdout);
}

/**
 * Convert a 2DA file to a structured object via CSV output.
 * Returns { columns: string[], rows: [rowIndex, {col: val, ...}][] }
 */
export async function twodaToJson(filePath: string): Promise<{ columns: string[]; rows: Array<[number, Record<string, string>]> }> {
  const stdout = await run("nwn_twoda", ["-i", filePath, "-k", "csv", "--write-id-column"]);
  return parseTwodaCsv(stdout);
}

/** Parse CSV output from nwn_twoda --write-id-column into structured data */
function parseTwodaCsv(csv: string): { columns: string[]; rows: Array<[number, Record<string, string>]> } {
  const lines = csv.trim().split("\n");
  if (lines.length === 0) return { columns: [], rows: [] };

  const header = parseCSVLine(lines[0]);
  // First column is "ID" from --write-id-column
  const columns = header.slice(1);
  const rows: Array<[number, Record<string, string>]> = [];

  for (let i = 1; i < lines.length; i++) {
    const values = parseCSVLine(lines[i]);
    const idx = parseInt(values[0], 10);
    const rowData: Record<string, string> = {};
    for (let c = 0; c < columns.length; c++) {
      rowData[columns[c]] = values[c + 1] ?? "";
    }
    rows.push([Number.isNaN(idx) ? i - 1 : idx, rowData]);
  }

  return { columns, rows };
}

/** Parse a single CSV line handling quoted fields */
function parseCSVLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        current += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      fields.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

// ─── Script tools ────────────────────────────────────────────────────────────

/** Disassemble an NCS file */
export async function disassembleNcs(filePath: string): Promise<string> {
  return await run("nwn_asm", ["-d", filePath, "-G", "--no-color"]);
}

/** Compile an NSS file to NCS with full resman support for includes */
export async function compileScript(
  nssPath: string,
  outPath?: string,
  options?: {
    includePaths?: string[];
    resman?: ResmanOptions;
  }
): Promise<{ success: boolean; output: string }> {
  const args: string[] = [];
  if (outPath) args.push("-o", outPath);
  if (options?.resman) args.push(...buildResmanArgs(options.resman));
  if (options?.includePaths) {
    for (const inc of options.includePaths) args.push("-I", inc);
  }
  // nwn_script_comp takes the source file as a positional arg (must be last)
  args.push(nssPath);
  try {
    const output = await run("nwn_script_comp", args);
    return { success: true, output };
  } catch (err: unknown) {
    const e = err as { message?: string };
    return { success: false, output: e.message || "Compilation failed" };
  }
}

// ─── Resman utilities ────────────────────────────────────────────────────────

/**
 * Extract resources from the full NWN resman stack (KEY/BIF → HAKs → ovr → dirs).
 * Use `pattern` alone to extract matching files, `files` for specific names, or neither + all for everything.
 * NOTE: --pattern is a standalone filter — do NOT combine with --all (which ignores the filter).
 */
export async function resmanExtract(
  destDir: string,
  options: ResmanOptions & {
    files?: string[];     // Specific file names to extract
    pattern?: string;     // Substring pattern to filter by name
    all?: boolean;        // Extract everything (ignores pattern)
  }
): Promise<void> {
  await fs.mkdir(destDir, { recursive: true });
  const args = buildResmanArgs(options);
  args.push("-d", destDir, "--quiet");

  if (options.files?.length) {
    args.push(...options.files);
  } else if (options.pattern && !options.all) {
    args.push("--pattern", options.pattern);
  } else {
    args.push("--all");
  }

  await run("nwn_resman_extract", args, { timeout: 120_000 });
}

/**
 * Resolve a single resource from resman and return its GFF JSON.
 * Pipes: nwn_resman_cat <resource> | nwn_gff -i - -l gff -k json
 */
export async function resmanCatToJson(
  resourceName: string,
  options: ResmanOptions
): Promise<GffDocument> {
  const catArgs = [...buildResmanArgs(options), "--quiet", resourceName];
  const gffArgs = ["-i", "-", "-l", "gff", "-k", "json"];
  // Resman stack loading can be slow (BIFs, HAKs, override/) — use longer timeout
  const stdout = await pipe("nwn_resman_cat", catArgs, "nwn_gff", gffArgs, { timeout: 120_000 });
  return JSON.parse(stdout) as GffDocument;
}

/**
 * Resolve a single resource from resman via extract-then-parse (fast alternative to resmanCatToJson).
 * Extracts the file to cacheDir with nwn_resman_extract, then parses with nwn_gff.
 * Skips extraction if the file already exists on disk (cache hit).
 * ~0.14s vs 120s+ for the piped approach.
 */
export async function resmanExtractToJson(
  resourceName: string,
  cacheDir: string,
  options: ResmanOptions
): Promise<GffDocument> {
  const filePath = path.join(cacheDir, resourceName.toLowerCase());
  // Check disk cache first
  try {
    await fs.access(filePath);
  } catch {
    // Not cached — extract from resman
    await resmanExtract(cacheDir, { ...options, files: [resourceName] });
  }
  return gffToJson(filePath);
}

/**
 * Search for resources across the full resman stack by name pattern or binary content.
 * Returns raw output listing matching resource names.
 */
export async function resmanGrep(
  options: ResmanOptions & {
    pattern?: string;     // Name substring to search for
    binary?: string;      // Binary content to search for
    invert?: boolean;     // Invert match
    details?: boolean;    // Show more details
  }
): Promise<string> {
  const args = buildResmanArgs(options);
  if (options.pattern) args.push("--pattern", options.pattern);
  if (options.binary) args.push("--binary", options.binary);
  if (options.invert) args.push("--invert-match");
  if (options.details) args.push("--details");
  if (!options.pattern && !options.binary) args.push("--all");
  args.push("--quiet");
  return await run("nwn_resman_grep", args, { timeout: 60_000 });
}

/**
 * Get resman stack stats: container sizes, shadowing info, load order.
 */
export async function resmanStats(
  options: ResmanOptions & { detailed?: boolean }
): Promise<string> {
  const args = buildResmanArgs(options);
  if (options.detailed) args.push("-d");
  return await run("nwn_resman_stats", args, { timeout: 60_000 });
}

/**
 * Extract all hardcoded strings from an ERF into a TLK file.
 * nwn_erf_tlkify <tlk> <erf> <out>
 */
export async function erfTlkify(
  tlkPath: string,
  erfPath: string,
  outPath: string,
  options?: ResmanOptions
): Promise<string> {
  const args: string[] = [];
  if (options) args.push(...buildResmanArgs(options));
  args.push(tlkPath, erfPath, outPath);
  return await run("nwn_erf_tlkify", args, { timeout: 60_000 });
}

/** Read a text file (e.g., .nss source) */
export async function readTextFile(filePath: string): Promise<string> {
  return fs.readFile(filePath, "utf-8");
}
