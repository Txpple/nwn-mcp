import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModuleIndex } from "../types/module.js";

let workspaceRoot: string;

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
        name: "demo-target",
        file: "modules/demo.mod",
        targetFile: path.join(root, "modules", "demo.mod"),
        cacheDir: path.join(root, ".nasher", "cache", "demo-target"),
        isDefault: true,
      },
    ],
    defaultTarget: {
      name: "demo-target",
      file: "modules/demo.mod",
      targetFile: path.join(root, "modules", "demo.mod"),
      cacheDir: path.join(root, ".nasher", "cache", "demo-target"),
      isDefault: true,
    },
    warnings: [],
  })),
  resolveNasherWorkspaceRoot: vi.fn(() => workspaceRoot),
}));

vi.mock("../nasher-workspace.js", () => ({
  loadNasherWorkspace: vi.fn(async (options: Record<string, unknown>) => ({
    success: true,
    autoRouted: options.autoRouted,
    entrypoint: options.entrypoint,
    target: options.target,
    reminderCount: Array.isArray(options.reminders) ? options.reminders.length : 0,
    reminders: options.reminders,
  })),
}));

vi.mock("../module-loader.js", () => ({
  loadModule: vi.fn(async (modPath: string) => createModuleIndex(modPath)),
  requireIndex: vi.fn(),
}));

beforeEach(async () => {
  vi.clearAllMocks();
  workspaceRoot = path.join(os.tmpdir(), `nwn-mcp-core-read-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await fs.mkdir(path.join(workspaceRoot, "modules"), { recursive: true });
});

afterEach(async () => {
  await fs.rm(workspaceRoot, { recursive: true, force: true });
});

describe("load_module Nasher routing", () => {
  it("auto-routes to the Nasher workspace when nasher.cfg is detected", async () => {
    await fs.writeFile(path.join(workspaceRoot, "nasher.cfg"), "");
    const { registerCoreReadTools } = await import("./core-read.js");
    const { loadNasherWorkspace } = await import("../nasher-workspace.js");
    const { loadModule } = await import("../module-loader.js");
    const { client, cleanup } = await createTestClient(registerCoreReadTools);

    try {
      const result = await client.callTool({
        name: "load_module",
        arguments: { modPath: "modules/demo.mod" },
      });
      const loaded = parseResult(result) as Record<string, unknown>;

      expect(loaded.success).toBe(true);
      expect(loaded.autoRouted).toBe(true);
      expect(loaded.entrypoint).toBe("load_module");
      expect(loaded.target).toBe("demo-target");
      expect(loaded.reminderCount).toBe(1);
      expect((loaded.reminders as string[])[0]).toContain("automatically used load_nasher_workspace");
      expect(loadNasherWorkspace).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceRoot,
          target: "demo-target",
          autoRouted: true,
          entrypoint: "load_module",
        }),
      );
      expect(loadModule).not.toHaveBeenCalled();
    } finally {
      await cleanup();
    }
  });

  it("keeps the standalone module path when no nasher.cfg is detected", async () => {
    const { registerCoreReadTools } = await import("./core-read.js");
    const { loadModule } = await import("../module-loader.js");
    const { loadNasherWorkspace } = await import("../nasher-workspace.js");
    const { detectNasherProject } = await import("../nasher-adapter.js");
    const { client, cleanup } = await createTestClient(registerCoreReadTools);

    try {
      const result = await client.callTool({
        name: "load_module",
        arguments: { modPath: "standalone.mod" },
      });
      const loaded = parseResult(result) as Record<string, unknown>;

      expect(loaded.moduleName).toBe("Standalone");
      expect(loadModule).toHaveBeenCalledWith("standalone.mod");
      expect(loadNasherWorkspace).not.toHaveBeenCalled();
      expect(detectNasherProject).not.toHaveBeenCalled();
    } finally {
      await cleanup();
    }
  });

  it("keeps an explicit standalone path outside the detected Nasher workspace", async () => {
    await fs.writeFile(path.join(workspaceRoot, "nasher.cfg"), "");
    const outsideModule = path.join(os.tmpdir(), `outside-${Date.now()}-${Math.random().toString(36).slice(2)}.mod`);
    const { registerCoreReadTools } = await import("./core-read.js");
    const { loadModule } = await import("../module-loader.js");
    const { loadNasherWorkspace } = await import("../nasher-workspace.js");
    const { client, cleanup } = await createTestClient(registerCoreReadTools);

    try {
      const result = await client.callTool({
        name: "load_module",
        arguments: { modPath: outsideModule },
      });
      const loaded = parseResult(result) as Record<string, unknown>;

      expect(loaded.moduleName).toBe("Standalone");
      expect(loadModule).toHaveBeenCalledWith(outsideModule);
      expect(loadNasherWorkspace).not.toHaveBeenCalled();
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

function createModuleIndex(modPath: string): ModuleIndex {
  return {
    modPath,
    tempDir: path.dirname(modPath),
    moduleName: "Standalone",
    resources: new Map([
      [
        "module.ifo",
        { resref: "module", extension: "ifo", filePath: path.join(path.dirname(modPath), "module.ifo"), sizeBytes: 10 },
      ],
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
  };
}

function parseResult(result: { content: Array<{ type: string; text?: string }> }): unknown {
  const textBlock = result.content.find((content) => content.type === "text");
  return textBlock?.text ? JSON.parse(textBlock.text) : null;
}
