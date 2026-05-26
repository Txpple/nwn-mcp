import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GffDocument } from "./types/gff.js";

vi.mock("./nim-tools.js", () => ({
  erfExtract: vi.fn(async () => {}),
  erfList: vi.fn(async () => []),
  gffToJson: vi.fn(async (filePath: string) => {
    const name = path.basename(filePath).toLowerCase();
    if (name === "module.ifo") {
      return {
        __data_type: "IFO ",
        Mod_Name: { type: "cexolocstring", value: { "0": "Loose Module" } },
        Mod_HakList: { type: "list", value: [] },
        Mod_CustomTlk: { type: "cexostring", value: "" },
      } as unknown as GffDocument;
    }
    if (name === "testarea.are") {
      return {
        __data_type: "ARE ",
        Name: { type: "cexolocstring", value: { "0": "Test Area" } },
        Width: { type: "int", value: 4 },
        Height: { type: "int", value: 5 },
        Tileset: { type: "resref", value: "ttf01" },
        Flags: { type: "dword", value: 0 },
      } as unknown as GffDocument;
    }
    if (name === "testarea.git") {
      return {
        __data_type: "GIT ",
        "Creature List": { type: "list", value: [] },
        "Placeable List": { type: "list", value: [] },
        "Door List": { type: "list", value: [] },
        "Encounter List": { type: "list", value: [] },
        TriggerList: { type: "list", value: [] },
        WaypointList: { type: "list", value: [] },
      } as unknown as GffDocument;
    }
    return {} as GffDocument;
  }),
  resmanExtract: vi.fn(async () => {}),
  tlkToJson: vi.fn(async () => ({})),
  twodaToJson: vi.fn(async () => ({ columns: [], rows: [] })),
}));

let tempDir: string;

beforeEach(async () => {
  tempDir = path.join(os.tmpdir(), `nwn-mcp-loader-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await fs.mkdir(tempDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe("loadModuleDirectory", () => {
  it("indexes loose resources with source context", async () => {
    await fs.writeFile(path.join(tempDir, "module.ifo"), "");
    await fs.writeFile(path.join(tempDir, "testarea.are"), "");
    await fs.writeFile(path.join(tempDir, "testarea.git"), "");
    await fs.writeFile(path.join(tempDir, "script.nss"), "void main() {}");

    const { loadModuleDirectory } = await import("./module-loader.js");
    const index = await loadModuleDirectory(tempDir, {
      type: "nasher",
      workspaceRoot: path.dirname(tempDir),
      target: "demo",
      cacheDir: tempDir,
      cleanBuild: false,
      loadedAt: new Date().toISOString(),
    });

    expect(index.moduleName).toBe("Loose Module");
    expect(index.resources.has("script.nss")).toBe(true);
    expect(index.areas.get("testarea")?.width).toBe(4);
    expect(index.sourceContext?.type).toBe("nasher");
    expect(index.tempDir).toBe(path.resolve(tempDir));
  });
});
