/**
 * Integration tests for new feature tools.
 *
 * Tests: undo, area/module scripts, factions, item properties,
 * container inventory, creature equipment, bulk ops, encounter helper.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import path from "path";
import os from "os";
import fs from "fs/promises";

import type { GffDocument, GffObj } from "../types/gff.js";
import type { ModuleIndex, TwoDATable } from "../types/module.js";

// ─── Mocks ────────────────────────────────────────────────────────────────

vi.mock("../nim-tools.js", () => ({
  gffToJson: vi.fn(async () => ({})),
  jsonToGff: vi.fn(async (doc: unknown, filePath: string) => {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(doc));
  }),
  erfPack: vi.fn(async () => {}),
  resmanExtract: vi.fn(async () => {}),
  resmanExtractToJson: vi.fn(async () => ({})),
  readTextFile: vi.fn(async () => ""),
}));

let mockIndex: ModuleIndex;

vi.mock("../module-loader.js", () => ({
  requireIndex: () => mockIndex,
  buildResmanOptions: async () => ({
    root: undefined,
    userDir: undefined,
    erfs: undefined,
    dirs: [mockIndex.tempDir],
  }),
  buildDialogSummary: () => ({
    resref: "", entryCount: 0, replyCount: 0, startingNodes: [],
    scriptsUsed: [], conditionsUsed: [], usedByCreatures: [],
  }),
}));

vi.mock("./tileset-tools.js", () => ({
  invalidateTagToAreaCache: vi.fn(),
}));

// ─── Helpers ──────────────────────────────────────────────────────────────

let tempDir: string;

function createMockIndex(overrides?: Partial<ModuleIndex>): ModuleIndex {
  return {
    modPath: "/fake/mod.mod",
    tempDir,
    moduleName: "TestModule",
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
    ...overrides,
  };
}

function makeGitDoc(): GffDocument {
  return {
    __data_type: "GIT ",
    "Creature List": { type: "list", value: [] },
    "Placeable List": { type: "list", value: [] },
    "Door List": { type: "list", value: [] },
    "Encounter List": { type: "list", value: [] },
    "TriggerList": { type: "list", value: [] },
    WaypointList: { type: "list", value: [] },
    SoundList: { type: "list", value: [] },
    StoreList: { type: "list", value: [] },
  } as unknown as GffDocument;
}

function makeAreDoc(): GffDocument {
  return {
    __data_type: "ARE ",
    Name: { type: "cexolocstring", value: { "0": "Test Area" } },
    Width: { type: "int", value: 4 },
    Height: { type: "int", value: 4 },
    Tileset: { type: "resref", value: "ttf01" },
    OnEnter: { type: "resref", value: "" },
    OnExit: { type: "resref", value: "" },
    OnHeartbeat: { type: "resref", value: "" },
    OnUserDefined: { type: "resref", value: "" },
    Flags: { type: "dword", value: 0 },
  } as unknown as GffDocument;
}

function makeFacDoc(): GffDocument {
  return {
    __data_type: "FAC ",
    FactionList: {
      type: "list",
      value: [
        { __struct_id: 0, FactionName: { type: "cexostring", value: "PC" }, FactionParentID: { type: "dword", value: 4294967295 }, FactionGlobal: { type: "byte", value: 1 } },
        { __struct_id: 1, FactionName: { type: "cexostring", value: "Hostile" }, FactionParentID: { type: "dword", value: 4294967295 }, FactionGlobal: { type: "byte", value: 1 } },
        { __struct_id: 2, FactionName: { type: "cexostring", value: "Commoner" }, FactionParentID: { type: "dword", value: 4294967295 }, FactionGlobal: { type: "byte", value: 1 } },
      ],
    },
    RepList: {
      type: "list",
      value: [
        { __struct_id: 0, FactionID1: { type: "dword", value: 0 }, FactionID2: { type: "dword", value: 1 }, FactionRep: { type: "int", value: 0 } },
        { __struct_id: 1, FactionID1: { type: "dword", value: 0 }, FactionID2: { type: "dword", value: 2 }, FactionRep: { type: "int", value: 100 } },
      ],
    },
  } as unknown as GffDocument;
}

function makeItemDoc(resref: string, tag: string): GffDocument {
  return {
    __data_type: "UTI ",
    BaseItem: { type: "int", value: 4 },
    Tag: { type: "cexostring", value: tag },
    LocalizedName: { type: "cexolocstring", value: { "0": tag } },
    TemplateResRef: { type: "resref", value: resref },
    Cost: { type: "dword", value: 50 },
    PropertiesList: { type: "list", value: [] },
  } as unknown as GffDocument;
}

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
    cleanup: async () => { await client.close(); await server.close(); },
  };
}

function parseResult(result: { content: Array<{ type: string; text?: string }> }): unknown {
  const textBlock = result.content.find(c => c.type === "text");
  return textBlock?.text ? JSON.parse(textBlock.text) : null;
}

function resultText(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.find(c => c.type === "text")?.text ?? "";
}

// ─── Setup/Teardown ───────────────────────────────────────────────────────

beforeEach(async () => {
  tempDir = path.join(os.tmpdir(), `nwn-mcp-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await fs.mkdir(tempDir, { recursive: true });
  mockIndex = createMockIndex();

  // Clear undo stack between tests
  const { clearUndoStack } = await import("../util/undo.js");
  clearUndoStack();
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

// ─── Tests: Undo ─────────────────────────────────────────────────────────

describe("undo tools", () => {
  it("undo_last_change restores GIT state after placement", async () => {
    const { registerUndoTools } = await import("./undo-tools.js");
    const { registerPlacementTools } = await import("./placement-tools.js");
    const { client, cleanup } = await createTestClient((server) => {
      registerPlacementTools(server);
      registerUndoTools(server);
    });

    // Set up area with GIT
    const gitDoc = makeGitDoc();
    mockIndex.parsedGff.set("testarea.git", gitDoc);
    mockIndex.resources.set("testarea.git", { resref: "testarea", extension: "git", filePath: path.join(tempDir, "testarea.git"), sizeBytes: 100 });
    mockIndex.areas.set("testarea", { resref: "testarea", name: "Test", width: 4, height: 4, tileset: "ttf01", isInterior: false, creatureCount: 0, placeableCount: 0, doorCount: 0, encounterCount: 0, triggerCount: 0, waypointCount: 0 });

    // Add a waypoint (simpler than creature - no walkmesh needed)
    try {
      await client.callTool({
        name: "place_waypoint",
        arguments: { area: "testarea", tag: "wp_test", name: "Test WP", x: "5", y: "5" },
      });

      const git = gitDoc as GffObj;
      const wpList = (git.WaypointList as { value: unknown[] }).value;
      expect(wpList).toHaveLength(1);

      // Undo
      const undoResult = await client.callTool({ name: "undo_last_change", arguments: {} });
      const parsed = parseResult(undoResult) as Record<string, unknown>;
      expect(parsed.success).toBe(true);

      // After undo, the GIT in parsedGff should have empty waypoint list
      const restoredGit = mockIndex.parsedGff.get("testarea.git") as GffObj;
      const restoredList = (restoredGit.WaypointList as { value: unknown[] }).value;
      expect(restoredList).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });

  it("undo_last_change returns message when stack is empty", async () => {
    const { registerUndoTools } = await import("./undo-tools.js");
    const { client, cleanup } = await createTestClient(registerUndoTools);

    try {
      const result = await client.callTool({ name: "undo_last_change", arguments: {} });
      expect(resultText(result)).toContain("empty");
    } finally {
      await cleanup();
    }
  });

  it("undo_history returns stack entries", async () => {
    const { registerUndoTools } = await import("./undo-tools.js");
    const { client, cleanup } = await createTestClient(registerUndoTools);

    // Manually push an undo entry
    const { snapshotGitForUndo } = await import("../util/undo.js");
    snapshotGitForUndo(makeGitDoc(), "testarea", "test_tool", "Test operation");

    try {
      const result = await client.callTool({ name: "undo_history", arguments: {} });
      const parsed = parseResult(result) as { count: number; entries: unknown[] };
      expect(parsed.count).toBe(1);
      expect(parsed.entries).toHaveLength(1);
    } finally {
      await cleanup();
    }
  });
});

// ─── Tests: Area & Module Scripts ────────────────────────────────────────

describe("area & module scripts", () => {
  it("set_area_scripts sets event scripts on ARE", async () => {
    const { registerAreaTools } = await import("./area-tools.js");
    const { client, cleanup } = await createTestClient(registerAreaTools);

    const areDoc = makeAreDoc();
    mockIndex.parsedGff.set("testarea.are", areDoc);
    mockIndex.resources.set("testarea.are", { resref: "testarea", extension: "are", filePath: path.join(tempDir, "testarea.are"), sizeBytes: 100 });

    try {
      const result = await client.callTool({
        name: "set_area_scripts",
        arguments: { area: "testarea", onEnter: "a_area_enter", onExit: "a_area_exit" },
      });

      const parsed = parseResult(result) as Record<string, unknown>;
      expect(parsed.success).toBe(true);

      const are = areDoc as GffObj;
      expect((are.OnEnter as { value: string }).value).toBe("a_area_enter");
      expect((are.OnExit as { value: string }).value).toBe("a_area_exit");
    } finally {
      await cleanup();
    }
  });

  it("set_area_scripts clears script with empty string", async () => {
    const { registerAreaTools } = await import("./area-tools.js");
    const { client, cleanup } = await createTestClient(registerAreaTools);

    const areDoc = makeAreDoc();
    (areDoc as GffObj).OnEnter = { type: "resref", value: "old_script" };
    mockIndex.parsedGff.set("testarea.are", areDoc);
    mockIndex.resources.set("testarea.are", { resref: "testarea", extension: "are", filePath: path.join(tempDir, "testarea.are"), sizeBytes: 100 });

    try {
      await client.callTool({
        name: "set_area_scripts",
        arguments: { area: "testarea", onEnter: "" },
      });

      expect(((areDoc as GffObj).OnEnter as { value: string }).value).toBe("");
    } finally {
      await cleanup();
    }
  });

  it("set_module_scripts sets IFO scripts", async () => {
    const { registerAreaTools } = await import("./area-tools.js");
    const { client, cleanup } = await createTestClient(registerAreaTools);

    const ifoDoc = {
      __data_type: "IFO ",
      Mod_OnClientEntr: { type: "resref", value: "" },
      Mod_OnHeartbeat: { type: "resref", value: "" },
    } as unknown as GffDocument;

    mockIndex.parsedGff.set("module.ifo", ifoDoc);
    mockIndex.resources.set("module.ifo", { resref: "module", extension: "ifo", filePath: path.join(tempDir, "module.ifo"), sizeBytes: 100 });

    try {
      const result = await client.callTool({
        name: "set_module_scripts",
        arguments: { Mod_OnClientEntr: "a_mod_enter", Mod_OnHeartbeat: "a_mod_hb" },
      });

      const parsed = parseResult(result) as Record<string, unknown>;
      expect(parsed.success).toBe(true);

      const ifo = ifoDoc as GffObj;
      expect((ifo.Mod_OnClientEntr as { value: string }).value).toBe("a_mod_enter");
      expect((ifo.Mod_OnHeartbeat as { value: string }).value).toBe("a_mod_hb");
    } finally {
      await cleanup();
    }
  });
});

// ─── Tests: Factions ─────────────────────────────────────────────────────

describe("faction tools", () => {
  it("create_faction adds faction and rep entries", async () => {
    const { registerFactionTools } = await import("./faction-tools.js");
    const { client, cleanup } = await createTestClient(registerFactionTools);

    const facDoc = makeFacDoc();
    mockIndex.parsedGff.set("repute.fac", facDoc);
    mockIndex.resources.set("repute.fac", { resref: "repute", extension: "fac", filePath: path.join(tempDir, "repute.fac"), sizeBytes: 100 });

    try {
      const result = await client.callTool({
        name: "create_faction",
        arguments: { name: "Thieves Guild", defaultReputation: "25" },
      });

      const parsed = parseResult(result) as Record<string, unknown>;
      expect(parsed.success).toBe(true);
      expect(parsed.factionId).toBe(3);

      const fac = facDoc as GffObj;
      const factionList = (fac.FactionList as { value: GffObj[] }).value;
      expect(factionList).toHaveLength(4);
      expect((factionList[3].FactionName as { value: string }).value).toBe("Thieves Guild");

      // Should have added 3 rep entries (one for each existing faction)
      const repList = (fac.RepList as { value: GffObj[] }).value;
      expect(repList.length).toBe(5); // 2 original + 3 new
    } finally {
      await cleanup();
    }
  });

  it("set_faction_reputation updates existing entry", async () => {
    const { registerFactionTools } = await import("./faction-tools.js");
    const { client, cleanup } = await createTestClient(registerFactionTools);

    const facDoc = makeFacDoc();
    mockIndex.parsedGff.set("repute.fac", facDoc);
    mockIndex.resources.set("repute.fac", { resref: "repute", extension: "fac", filePath: path.join(tempDir, "repute.fac"), sizeBytes: 100 });

    try {
      const result = await client.callTool({
        name: "set_faction_reputation",
        arguments: { faction1: "0", faction2: "1", reputation: "50" },
      });

      const parsed = parseResult(result) as Record<string, unknown>;
      expect(parsed.success).toBe(true);
      expect((parsed as { action: string }).action).toBe("updated");

      // Verify the rep value changed
      const fac = facDoc as GffObj;
      const repList = (fac.RepList as { value: GffObj[] }).value;
      expect((repList[0].FactionRep as { value: number }).value).toBe(50);
    } finally {
      await cleanup();
    }
  });

  it("set_faction_reputation rejects invalid faction ID", async () => {
    const { registerFactionTools } = await import("./faction-tools.js");
    const { client, cleanup } = await createTestClient(registerFactionTools);

    const facDoc = makeFacDoc();
    mockIndex.parsedGff.set("repute.fac", facDoc);
    mockIndex.resources.set("repute.fac", { resref: "repute", extension: "fac", filePath: path.join(tempDir, "repute.fac"), sizeBytes: 100 });

    try {
      const result = await client.callTool({
        name: "set_faction_reputation",
        arguments: { faction1: "0", faction2: "99", reputation: "50" },
      });

      expect(resultText(result)).toContain("Invalid faction2");
    } finally {
      await cleanup();
    }
  });
});

// ─── Tests: Item Properties ──────────────────────────────────────────────

describe("item property tools", () => {
  it("add_item_property adds by integer ID", async () => {
    const { registerItemTools } = await import("./item-tools.js");
    const { client, cleanup } = await createTestClient(registerItemTools);

    const itemDoc = makeItemDoc("test_sword", "TEST_SWORD");
    mockIndex.parsedGff.set("test_sword.uti", itemDoc);
    mockIndex.resources.set("test_sword.uti", { resref: "test_sword", extension: "uti", filePath: path.join(tempDir, "test_sword.uti"), sizeBytes: 100 });

    try {
      const result = await client.callTool({
        name: "add_item_property",
        arguments: { resref: "test_sword", propertyName: "56", costTable: "2", costValue: "1" },
      });

      const parsed = parseResult(result) as Record<string, unknown>;
      expect(parsed.success).toBe(true);
      expect(parsed.totalProperties).toBe(1);

      const obj = itemDoc as GffObj;
      const propList = (obj.PropertiesList as { value: GffObj[] }).value;
      expect(propList).toHaveLength(1);
      expect((propList[0].PropertyName as { value: number }).value).toBe(56);
      expect((propList[0].ChanceAppear as { value: number }).value).toBe(100);
    } finally {
      await cleanup();
    }
  });

  it("remove_item_property removes by index", async () => {
    const { registerItemTools } = await import("./item-tools.js");
    const { client, cleanup } = await createTestClient(registerItemTools);

    const itemDoc = makeItemDoc("test_sword", "TEST_SWORD");
    (itemDoc as GffObj).PropertiesList = {
      type: "list",
      value: [
        { __struct_id: 0, PropertyName: { type: "word", value: 56 }, Subtype: { type: "word", value: 0 }, CostTable: { type: "byte", value: 2 }, CostValue: { type: "word", value: 1 }, Param1: { type: "byte", value: 255 }, Param1Value: { type: "byte", value: 0 }, ChanceAppear: { type: "byte", value: 100 } },
        { __struct_id: 0, PropertyName: { type: "word", value: 0 }, Subtype: { type: "word", value: 1 }, CostTable: { type: "byte", value: 1 }, CostValue: { type: "word", value: 2 }, Param1: { type: "byte", value: 255 }, Param1Value: { type: "byte", value: 0 }, ChanceAppear: { type: "byte", value: 100 } },
      ],
    };
    mockIndex.parsedGff.set("test_sword.uti", itemDoc);
    mockIndex.resources.set("test_sword.uti", { resref: "test_sword", extension: "uti", filePath: path.join(tempDir, "test_sword.uti"), sizeBytes: 100 });

    try {
      const result = await client.callTool({
        name: "remove_item_property",
        arguments: { resref: "test_sword", index: "0" },
      });

      const parsed = parseResult(result) as Record<string, unknown>;
      expect(parsed.success).toBe(true);
      expect(parsed.remainingProperties).toBe(1);
    } finally {
      await cleanup();
    }
  });

  it("clear_item_properties removes all", async () => {
    const { registerItemTools } = await import("./item-tools.js");
    const { client, cleanup } = await createTestClient(registerItemTools);

    const itemDoc = makeItemDoc("test_sword", "TEST_SWORD");
    (itemDoc as GffObj).PropertiesList = {
      type: "list",
      value: [
        { __struct_id: 0, PropertyName: { type: "word", value: 56 } },
        { __struct_id: 0, PropertyName: { type: "word", value: 0 } },
      ],
    };
    mockIndex.parsedGff.set("test_sword.uti", itemDoc);
    mockIndex.resources.set("test_sword.uti", { resref: "test_sword", extension: "uti", filePath: path.join(tempDir, "test_sword.uti"), sizeBytes: 100 });

    try {
      const result = await client.callTool({
        name: "clear_item_properties",
        arguments: { resref: "test_sword" },
      });

      const parsed = parseResult(result) as Record<string, unknown>;
      expect(parsed.success).toBe(true);
      expect(parsed.propertiesRemoved).toBe(2);
    } finally {
      await cleanup();
    }
  });
});

// ─── Tests: Container Inventory ──────────────────────────────────────────

describe("container inventory tools", () => {
  it("add_items_to_container adds items with auto grid position", async () => {
    const { registerPlacementTools } = await import("./placement-tools.js");
    const { client, cleanup } = await createTestClient(registerPlacementTools);

    // Set up area
    const gitDoc = makeGitDoc();
    const git = gitDoc as GffObj;
    (git["Placeable List"] as { value: GffObj[] }).value.push({
      __struct_id: 9,
      Tag: { type: "cexostring", value: "chest1" },
      LocName: { type: "cexolocstring", value: { "0": "Chest" } },
      HasInventory: { type: "byte", value: 0 },
      X: { type: "float", value: 5 },
      Y: { type: "float", value: 5 },
      Z: { type: "float", value: 0 },
    });

    mockIndex.parsedGff.set("testarea.git", gitDoc);
    mockIndex.resources.set("testarea.git", { resref: "testarea", extension: "git", filePath: path.join(tempDir, "testarea.git"), sizeBytes: 100 });
    mockIndex.areas.set("testarea", { resref: "testarea", name: "Test", width: 4, height: 4, tileset: "ttf01", isInterior: false, creatureCount: 0, placeableCount: 1, doorCount: 0, encounterCount: 0, triggerCount: 0, waypointCount: 0 });

    // Pre-populate item blueprint
    const potionDoc = makeItemDoc("nw_it_mpotion001", "NW_IT_MPOTION001");
    mockIndex.parsedGff.set("nw_it_mpotion001.uti", potionDoc);

    try {
      const result = await client.callTool({
        name: "add_items_to_container",
        arguments: {
          area: "testarea",
          containerTag: "chest1",
          items: '[{"resref": "nw_it_mpotion001"}, {"resref": "nw_it_mpotion001", "quantity": 3}]',
        },
      });

      const parsed = parseResult(result) as Record<string, unknown>;
      expect(parsed.success).toBe(true);
      expect(parsed.totalInventory).toBe(2);

      // Verify HasInventory was set
      const container = (git["Placeable List"] as { value: GffObj[] }).value[0];
      expect((container.HasInventory as { value: number }).value).toBe(1);

      // Verify items added
      const itemList = (container.ItemList as { value: GffObj[] }).value;
      expect(itemList).toHaveLength(2);
    } finally {
      await cleanup();
    }
  });

  it("remove_items_from_container removes by resref", async () => {
    const { registerPlacementTools } = await import("./placement-tools.js");
    const { client, cleanup } = await createTestClient(registerPlacementTools);

    const gitDoc = makeGitDoc();
    const git = gitDoc as GffObj;
    (git["Placeable List"] as { value: GffObj[] }).value.push({
      __struct_id: 9,
      Tag: { type: "cexostring", value: "chest1" },
      HasInventory: { type: "byte", value: 1 },
      ItemList: {
        type: "list",
        value: [
          { __struct_id: 0, InventoryRes: { type: "cexostring", value: "nw_it_mpotion001" } },
          { __struct_id: 0, InventoryRes: { type: "cexostring", value: "nw_it_mpotion002" } },
          { __struct_id: 0, InventoryRes: { type: "cexostring", value: "nw_it_mpotion001" } },
        ],
      },
      X: { type: "float", value: 5 },
      Y: { type: "float", value: 5 },
      Z: { type: "float", value: 0 },
    });

    mockIndex.parsedGff.set("testarea.git", gitDoc);
    mockIndex.resources.set("testarea.git", { resref: "testarea", extension: "git", filePath: path.join(tempDir, "testarea.git"), sizeBytes: 100 });
    mockIndex.areas.set("testarea", { resref: "testarea", name: "Test", width: 4, height: 4, tileset: "ttf01", isInterior: false, creatureCount: 0, placeableCount: 1, doorCount: 0, encounterCount: 0, triggerCount: 0, waypointCount: 0 });

    try {
      const result = await client.callTool({
        name: "remove_items_from_container",
        arguments: { area: "testarea", containerTag: "chest1", itemResref: "nw_it_mpotion001" },
      });

      const parsed = parseResult(result) as Record<string, unknown>;
      expect(parsed.success).toBe(true);
      expect(parsed.removedCount).toBe(2);
      expect(parsed.remainingItems).toBe(1);
    } finally {
      await cleanup();
    }
  });
});

// ─── Tests: Creature Equipment ───────────────────────────────────────────

describe("creature equipment tools", () => {
  it("set_creature_equipment adds equipment to a placed creature", async () => {
    const { registerCreatureTools } = await import("./creature-tools.js");
    const { client, cleanup } = await createTestClient(registerCreatureTools);

    const gitDoc = makeGitDoc();
    const git = gitDoc as GffObj;
    (git["Creature List"] as { value: GffObj[] }).value.push({
      __struct_id: 4,
      Tag: { type: "cexostring", value: "guard1" },
      FirstName: { type: "cexolocstring", value: { "0": "Guard" } },
      Equip_ItemList: { type: "list", value: [] },
      XPosition: { type: "float", value: 5 },
      YPosition: { type: "float", value: 5 },
      ZPosition: { type: "float", value: 0 },
    });

    mockIndex.parsedGff.set("testarea.git", gitDoc);
    mockIndex.resources.set("testarea.git", { resref: "testarea", extension: "git", filePath: path.join(tempDir, "testarea.git"), sizeBytes: 100 });
    mockIndex.areas.set("testarea", { resref: "testarea", name: "Test", width: 4, height: 4, tileset: "ttf01", isInterior: false, creatureCount: 1, placeableCount: 0, doorCount: 0, encounterCount: 0, triggerCount: 0, waypointCount: 0 });

    // Pre-populate item blueprint
    const swordDoc = makeItemDoc("nw_wswls001", "NW_WSWLS001");
    mockIndex.parsedGff.set("nw_wswls001.uti", swordDoc);

    try {
      const result = await client.callTool({
        name: "set_creature_equipment",
        arguments: {
          area: "testarea",
          tag: "guard1",
          equipment: '{"righthand": "nw_wswls001"}',
        },
      });

      const parsed = parseResult(result) as Record<string, unknown>;
      expect(parsed.success).toBe(true);

      const creature = (git["Creature List"] as { value: GffObj[] }).value[0];
      const equipList = (creature.Equip_ItemList as { value: GffObj[] }).value;
      expect(equipList).toHaveLength(1);
      expect(equipList[0].__struct_id).toBe(16); // righthand slot
    } finally {
      await cleanup();
    }
  });

  it("clear_creature_equipment clears all equipment", async () => {
    const { registerCreatureTools } = await import("./creature-tools.js");
    const { client, cleanup } = await createTestClient(registerCreatureTools);

    const gitDoc = makeGitDoc();
    const git = gitDoc as GffObj;
    (git["Creature List"] as { value: GffObj[] }).value.push({
      __struct_id: 4,
      Tag: { type: "cexostring", value: "guard1" },
      Equip_ItemList: {
        type: "list",
        value: [
          { __struct_id: 16, BaseItem: { type: "int", value: 4 } },
          { __struct_id: 2, BaseItem: { type: "int", value: 16 } },
        ],
      },
      XPosition: { type: "float", value: 5 },
      YPosition: { type: "float", value: 5 },
      ZPosition: { type: "float", value: 0 },
    });

    mockIndex.parsedGff.set("testarea.git", gitDoc);
    mockIndex.resources.set("testarea.git", { resref: "testarea", extension: "git", filePath: path.join(tempDir, "testarea.git"), sizeBytes: 100 });
    mockIndex.areas.set("testarea", { resref: "testarea", name: "Test", width: 4, height: 4, tileset: "ttf01", isInterior: false, creatureCount: 1, placeableCount: 0, doorCount: 0, encounterCount: 0, triggerCount: 0, waypointCount: 0 });

    try {
      const result = await client.callTool({
        name: "clear_creature_equipment",
        arguments: { area: "testarea", tag: "guard1" },
      });

      const parsed = parseResult(result) as Record<string, unknown>;
      expect(parsed.success).toBe(true);
      expect(parsed.removedCount).toBe(2);
    } finally {
      await cleanup();
    }
  });
});

// ─── Tests: Bulk Operations ─────────────────────────────────────────────

describe("bulk operations", () => {
  it("bulk_remove_objects dry run finds matches", async () => {
    const { registerBulkTools } = await import("./bulk-tools.js");
    const { client, cleanup } = await createTestClient(registerBulkTools);

    const gitDoc = makeGitDoc();
    const git = gitDoc as GffObj;
    (git["Creature List"] as { value: GffObj[] }).value.push(
      { __struct_id: 4, Tag: { type: "cexostring", value: "goblin_1" }, FirstName: { type: "cexolocstring", value: { "0": "Goblin" } } },
      { __struct_id: 4, Tag: { type: "cexostring", value: "goblin_2" }, FirstName: { type: "cexolocstring", value: { "0": "Goblin" } } },
      { __struct_id: 4, Tag: { type: "cexostring", value: "orc_1" }, FirstName: { type: "cexolocstring", value: { "0": "Orc" } } },
    );

    mockIndex.parsedGff.set("testarea.git", gitDoc);
    mockIndex.areas.set("testarea", { resref: "testarea", name: "Test", width: 4, height: 4, tileset: "ttf01", isInterior: false, creatureCount: 3, placeableCount: 0, doorCount: 0, encounterCount: 0, triggerCount: 0, waypointCount: 0 });

    try {
      const result = await client.callTool({
        name: "bulk_remove_objects",
        arguments: { tagPattern: "goblin_*", listName: "Creature List", area: "testarea", dryRun: true },
      });

      const parsed = parseResult(result) as Record<string, unknown>;
      expect(parsed.dryRun).toBe(true);
      expect(parsed.matchCount).toBe(2);
    } finally {
      await cleanup();
    }
  });

  it("bulk_move_objects moves by offset", async () => {
    const { registerBulkTools } = await import("./bulk-tools.js");
    const { client, cleanup } = await createTestClient(registerBulkTools);

    const gitDoc = makeGitDoc();
    const git = gitDoc as GffObj;
    (git["Creature List"] as { value: GffObj[] }).value.push(
      { __struct_id: 4, Tag: { type: "cexostring", value: "guard" }, XPosition: { type: "float", value: 10 }, YPosition: { type: "float", value: 20 }, ZPosition: { type: "float", value: 0 } },
      { __struct_id: 4, Tag: { type: "cexostring", value: "guard" }, XPosition: { type: "float", value: 15 }, YPosition: { type: "float", value: 25 }, ZPosition: { type: "float", value: 0 } },
    );

    mockIndex.parsedGff.set("testarea.git", gitDoc);
    mockIndex.resources.set("testarea.git", { resref: "testarea", extension: "git", filePath: path.join(tempDir, "testarea.git"), sizeBytes: 100 });
    mockIndex.areas.set("testarea", { resref: "testarea", name: "Test", width: 4, height: 4, tileset: "ttf01", isInterior: false, creatureCount: 2, placeableCount: 0, doorCount: 0, encounterCount: 0, triggerCount: 0, waypointCount: 0 });

    try {
      const result = await client.callTool({
        name: "bulk_move_objects",
        arguments: { area: "testarea", tag: "guard", listName: "Creature List", offsetX: "5", offsetY: "-3" },
      });

      const parsed = parseResult(result) as Record<string, unknown>;
      expect(parsed.success).toBe(true);
      expect(parsed.movedCount).toBe(2);

      const creatures = (git["Creature List"] as { value: GffObj[] }).value;
      expect((creatures[0].XPosition as { value: number }).value).toBe(15);
      expect((creatures[0].YPosition as { value: number }).value).toBe(17);
      expect((creatures[1].XPosition as { value: number }).value).toBe(20);
    } finally {
      await cleanup();
    }
  });
});

// ─── Tests: Encounter Helper ────────────────────────────────────────────

describe("suggest_encounter", () => {
  it("returns suggestions from module creatures", async () => {
    const { registerAnalysisTools } = await import("./analysis-tools.js");
    const { client, cleanup } = await createTestClient(registerAnalysisTools);

    // Add creature blueprints
    mockIndex.parsedGff.set("goblin.utc", {
      __data_type: "UTC ",
      Tag: { type: "cexostring", value: "goblin" },
      FirstName: { type: "cexolocstring", value: { "0": "Goblin" } },
      ChallengeRating: { type: "float", value: 1 },
    } as unknown as GffDocument);

    mockIndex.parsedGff.set("orc.utc", {
      __data_type: "UTC ",
      Tag: { type: "cexostring", value: "orc" },
      FirstName: { type: "cexolocstring", value: { "0": "Orc" } },
      ChallengeRating: { type: "float", value: 3 },
    } as unknown as GffDocument);

    try {
      const result = await client.callTool({
        name: "suggest_encounter",
        arguments: { partyLevel: "3", partySize: "1", difficulty: "medium" },
      });

      const parsed = parseResult(result) as Record<string, unknown>;
      expect(parsed.xpBudget).toBe(300);
      expect(parsed.availableCreatures).toBe(2);
      expect((parsed.suggestions as unknown[]).length).toBeGreaterThan(0);
    } finally {
      await cleanup();
    }
  });

  it("filters by theme", async () => {
    const { registerAnalysisTools } = await import("./analysis-tools.js");
    const { client, cleanup } = await createTestClient(registerAnalysisTools);

    mockIndex.parsedGff.set("goblin.utc", {
      __data_type: "UTC ",
      Tag: { type: "cexostring", value: "goblin" },
      FirstName: { type: "cexolocstring", value: { "0": "Goblin" } },
      ChallengeRating: { type: "float", value: 1 },
    } as unknown as GffDocument);

    try {
      const result = await client.callTool({
        name: "suggest_encounter",
        arguments: { partyLevel: "3", theme: "dragon" },
      });

      const text = resultText(result);
      expect(text).toContain("dragon");
      expect(text).toContain("suggestions");
    } finally {
      await cleanup();
    }
  });
});

// ─── edit_dialog_node ───────────────────────────────────────────────────

describe("edit_dialog_node", () => {
  function makeDlgDoc(): GffDocument {
    return {
      __data_type: "DLG ",
      DelayEntry: { type: "dword", value: 0 },
      DelayReply: { type: "dword", value: 0 },
      NumWords: { type: "dword", value: 0 },
      EndConverAbort: { type: "resref", value: "" },
      EndConversation: { type: "resref", value: "" },
      PreventZoomIn: { type: "byte", value: 0 },
      StartingList: { type: "list", value: [
        { __struct_id: 0, Index: { type: "dword", value: 0 }, Active: { type: "resref", value: "" }, IsChild: { type: "byte", value: 0 } },
      ] },
      EntryList: { type: "list", value: [
        {
          __struct_id: 0,
          Animation: { type: "dword", value: 0 },
          AnimLoop: { type: "byte", value: 1 },
          Comment: { type: "cexostring", value: "old comment" },
          Delay: { type: "dword", value: 4294967295 },
          Quest: { type: "cexostring", value: "" },
          RepliesList: { type: "list", value: [
            { __struct_id: 0, Index: { type: "dword", value: 0 }, Active: { type: "resref", value: "" }, IsChild: { type: "byte", value: 0 } },
          ] },
          Script: { type: "resref", value: "old_script" },
          Sound: { type: "resref", value: "" },
          Speaker: { type: "cexostring", value: "" },
          Text: { type: "cexolocstring", value: { "0": "Hello traveler" } },
        },
      ] },
      ReplyList: { type: "list", value: [
        {
          __struct_id: 0,
          Animation: { type: "dword", value: 0 },
          AnimLoop: { type: "byte", value: 1 },
          Comment: { type: "cexostring", value: "" },
          Delay: { type: "dword", value: 4294967295 },
          EntriesList: { type: "list", value: [] },
          Quest: { type: "cexostring", value: "" },
          Script: { type: "resref", value: "" },
          Sound: { type: "resref", value: "" },
          Text: { type: "cexolocstring", value: { "0": "Goodbye" } },
        },
      ] },
    } as unknown as GffDocument;
  }

  it("edits entry text", async () => {
    const dlg = makeDlgDoc();
    const dlgPath = path.join(tempDir, "testdlg.dlg");
    await fs.writeFile(dlgPath, "{}");
    mockIndex = createMockIndex({
      resources: new Map([["testdlg.dlg", { resref: "testdlg", extension: "dlg", filePath: dlgPath, sizeBytes: 100 }]]),
      parsedGff: new Map([["testdlg.dlg", dlg]]),
    });

    const { registerDialogWriteTools } = await import("./dialog-write-tools.js");
    const { client, cleanup } = await createTestClient(registerDialogWriteTools);
    try {
      const result = await client.callTool({
        name: "edit_dialog_node",
        arguments: { dialog: "testdlg", nodeType: "entry", nodeIndex: "0", text: "Welcome, adventurer!" },
      });
      const parsed = parseResult(result) as Record<string, unknown>;
      expect(parsed.success).toBe(true);
      expect(parsed.oldText).toBe("Hello traveler");
      expect((parsed.changes as Record<string, unknown>).text).toBe("Welcome, adventurer!");

      // Verify in-memory GFF was updated
      const entry = ((dlg as GffObj).EntryList as { value: GffObj[] }).value[0];
      expect((entry.Text as { value: Record<string, string> }).value["0"]).toBe("Welcome, adventurer!");
    } finally {
      await cleanup();
    }
  });

  it("edits reply script", async () => {
    const dlg = makeDlgDoc();
    const dlgPath = path.join(tempDir, "testdlg.dlg");
    await fs.writeFile(dlgPath, "{}");
    mockIndex = createMockIndex({
      resources: new Map([["testdlg.dlg", { resref: "testdlg", extension: "dlg", filePath: dlgPath, sizeBytes: 100 }]]),
      parsedGff: new Map([["testdlg.dlg", dlg]]),
    });

    const { registerDialogWriteTools } = await import("./dialog-write-tools.js");
    const { client, cleanup } = await createTestClient(registerDialogWriteTools);
    try {
      const result = await client.callTool({
        name: "edit_dialog_node",
        arguments: { dialog: "testdlg", nodeType: "reply", nodeIndex: "0", script: "new_script" },
      });
      const parsed = parseResult(result) as Record<string, unknown>;
      expect(parsed.success).toBe(true);

      const reply = ((dlg as GffObj).ReplyList as { value: GffObj[] }).value[0];
      expect((reply.Script as { value: string }).value).toBe("new_script");
    } finally {
      await cleanup();
    }
  });

  it("rejects when no fields provided", async () => {
    const dlg = makeDlgDoc();
    const dlgPath = path.join(tempDir, "testdlg.dlg");
    await fs.writeFile(dlgPath, "{}");
    mockIndex = createMockIndex({
      resources: new Map([["testdlg.dlg", { resref: "testdlg", extension: "dlg", filePath: dlgPath, sizeBytes: 100 }]]),
      parsedGff: new Map([["testdlg.dlg", dlg]]),
    });

    const { registerDialogWriteTools } = await import("./dialog-write-tools.js");
    const { client, cleanup } = await createTestClient(registerDialogWriteTools);
    try {
      const result = await client.callTool({
        name: "edit_dialog_node",
        arguments: { dialog: "testdlg", nodeType: "entry", nodeIndex: "0" },
      });
      const text = resultText(result);
      expect(text).toContain("Must provide at least one field");
    } finally {
      await cleanup();
    }
  });

  it("rejects out-of-bounds index", async () => {
    const dlg = makeDlgDoc();
    const dlgPath = path.join(tempDir, "testdlg.dlg");
    await fs.writeFile(dlgPath, "{}");
    mockIndex = createMockIndex({
      resources: new Map([["testdlg.dlg", { resref: "testdlg", extension: "dlg", filePath: dlgPath, sizeBytes: 100 }]]),
      parsedGff: new Map([["testdlg.dlg", dlg]]),
    });

    const { registerDialogWriteTools } = await import("./dialog-write-tools.js");
    const { client, cleanup } = await createTestClient(registerDialogWriteTools);
    try {
      const result = await client.callTool({
        name: "edit_dialog_node",
        arguments: { dialog: "testdlg", nodeType: "entry", nodeIndex: "5", text: "test" },
      });
      const text = resultText(result);
      expect(text).toContain("out of range");
    } finally {
      await cleanup();
    }
  });
});

// ─── move_object ────────────────────────────────────────────────────────

describe("move_object", () => {
  it("moves a creature by tag", async () => {
    const { clearUndoStack } = await import("../util/undo.js");
    clearUndoStack();

    const gitDoc = makeGitDoc();
    const gitPath = path.join(tempDir, "testarea.git");
    await fs.writeFile(gitPath, "{}");
    (gitDoc as GffObj)["Creature List"] = {
      type: "list", value: [{
        __struct_id: 4,
        Tag: { type: "cexostring", value: "wolf01" },
        FirstName: { type: "cexolocstring", value: { "0": "Wolf" } },
        XPosition: { type: "float", value: 5.0 },
        YPosition: { type: "float", value: 5.0 },
        ZPosition: { type: "float", value: 0.0 },
      }],
    };

    mockIndex = createMockIndex({
      resources: new Map([["testarea.git", { resref: "testarea", extension: "git", filePath: gitPath, sizeBytes: 100 }]]),
      parsedGff: new Map([["testarea.git", gitDoc]]),
      areas: new Map([["testarea", { resref: "testarea", name: "Test", width: 4, height: 4, tileset: "ttf01", isInterior: false, creatureCount: 1, placeableCount: 0, doorCount: 0, encounterCount: 0, triggerCount: 0, waypointCount: 0 }]]),
    });

    const { registerObjectMgmtTools } = await import("./object-mgmt-tools.js");
    const { client, cleanup } = await createTestClient(registerObjectMgmtTools);
    try {
      const result = await client.callTool({
        name: "move_object",
        arguments: { area: "testarea", listName: "Creature List", tag: "wolf01", x: "10.0", y: "15.0" },
      });
      const parsed = parseResult(result) as Record<string, unknown>;
      expect(parsed.success).toBe(true);
      expect((parsed.oldPosition as Record<string, number>).x).toBe(5.0);
      expect((parsed.newPosition as Record<string, number>).x).toBe(10.0);
      expect((parsed.newPosition as Record<string, number>).y).toBe(15.0);

      // Verify in-memory
      const creature = ((gitDoc as GffObj)["Creature List"] as { value: GffObj[] }).value[0];
      expect((creature.XPosition as { value: number }).value).toBe(10.0);
      expect((creature.YPosition as { value: number }).value).toBe(15.0);
    } finally {
      await cleanup();
    }
  });

  it("moves a placeable using X/Y fields", async () => {
    const { clearUndoStack } = await import("../util/undo.js");
    clearUndoStack();

    const gitDoc = makeGitDoc();
    const gitPath = path.join(tempDir, "testarea.git");
    await fs.writeFile(gitPath, "{}");
    (gitDoc as GffObj)["Placeable List"] = {
      type: "list", value: [{
        __struct_id: 9,
        Tag: { type: "cexostring", value: "chest01" },
        LocalizedName: { type: "cexolocstring", value: { "0": "Chest" } },
        X: { type: "float", value: 3.0 },
        Y: { type: "float", value: 3.0 },
        Z: { type: "float", value: 0.0 },
      }],
    };

    mockIndex = createMockIndex({
      resources: new Map([["testarea.git", { resref: "testarea", extension: "git", filePath: gitPath, sizeBytes: 100 }]]),
      parsedGff: new Map([["testarea.git", gitDoc]]),
      areas: new Map([["testarea", { resref: "testarea", name: "Test", width: 4, height: 4, tileset: "ttf01", isInterior: false, creatureCount: 0, placeableCount: 1, doorCount: 0, encounterCount: 0, triggerCount: 0, waypointCount: 0 }]]),
    });

    const { registerObjectMgmtTools } = await import("./object-mgmt-tools.js");
    const { client, cleanup } = await createTestClient(registerObjectMgmtTools);
    try {
      const result = await client.callTool({
        name: "move_object",
        arguments: { area: "testarea", listName: "Placeable List", tag: "chest01", x: "20.0", y: "25.0" },
      });
      const parsed = parseResult(result) as Record<string, unknown>;
      expect(parsed.success).toBe(true);

      const placeable = ((gitDoc as GffObj)["Placeable List"] as { value: GffObj[] }).value[0];
      expect((placeable.X as { value: number }).value).toBe(20.0);
      expect((placeable.Y as { value: number }).value).toBe(25.0);
    } finally {
      await cleanup();
    }
  });

  it("rejects when tag not found", async () => {
    const gitDoc = makeGitDoc();
    const gitPath = path.join(tempDir, "testarea.git");
    await fs.writeFile(gitPath, "{}");
    // Add a creature so the list isn't empty
    (gitDoc as GffObj)["Creature List"] = {
      type: "list", value: [{
        __struct_id: 4,
        Tag: { type: "cexostring", value: "wolf01" },
        XPosition: { type: "float", value: 5.0 },
        YPosition: { type: "float", value: 5.0 },
        ZPosition: { type: "float", value: 0.0 },
      }],
    };

    mockIndex = createMockIndex({
      resources: new Map([["testarea.git", { resref: "testarea", extension: "git", filePath: gitPath, sizeBytes: 100 }]]),
      parsedGff: new Map([["testarea.git", gitDoc]]),
      areas: new Map([["testarea", { resref: "testarea", name: "Test", width: 4, height: 4, tileset: "ttf01", isInterior: false, creatureCount: 1, placeableCount: 0, doorCount: 0, encounterCount: 0, triggerCount: 0, waypointCount: 0 }]]),
    });

    const { registerObjectMgmtTools } = await import("./object-mgmt-tools.js");
    const { client, cleanup } = await createTestClient(registerObjectMgmtTools);
    try {
      const result = await client.callTool({
        name: "move_object",
        arguments: { area: "testarea", listName: "Creature List", tag: "nonexistent", x: "10", y: "10" },
      });
      const text = resultText(result);
      expect(text).toContain("not found");
    } finally {
      await cleanup();
    }
  });
});

// ─── delete_area ────────────────────────────────────────────────────────

describe("delete_area", () => {
  it("deletes a non-entry area", async () => {
    const areDoc = makeAreDoc();
    const gitDoc = makeGitDoc();
    const arePath = path.join(tempDir, "secondary.are");
    const gitPath = path.join(tempDir, "secondary.git");
    const gicPath = path.join(tempDir, "secondary.gic");
    await fs.writeFile(arePath, "{}");
    await fs.writeFile(gitPath, "{}");
    await fs.writeFile(gicPath, "{}");

    const ifoDoc = {
      __data_type: "IFO ",
      Mod_Entry_Area: { type: "resref", value: "primary" },
      Mod_Area_list: { type: "list", value: [
        { __struct_id: 0, Area_Name: { type: "resref", value: "primary" } },
        { __struct_id: 1, Area_Name: { type: "resref", value: "secondary" } },
      ] },
    } as unknown as GffDocument;
    const ifoPath = path.join(tempDir, "module.ifo");
    await fs.writeFile(ifoPath, "{}");

    mockIndex = createMockIndex({
      resources: new Map([
        ["secondary.are", { resref: "secondary", extension: "are", filePath: arePath, sizeBytes: 100 }],
        ["secondary.git", { resref: "secondary", extension: "git", filePath: gitPath, sizeBytes: 100 }],
        ["secondary.gic", { resref: "secondary", extension: "gic", filePath: gicPath, sizeBytes: 100 }],
        ["module.ifo", { resref: "module", extension: "ifo", filePath: ifoPath, sizeBytes: 100 }],
      ]),
      parsedGff: new Map([
        ["secondary.are", areDoc],
        ["secondary.git", gitDoc],
        ["module.ifo", ifoDoc],
      ]),
      areas: new Map([
        ["primary", { resref: "primary", name: "Primary", width: 4, height: 4, tileset: "ttf01", isInterior: false, creatureCount: 0, placeableCount: 0, doorCount: 0, encounterCount: 0, triggerCount: 0, waypointCount: 0 }],
        ["secondary", { resref: "secondary", name: "Test Area", width: 4, height: 4, tileset: "ttf01", isInterior: false, creatureCount: 0, placeableCount: 0, doorCount: 0, encounterCount: 0, triggerCount: 0, waypointCount: 0 }],
      ]),
      creatures: [
        { tag: "wolf", firstName: "Wolf", lastName: "", cr: 1, hp: 10, classes: [], conversation: "", area: "secondary", faction: 1, position: { x: 5, y: 5, z: 0 } },
      ],
    });

    const { registerPaintTools } = await import("./paint-tools.js");
    const { client, cleanup } = await createTestClient(registerPaintTools);
    try {
      const result = await client.callTool({
        name: "delete_area",
        arguments: { area: "secondary" },
      });
      const parsed = parseResult(result) as Record<string, unknown>;
      expect(parsed.success).toBe(true);
      expect((parsed.deleted as Record<string, string>).resref).toBe("secondary");
      expect(parsed.remainingAreas).toBe(1);

      // Verify caches cleaned
      expect(mockIndex.areas.has("secondary")).toBe(false);
      expect(mockIndex.resources.has("secondary.are")).toBe(false);
      expect(mockIndex.resources.has("secondary.git")).toBe(false);
      expect(mockIndex.parsedGff.has("secondary.are")).toBe(false);
      expect(mockIndex.creatures.length).toBe(0);

      // Verify IFO updated
      const ifo = ifoDoc as GffObj;
      const areaList = (ifo.Mod_Area_list as { value: GffObj[] }).value;
      expect(areaList.length).toBe(1);
      expect((areaList[0].Area_Name as { value: string }).value).toBe("primary");
    } finally {
      await cleanup();
    }
  });

  it("blocks deletion of entry area", async () => {
    const ifoDoc = {
      __data_type: "IFO ",
      Mod_Entry_Area: { type: "resref", value: "primary" },
      Mod_Area_list: { type: "list", value: [
        { __struct_id: 0, Area_Name: { type: "resref", value: "primary" } },
      ] },
    } as unknown as GffDocument;

    mockIndex = createMockIndex({
      parsedGff: new Map([["module.ifo", ifoDoc]]),
      areas: new Map([
        ["primary", { resref: "primary", name: "Primary", width: 4, height: 4, tileset: "ttf01", isInterior: false, creatureCount: 0, placeableCount: 0, doorCount: 0, encounterCount: 0, triggerCount: 0, waypointCount: 0 }],
      ]),
    });

    const { registerPaintTools } = await import("./paint-tools.js");
    const { client, cleanup } = await createTestClient(registerPaintTools);
    try {
      const result = await client.callTool({
        name: "delete_area",
        arguments: { area: "primary" },
      });
      const text = resultText(result);
      expect(text).toContain("Cannot delete the module entry area");
    } finally {
      await cleanup();
    }
  });

  it("rejects nonexistent area", async () => {
    mockIndex = createMockIndex();

    const { registerPaintTools } = await import("./paint-tools.js");
    const { client, cleanup } = await createTestClient(registerPaintTools);
    try {
      const result = await client.callTool({
        name: "delete_area",
        arguments: { area: "nonexistent" },
      });
      const text = resultText(result);
      expect(text).toContain("Area not found");
    } finally {
      await cleanup();
    }
  });
});
