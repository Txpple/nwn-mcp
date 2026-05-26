import { beforeEach, describe, expect, it, vi } from "vitest";
import { runNasherUnpack } from "../nasher-adapter.js";
import { jsonToGff } from "../nim-tools.js";
import type { GffDocument } from "../types/gff.js";
import type { ModuleIndex, NasherSourceContext } from "../types/module.js";
import { writeBackGit } from "./git-helpers.js";

vi.mock("../nim-tools.js", () => ({
  gffToJson: vi.fn(),
  jsonToGff: vi.fn(async () => {}),
  resmanExtractToJson: vi.fn(),
}));

vi.mock("../nasher-adapter.js", () => ({
  runNasherUnpack: vi.fn(async (workspaceRoot: string, target: string | undefined, cacheDir: string, options) => ({
    command: "nasher",
    args: [
      "unpack",
      ...(target ? [target] : []),
      `--file:${cacheDir}`,
      `--removeDeleted:${options?.removeDeleted ? "true" : "false"}`,
    ],
    cwd: workspaceRoot,
    stdout: " synced\n",
    stderr: "",
  })),
}));

vi.mock("../tools/tileset-tools.js", () => ({
  invalidateTagToAreaCache: vi.fn(),
}));

const jsonToGffMock = vi.mocked(jsonToGff);
const runNasherUnpackMock = vi.mocked(runNasherUnpack);

beforeEach(() => {
  jsonToGffMock.mockClear();
  runNasherUnpackMock.mockClear();
});

describe("writeBackGit Nasher sync", () => {
  it("writes GIT and GIC, then syncs Nasher source when loaded from Nasher", async () => {
    const sourceContext = makeNasherContext();
    const gitDoc = makeGitDoc(2);
    const gicDoc = makeGicDoc();
    const index = makeIndex(gitDoc, gicDoc, sourceContext);

    const result = await writeBackGit(index, "testarea", gitDoc);

    expect(jsonToGffMock).toHaveBeenCalledWith(gitDoc, "D:\\project\\.nasher\\cache\\demo\\testarea.git");
    expect(jsonToGffMock).toHaveBeenCalledWith(gicDoc, "D:\\project\\.nasher\\cache\\demo\\testarea.gic");
    expect(runNasherUnpackMock).toHaveBeenCalledWith(
      sourceContext.workspaceRoot,
      sourceContext.target,
      sourceContext.cacheDir,
      { removeDeleted: false },
    );
    expect(result?.synced).toBe(true);
    expect(result?.reason).toBe("writeBackGit:testarea");
  });

  it("does not run Nasher unpack for standalone modules", async () => {
    const gitDoc = makeGitDoc(1);
    const gicDoc = makeGicDoc();
    const index = makeIndex(gitDoc, gicDoc);

    const result = await writeBackGit(index, "testarea", gitDoc);

    expect(result).toBeUndefined();
    expect(runNasherUnpackMock).not.toHaveBeenCalled();
  });
});

function makeNasherContext(): NasherSourceContext {
  return {
    type: "nasher",
    workspaceRoot: "D:\\project",
    target: "demo",
    cacheDir: "D:\\project\\.nasher\\cache\\demo",
    targetFile: "D:\\project\\modules\\demo.mod",
    cleanBuild: false,
    loadedAt: "2026-05-21T00:00:00.000Z",
  };
}

function makeIndex(gitDoc: GffDocument, gicDoc: GffDocument, sourceContext?: NasherSourceContext): ModuleIndex {
  const tempDir = sourceContext?.cacheDir ?? "D:\\temp\\standalone";
  return {
    modPath: "D:\\project\\modules\\demo.mod",
    tempDir,
    moduleName: "Demo",
    resources: new Map([
      [
        "testarea.git",
        {
          resref: "testarea",
          extension: "git",
          filePath: `${tempDir}\\testarea.git`,
          sizeBytes: 10,
        },
      ],
      [
        "testarea.gic",
        {
          resref: "testarea",
          extension: "gic",
          filePath: `${tempDir}\\testarea.gic`,
          sizeBytes: 10,
        },
      ],
    ]),
    tags: new Map(),
    scripts: new Map(),
    areas: new Map(),
    dialogs: new Map(),
    creatures: [],
    items: [],
    parsedGff: new Map([
      ["testarea.git", gitDoc],
      ["testarea.gic", gicDoc],
    ]),
    twodaTables: new Map(),
    customTlk: null,
    baseTlk: null,
    hakList: [],
    customTlkName: "",
    loadWarnings: [],
    sourceContext,
  };
}

function makeGitDoc(creatureCount: number): GffDocument {
  return {
    __data_type: "GIT ",
    "Creature List": {
      type: "list",
      value: Array.from({ length: creatureCount }, (_, i) => ({
        __struct_id: 4,
        Tag: { type: "cexostring", value: `creature_${i}` },
      })),
    },
    "Door List": { type: "list", value: [] },
    "Encounter List": { type: "list", value: [] },
    "Placeable List": { type: "list", value: [] },
    SoundList: { type: "list", value: [] },
    StoreList: { type: "list", value: [] },
    TriggerList: { type: "list", value: [] },
    WaypointList: { type: "list", value: [] },
  } as GffDocument;
}

function makeGicDoc(): GffDocument {
  return {
    __data_type: "GIC ",
    "Creature List": { type: "list", value: [] },
    "Door List": { type: "list", value: [] },
    "Encounter List": { type: "list", value: [] },
    "Placeable List": { type: "list", value: [] },
    SoundList: { type: "list", value: [] },
    StoreList: { type: "list", value: [] },
    TriggerList: { type: "list", value: [] },
    WaypointList: { type: "list", value: [] },
  } as GffDocument;
}
