import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModuleIndex } from "../types/module.js";

let workspaceRoot: string;
let cacheDir: string;
let mockIndex: ModuleIndex | null;

vi.mock("../nasher-adapter.js", () => ({
  detectNasherProject: vi.fn(async (root: string) => ({
    workspaceRoot: root,
    configPath: path.join(root, "nasher.cfg"),
    hasConfig: true,
    cacheRoot: path.join(root, ".nasher", "cache"),
    nasher: { available: true, command: "nasher", version: "nasher 0.20.0" },
    nwnt: { available: true, command: "nwn_nwnt", version: "nwnt 0.6.0" },
    targets: [
      {
        name: "demo",
        file: "modules/demo.mod",
        targetFile: path.join(root, "modules", "demo.mod"),
        cacheDir: path.join(root, ".nasher", "cache", "demo"),
        isDefault: true,
      },
    ],
    defaultTarget: {
      name: "demo",
      file: "modules/demo.mod",
      targetFile: path.join(root, "modules", "demo.mod"),
      cacheDir: path.join(root, ".nasher", "cache", "demo"),
      isDefault: true,
    },
    warnings: [],
  })),
  resolveCacheDir: vi.fn(async () => cacheDir),
  resolveExpectedTarget: vi.fn(
    (_requested: string | undefined, detection: { defaultTarget?: unknown }) => detection.defaultTarget,
  ),
  resolveNasherWorkspaceRoot: vi.fn((root?: string) => path.resolve(root || workspaceRoot)),
  resolveRequestedTarget: vi.fn((target?: string) => target),
  runNasherPack: vi.fn(async () => ({
    command: "nasher",
    args: ["pack", "demo"],
    cwd: workspaceRoot,
    stdout: "",
    stderr: "",
  })),
  runNasherUnpack: vi.fn(
    async (
      _workspaceRoot: string,
      target: string | undefined,
      cache: string,
      options?: { removeDeleted?: boolean },
    ) => ({
      command: "nasher",
      args: [
        "unpack",
        ...(target ? [target] : []),
        `--file:${cache}`,
        `--removeDeleted:${options?.removeDeleted ? "true" : "false"}`,
      ],
      cwd: workspaceRoot,
      stdout: "",
      stderr: "",
    }),
  ),
}));

vi.mock("../module-loader.js", () => ({
  getIndex: () => mockIndex,
  loadModuleDirectory: vi.fn(async (dir: string, sourceContext) => {
    mockIndex = {
      modPath: path.join(workspaceRoot, "modules", "demo.mod"),
      tempDir: dir,
      moduleName: "Demo",
      resources: new Map([
        ["module.ifo", { resref: "module", extension: "ifo", filePath: path.join(dir, "module.ifo"), sizeBytes: 10 }],
      ]),
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
    return mockIndex;
  }),
}));

beforeEach(async () => {
  workspaceRoot = path.join(os.tmpdir(), `nwn-mcp-nasher-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  cacheDir = path.join(workspaceRoot, ".nasher", "cache", "demo");
  await fs.mkdir(cacheDir, { recursive: true });
  await fs.writeFile(path.join(workspaceRoot, "nasher.cfg"), "");
  await fs.writeFile(path.join(cacheDir, "module.ifo"), "");
  mockIndex = null;
});

afterEach(async () => {
  await fs.rm(workspaceRoot, { recursive: true, force: true });
});

describe("nasher tools", () => {
  it("loads a nasher workspace and syncs source", async () => {
    const { registerNasherTools } = await import("./nasher-tools.js");
    const { client, cleanup } = await createTestClient(registerNasherTools);

    try {
      const loadResult = await client.callTool({
        name: "load_nasher_workspace",
        arguments: { workspaceRoot, target: "demo" },
      });
      const loaded = parseResult(loadResult) as Record<string, unknown>;
      expect(loaded.success).toBe(true);
      expect(loaded.target).toBe("demo");
      expect((loaded.sourceContext as Record<string, unknown>).cacheDir).toBe(cacheDir);

      const syncResult = await client.callTool({
        name: "sync_nasher_source",
        arguments: { removeDeleted: true },
      });
      const synced = parseResult(syncResult) as Record<string, unknown>;
      expect(synced.success).toBe(true);
      expect(synced.removeDeleted).toBe(true);
      expect((synced.unpack as Record<string, unknown>).args).toEqual([
        "unpack",
        "demo",
        `--file:${cacheDir}`,
        "--removeDeleted:true",
      ]);
      expect(synced.recommendedNextAction).toContain("git diff");
    } finally {
      await cleanup();
    }
  });
});

async function createTestClient(
  registerFn: (server: McpServer) => void,
): Promise<{ client: Client; cleanup: () => Promise<void> }> {
  const server = new McpServer({ name: "test", version: "1.0.0" });
  registerFn(server);
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(clientTransport);
  return {
    client,
    cleanup: async () => {
      await client.close();
      await server.close();
    },
  };
}

function parseResult(result: { content: Array<{ type: string; text?: string }> }): unknown {
  const textBlock = result.content.find((c) => c.type === "text");
  return textBlock?.text ? JSON.parse(textBlock.text) : null;
}
