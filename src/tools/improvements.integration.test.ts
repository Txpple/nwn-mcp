/**
 * Integration tests for improvement features:
 * - Collision detection on placement
 * - create_area_transition tool
 * - create_trap_blueprint tool
 * - verify_quest_completability tool
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import path from "path";
import os from "os";
import fs from "fs/promises";

import type { GffDocument, GffObj } from "../types/gff.js";
import type { ModuleIndex } from "../types/module.js";

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
  compileScript: vi.fn(async () => ({ success: true, output: "" })),
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
}));

vi.mock("./tileset-tools.js", () => ({
  invalidateTagToAreaCache: vi.fn(),
  buildTagToAreaMap: vi.fn(() => new Map()),
  buildAreaTransitions: vi.fn(() => []),
}));

// Mock walkmesh: always report walkable
vi.mock("../util/walkmesh.js", () => ({
  checkPositionWalkable: vi.fn(async () => ({ walkable: true, material: "Grass", materialId: 7 })),
  ensureWokCacheDir: vi.fn(),
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
  const textBlock = result.content.find(c => c.type === "text");
  return textBlock?.text ? JSON.parse(textBlock.text) : null;
}

beforeEach(async () => {
  tempDir = path.join(os.tmpdir(), `nwn-mcp-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await fs.mkdir(tempDir, { recursive: true });
  mockIndex = createMockIndex();
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

// ─── Tests: Collision detection ──────────────────────────────────────────

describe("placement collision detection", () => {
  it("warns when placing a creature near an existing creature", async () => {
    // Set up area with an existing creature at (25, 25)
    const git = makeGitDoc();
    const creatureList = (git as GffObj)["Creature List"] as { type: string; value: GffObj[] };
    creatureList.value.push({
      __struct_id: 4,
      Tag: { type: "cexostring", value: "existing_npc" },
      XPosition: { type: "float", value: 25.0 },
      YPosition: { type: "float", value: 25.0 },
      ZPosition: { type: "float", value: 0 },
      FirstName: { type: "cexolocstring", value: { "0": "Existing NPC" } },
    } as unknown as GffObj);

    mockIndex.parsedGff.set("testarea.git", git);
    mockIndex.parsedGff.set("testarea.are", makeAreDoc());
    mockIndex.areas.set("testarea", { resref: "testarea", name: "Test Area", width: 4, height: 4, tileset: "ttf01", creatureCount: 1, placeableCount: 0, doorCount: 0, waypointCount: 0, triggerCount: 0, encounterCount: 0, soundCount: 0, storeCount: 0 });

    // Write a mock UTC blueprint
    const utcDoc = {
      __data_type: "UTC ",
      Tag: { type: "cexostring", value: "new_npc" },
      FirstName: { type: "cexolocstring", value: { "0": "New NPC" } },
      TemplateResRef: { type: "resref", value: "new_npc" },
    };
    const utcPath = path.join(tempDir, "new_npc.utc");
    await fs.writeFile(utcPath, JSON.stringify(utcDoc));
    mockIndex.resources.set("new_npc.utc", { resref: "new_npc", extension: "utc", filePath: utcPath, sizeBytes: 100 });
    mockIndex.parsedGff.set("new_npc.utc", utcDoc as unknown as GffDocument);

    const { registerPlacementTools } = await import("./placement-tools.js");
    const { client, cleanup } = await createTestClient(registerPlacementTools);

    try {
      // Place at (25.5, 25.0) — within 1m of existing creature
      const result = await client.callTool({
        name: "place_creature",
        arguments: { area: "testarea", blueprint: "new_npc", x: "25.5", y: "25.0" },
      });

      const parsed = parseResult(result) as Record<string, unknown>;
      expect(parsed.success).toBe(true);
      expect(parsed.collisionWarning).toBeDefined();
      expect(parsed.collisionWarning).toContain("existing_npc");
    } finally {
      await cleanup();
    }
  });

  it("does not warn when placing far from existing objects", async () => {
    const git = makeGitDoc();
    const creatureList = (git as GffObj)["Creature List"] as { type: string; value: GffObj[] };
    creatureList.value.push({
      __struct_id: 4,
      Tag: { type: "cexostring", value: "far_npc" },
      XPosition: { type: "float", value: 10.0 },
      YPosition: { type: "float", value: 10.0 },
      ZPosition: { type: "float", value: 0 },
    } as unknown as GffObj);

    mockIndex.parsedGff.set("testarea.git", git);
    mockIndex.parsedGff.set("testarea.are", makeAreDoc());
    mockIndex.areas.set("testarea", { resref: "testarea", name: "Test Area", width: 4, height: 4, tileset: "ttf01", creatureCount: 1, placeableCount: 0, doorCount: 0, waypointCount: 0, triggerCount: 0, encounterCount: 0, soundCount: 0, storeCount: 0 });

    const utcDoc = {
      __data_type: "UTC ",
      Tag: { type: "cexostring", value: "new_npc" },
      FirstName: { type: "cexolocstring", value: { "0": "New NPC" } },
      TemplateResRef: { type: "resref", value: "new_npc" },
    };
    const utcPath = path.join(tempDir, "new_npc.utc");
    await fs.writeFile(utcPath, JSON.stringify(utcDoc));
    mockIndex.resources.set("new_npc.utc", { resref: "new_npc", extension: "utc", filePath: utcPath, sizeBytes: 100 });
    mockIndex.parsedGff.set("new_npc.utc", utcDoc as unknown as GffDocument);

    const { registerPlacementTools } = await import("./placement-tools.js");
    const { client, cleanup } = await createTestClient(registerPlacementTools);

    try {
      // Place at (25, 25) — far from existing creature at (10, 10)
      const result = await client.callTool({
        name: "place_creature",
        arguments: { area: "testarea", blueprint: "new_npc", x: "25.0", y: "25.0" },
      });

      const parsed = parseResult(result) as Record<string, unknown>;
      expect(parsed.success).toBe(true);
      expect(parsed.collisionWarning).toBeUndefined();
    } finally {
      await cleanup();
    }
  });
});

// ─── Tests: create_area_transition ───────────────────────────────────────

describe("create_area_transition", () => {
  it("creates a one-way trigger→waypoint transition", async () => {
    // Set up two areas
    const gitSource = makeGitDoc();
    const gitTarget = makeGitDoc();

    mockIndex.parsedGff.set("forest.git", gitSource);
    mockIndex.parsedGff.set("forest.are", makeAreDoc());
    mockIndex.parsedGff.set("cave.git", gitTarget);
    mockIndex.parsedGff.set("cave.are", makeAreDoc());
    mockIndex.areas.set("forest", { resref: "forest", name: "Forest", width: 4, height: 4, tileset: "ttf01", creatureCount: 0, placeableCount: 0, doorCount: 0, waypointCount: 0, triggerCount: 0, encounterCount: 0, soundCount: 0, storeCount: 0 });
    mockIndex.areas.set("cave", { resref: "cave", name: "Cave", width: 4, height: 4, tileset: "tdc01", creatureCount: 0, placeableCount: 0, doorCount: 0, waypointCount: 0, triggerCount: 0, encounterCount: 0, soundCount: 0, storeCount: 0 });
    // Write GIT files to disk (writeBackGit needs them)
    const forestGitPath = path.join(tempDir, "forest.git");
    const caveGitPath = path.join(tempDir, "cave.git");
    await fs.writeFile(forestGitPath, JSON.stringify(gitSource));
    await fs.writeFile(caveGitPath, JSON.stringify(gitTarget));
    mockIndex.resources.set("forest.git", { resref: "forest", extension: "git", filePath: forestGitPath, sizeBytes: 100 });
    mockIndex.resources.set("cave.git", { resref: "cave", extension: "git", filePath: caveGitPath, sizeBytes: 100 });

    // Write a minimal trigger blueprint
    const uttDoc = {
      __data_type: "UTT ",
      Tag: { type: "cexostring", value: "generic_trigger" },
      LocalizedName: { type: "cexolocstring", value: { "0": "Generic Trigger" } },
      TemplateResRef: { type: "resref", value: "nw_yourfeet" },
      ScriptOnEnter: { type: "resref", value: "" },
    };
    const uttPath = path.join(tempDir, "nw_yourfeet.utt");
    await fs.writeFile(uttPath, JSON.stringify(uttDoc));
    mockIndex.resources.set("nw_yourfeet.utt", { resref: "nw_yourfeet", extension: "utt", filePath: uttPath, sizeBytes: 100 });
    mockIndex.parsedGff.set("nw_yourfeet.utt", uttDoc as unknown as GffDocument);

    const { registerObjectMgmtTools } = await import("./object-mgmt-tools.js");
    const { client, cleanup } = await createTestClient(registerObjectMgmtTools);

    try {
      const result = await client.callTool({
        name: "create_area_transition",
        arguments: {
          sourceArea: "forest",
          sourceX: "35.0",
          sourceY: "25.0",
          targetArea: "cave",
          targetX: "15.0",
          targetY: "15.0",
          tag: "forest_to_cave",
        },
      });

      const parsed = parseResult(result) as Record<string, unknown>;
      expect(parsed.success).toBe(true);

      const transition = parsed.transition as Record<string, unknown>;
      expect(transition.compiled).toBe(true);

      const source = transition.source as Record<string, unknown>;
      expect(source.area).toBe("forest");
      expect(source.triggerTag).toBe("tr_forest_to_cave");

      const target = transition.target as Record<string, unknown>;
      expect(target.area).toBe("cave");
      expect(target.waypointTag).toBe("wp_forest_to_cave");

      // Verify trigger placed in source area
      const sourceGit = mockIndex.parsedGff.get("forest.git") as GffObj;
      const triggers = (sourceGit["TriggerList"] as { value: GffObj[] }).value;
      expect(triggers.length).toBe(1);
      expect((triggers[0].Tag as { value: string }).value).toBe("tr_forest_to_cave");
      expect((triggers[0].LinkedTo as { value: string }).value).toBe("wp_forest_to_cave");
      expect((triggers[0].LinkedToFlags as { value: number }).value).toBe(2);

      // Verify waypoint placed in target area
      const targetGit = mockIndex.parsedGff.get("cave.git") as GffObj;
      const waypoints = (targetGit.WaypointList as { value: GffObj[] }).value;
      expect(waypoints.length).toBe(1);
      expect((waypoints[0].Tag as { value: string }).value).toBe("wp_forest_to_cave");

      // Verify script was written
      // "a_tr_forest_to_cave" truncated to 16 chars = "a_tr_forest_to_c"
      expect(mockIndex.resources.has("a_tr_forest_to_c.nss")).toBe(true);
    } finally {
      await cleanup();
    }
  });
});

// ─── Tests: create_trap_blueprint ────────────────────────────────────────

describe("create_trap_blueprint", () => {
  it("creates a trap blueprint from scratch with correct fields", async () => {
    const { registerBlueprintTools } = await import("./blueprint-tools.js");
    const { client, cleanup } = await createTestClient(registerBlueprintTools);

    try {
      const result = await client.callTool({
        name: "create_trap_blueprint",
        arguments: {
          resref: "trap_fire",
          tag: "trap_fire_01",
          name: "Fire Trap",
          scriptOnEnter: "a_trap_fire",
          detectDC: "20",
          disarmDC: "18",
          oneShot: true,
          size: "4.0",
        },
      });

      const parsed = parseResult(result) as Record<string, unknown>;
      expect(parsed.success).toBe(true);
      expect(parsed.resref).toBe("trap_fire");
      expect(parsed.detectDC).toBe(20);
      expect(parsed.disarmDC).toBe(18);
      expect(parsed.oneShot).toBe(true);
      expect(parsed.size).toBe(4.0);

      // Verify in index
      expect(mockIndex.resources.has("trap_fire.utt")).toBe(true);
      expect(mockIndex.parsedGff.has("trap_fire.utt")).toBe(true);

      // Verify GFF structure
      const doc = mockIndex.parsedGff.get("trap_fire.utt") as GffObj;
      expect((doc.Tag as { value: string }).value).toBe("trap_fire_01");
      expect((doc.ScriptOnEnter as { value: string }).value).toBe("a_trap_fire");
      expect((doc.TrapDetectDC as { value: number }).value).toBe(20);
      expect((doc.TrapFlag as { value: number }).value).toBe(1);
      expect((doc.TrapOneShot as { value: number }).value).toBe(1);
      expect((doc.TrapDetectable as { value: number }).value).toBe(1);
      expect((doc.TrapDisarmable as { value: number }).value).toBe(1);

      // Verify geometry (4 vertices for square)
      const geometry = (doc.Geometry as { value: GffObj[] }).value;
      expect(geometry.length).toBe(4);
    } finally {
      await cleanup();
    }
  });

  it("uses default values when optionals omitted", async () => {
    const { registerBlueprintTools } = await import("./blueprint-tools.js");
    const { client, cleanup } = await createTestClient(registerBlueprintTools);

    try {
      const result = await client.callTool({
        name: "create_trap_blueprint",
        arguments: {
          resref: "trap_basic",
          tag: "trap_basic_01",
          name: "Basic Trap",
          scriptOnEnter: "a_trap_basic",
        },
      });

      const parsed = parseResult(result) as Record<string, unknown>;
      expect(parsed.success).toBe(true);
      expect(parsed.detectDC).toBe(15); // default
      expect(parsed.disarmDC).toBe(15); // default
      expect(parsed.oneShot).toBe(true); // default
      expect(parsed.size).toBe(3.0); // default
    } finally {
      await cleanup();
    }
  });
});

// ─── Tests: verify_quest_completability ──────────────────────────────────

describe("verify_quest_completability", () => {
  it("returns no-journal error when no JRL exists", async () => {
    const { registerAnalysisTools } = await import("./analysis-tools.js");
    const { client, cleanup } = await createTestClient(registerAnalysisTools);

    try {
      const result = await client.callTool({
        name: "verify_quest_completability",
        arguments: {},
      });

      const parsed = parseResult(result) as Record<string, unknown>;
      expect(parsed.error).toContain("No journal");
    } finally {
      await cleanup();
    }
  });

  it("reports empty quests", async () => {
    // JRL with categories but no entries
    const jrlDoc = {
      __data_type: "JRL ",
      Categories: {
        type: "list",
        value: [],
      },
    } as unknown as GffDocument;

    mockIndex.parsedGff.set("module.jrl", jrlDoc);

    const { registerAnalysisTools } = await import("./analysis-tools.js");
    const { client, cleanup } = await createTestClient(registerAnalysisTools);

    try {
      const result = await client.callTool({
        name: "verify_quest_completability",
        arguments: {},
      });

      const parsed = parseResult(result) as Record<string, unknown>;
      expect(parsed.quests).toEqual([]);
      expect(parsed.message).toBe("No quests defined");
    } finally {
      await cleanup();
    }
  });

  it("detects incomplete quest with no scripts", async () => {
    // Set up IFO for start area
    const ifoDoc = {
      __data_type: "IFO ",
      Mod_Entry_Area: { type: "resref", value: "town" },
    } as unknown as GffDocument;
    mockIndex.parsedGff.set("module.ifo", ifoDoc);
    mockIndex.areas.set("town", { resref: "town", name: "Town", width: 4, height: 4, tileset: "ttf01", creatureCount: 0, placeableCount: 0, doorCount: 0, waypointCount: 0, triggerCount: 0, encounterCount: 0, soundCount: 0, storeCount: 0 });
    mockIndex.parsedGff.set("town.git", makeGitDoc());

    // JRL with a quest that has entries but no scripts reference them
    const jrlDoc = {
      __data_type: "JRL ",
      Categories: {
        type: "list",
        value: [
          {
            __struct_id: 0,
            Tag: { type: "cexostring", value: "q_rescue" },
            Name: { type: "cexolocstring", value: { "0": "Rescue Mission" } },
            Priority: { type: "dword", value: 0 },
            XP: { type: "dword", value: 100 },
            Comment: { type: "cexostring", value: "" },
            EntryList: {
              type: "list",
              value: [
                { __struct_id: 0, ID: { type: "dword", value: 1 }, Text: { type: "cexolocstring", value: { "0": "Find the missing villager" } }, End: { type: "word", value: 0 } },
                { __struct_id: 1, ID: { type: "dword", value: 2 }, Text: { type: "cexolocstring", value: { "0": "Villager rescued!" } }, End: { type: "word", value: 1 } },
              ],
            },
          },
        ],
      },
    } as unknown as GffDocument;
    mockIndex.parsedGff.set("module.jrl", jrlDoc);

    const { registerAnalysisTools } = await import("./analysis-tools.js");
    const { client, cleanup } = await createTestClient(registerAnalysisTools);

    try {
      const result = await client.callTool({
        name: "verify_quest_completability",
        arguments: {},
      });

      const parsed = parseResult(result) as Record<string, unknown>;
      expect(parsed.questCount).toBe(1);
      expect(parsed.allCompletable).toBe(false);

      const quests = parsed.quests as Array<Record<string, unknown>>;
      expect(quests[0].tag).toBe("q_rescue");
      expect(quests[0].completable).toBe(false);
      expect(quests[0].gaps).toBeDefined();

      const gaps = quests[0].gaps as string[];
      // Should flag that journal entries have no scripts
      expect(gaps.some(g => g.includes("entry 1") || g.includes("AddJournalQuestEntry"))).toBe(true);
      // Should flag no quest-giver dialog
      expect(gaps.some(g => g.includes("dialog"))).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it("reports quest as completable when scripts exist", async () => {
    const ifoDoc = {
      __data_type: "IFO ",
      Mod_Entry_Area: { type: "resref", value: "town" },
    } as unknown as GffDocument;
    mockIndex.parsedGff.set("module.ifo", ifoDoc);

    // Set up area with an NPC that has a dialog
    const git = makeGitDoc();
    const creatureList = (git as GffObj)["Creature List"] as { type: string; value: GffObj[] };
    creatureList.value.push({
      __struct_id: 4,
      Tag: { type: "cexostring", value: "quest_giver" },
      Conversation: { type: "resref", value: "dlg_giver" },
      XPosition: { type: "float", value: 15.0 },
      YPosition: { type: "float", value: 15.0 },
    } as unknown as GffObj);

    mockIndex.parsedGff.set("town.git", git);
    mockIndex.parsedGff.set("town.are", makeAreDoc());
    mockIndex.areas.set("town", { resref: "town", name: "Town", width: 4, height: 4, tileset: "ttf01", creatureCount: 1, placeableCount: 0, doorCount: 0, waypointCount: 0, triggerCount: 0, encounterCount: 0, soundCount: 0, storeCount: 0 });

    // Set up dialog with quest script
    const dlgDoc = {
      __data_type: "DLG ",
      StartingList: { type: "list", value: [
        { __struct_id: 0, Index: { type: "dword", value: 0 }, Active: { type: "resref", value: "" } },
      ] },
      EntryList: { type: "list", value: [
        {
          __struct_id: 0,
          Text: { type: "cexolocstring", value: { "0": "Will you help?" } },
          Script: { type: "resref", value: "a_q_start" },
          RepliesList: { type: "list", value: [] },
        },
      ] },
      ReplyList: { type: "list", value: [] },
    } as unknown as GffDocument;
    mockIndex.parsedGff.set("dlg_giver.dlg", dlgDoc);

    // Write quest scripts to disk
    const startScript = `void main() { AddJournalQuestEntry("q_fetch", 1); }`;
    const endScript = `void main() { AddJournalQuestEntry("q_fetch", 2); }`;
    const startPath = path.join(tempDir, "a_q_start.nss");
    const endPath = path.join(tempDir, "a_q_end.nss");
    await fs.writeFile(startPath, startScript);
    await fs.writeFile(endPath, endScript);
    mockIndex.resources.set("a_q_start.nss", { resref: "a_q_start", extension: "nss", filePath: startPath, sizeBytes: startScript.length });
    mockIndex.resources.set("a_q_end.nss", { resref: "a_q_end", extension: "nss", filePath: endPath, sizeBytes: endScript.length });

    // JRL
    const jrlDoc = {
      __data_type: "JRL ",
      Categories: {
        type: "list",
        value: [
          {
            __struct_id: 0,
            Tag: { type: "cexostring", value: "q_fetch" },
            Name: { type: "cexolocstring", value: { "0": "Fetch Quest" } },
            Priority: { type: "dword", value: 0 },
            XP: { type: "dword", value: 50 },
            Comment: { type: "cexostring", value: "" },
            EntryList: {
              type: "list",
              value: [
                { __struct_id: 0, ID: { type: "dword", value: 1 }, Text: { type: "cexolocstring", value: { "0": "Find the item" } }, End: { type: "word", value: 0 } },
                { __struct_id: 1, ID: { type: "dword", value: 2 }, Text: { type: "cexolocstring", value: { "0": "Item found!" } }, End: { type: "word", value: 1 } },
              ],
            },
          },
        ],
      },
    } as unknown as GffDocument;
    mockIndex.parsedGff.set("module.jrl", jrlDoc);

    const { registerAnalysisTools } = await import("./analysis-tools.js");
    const { client, cleanup } = await createTestClient(registerAnalysisTools);

    try {
      const result = await client.callTool({
        name: "verify_quest_completability",
        arguments: {},
      });

      const parsed = parseResult(result) as Record<string, unknown>;
      expect(parsed.questCount).toBe(1);
      expect(parsed.allCompletable).toBe(true);

      const quests = parsed.quests as Array<Record<string, unknown>>;
      expect(quests[0].completable).toBe(true);
      expect(quests[0].hasEndEntry).toBe(true);
      expect(quests[0].scriptsFound).toBe(2); // entries 1 and 2
      expect(quests[0].questGiver).toBeDefined();

      const giver = quests[0].questGiver as Record<string, unknown>;
      expect(giver.dialog).toBe("dlg_giver");
      expect(giver.area).toBe("town");
    } finally {
      await cleanup();
    }
  });
});
