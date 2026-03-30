import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import { TEMP_BASE } from "../config.js";

/** Create a unique temp directory for extracting a module */
export async function createTempDir(modPath: string): Promise<string> {
  const hash = crypto.createHash("md5").update(modPath).digest("hex").slice(0, 8);
  const basename = path.basename(modPath, path.extname(modPath)).replace(/[^a-zA-Z0-9_-]/g, "_");
  const dir = path.join(TEMP_BASE, `${basename}_${hash}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/** Clean up a temp directory */
export async function cleanupTempDir(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}
