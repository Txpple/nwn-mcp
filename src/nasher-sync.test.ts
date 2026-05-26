import { beforeEach, describe, expect, it, vi } from "vitest";
import { runNasherUnpack } from "./nasher-adapter.js";
import { syncNasherSourceForIndex } from "./nasher-sync.js";
import type { ModuleIndex, NasherSourceContext } from "./types/module.js";

vi.mock("./nasher-adapter.js", () => ({
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

const runNasherUnpackMock = vi.mocked(runNasherUnpack);

beforeEach(() => {
  runNasherUnpackMock.mockClear();
});

describe("syncNasherSourceForIndex", () => {
  it("does nothing outside a Nasher-loaded module", async () => {
    const result = await syncNasherSourceForIndex(makeIndex());

    expect(result).toBeUndefined();
    expect(runNasherUnpackMock).not.toHaveBeenCalled();
  });

  it("runs nasher unpack for a Nasher-loaded module", async () => {
    const sourceContext = makeNasherContext();
    const result = await syncNasherSourceForIndex(makeIndex(sourceContext), { reason: "paint_tiles" });

    expect(runNasherUnpackMock).toHaveBeenCalledWith(
      sourceContext.workspaceRoot,
      sourceContext.target,
      sourceContext.cacheDir,
      { removeDeleted: false },
    );
    expect(result).toEqual({
      synced: true,
      reason: "paint_tiles",
      workspaceRoot: sourceContext.workspaceRoot,
      target: sourceContext.target,
      cacheDir: sourceContext.cacheDir,
      targetFile: sourceContext.targetFile,
      removeDeleted: false,
      unpack: {
        command: "nasher",
        args: ["unpack", "demo", "--file:D:\\project\\.nasher\\cache\\demo", "--removeDeleted:false"],
        stdout: "synced",
        stderr: "",
      },
    });
  });

  it("passes removeDeleted when requested", async () => {
    const sourceContext = makeNasherContext();
    await syncNasherSourceForIndex(makeIndex(sourceContext), {
      reason: "delete_area",
      removeDeleted: true,
    });

    expect(runNasherUnpackMock).toHaveBeenCalledWith(
      sourceContext.workspaceRoot,
      sourceContext.target,
      sourceContext.cacheDir,
      { removeDeleted: true },
    );
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

function makeIndex(sourceContext?: NasherSourceContext): ModuleIndex {
  return {
    modPath: "D:\\project\\modules\\demo.mod",
    tempDir: sourceContext?.cacheDir ?? "D:\\temp\\standalone",
    moduleName: "Demo",
    resources: new Map(),
    tags: new Map(),
    scripts: new Map(),
    areas: new Map(),
    dialogs: new Map(),
    creatures: [],
    items: [],
    parsedGff: new Map(),
    twodaTables: new Map(),
    customTlk: null,
    baseTlk: null,
    hakList: [],
    customTlkName: "",
    loadWarnings: [],
    sourceContext,
  };
}
