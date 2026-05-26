import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { getFieldNum, type GffDocument, type GffObj } from "../types/gff.js";
import type { ModuleIndex } from "../types/module.js";

vi.mock("../nim-tools.js", () => ({
  jsonToGff: vi.fn(async (doc: unknown, filePath: string) => {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(doc));
  }),
  resmanExtract: vi.fn(async () => {}),
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

function makeTerrainPaintAreDoc(width = 6, height = 6): GffDocument {
  const tileList: GffObj[] = Array.from({ length: width * height }, (_, index) => ({
    __struct_id: index,
    Tile_ID: { type: "int", value: 0 },
    Tile_Orientation: { type: "int", value: 0 },
    Tile_Height: { type: "int", value: 0 },
  }));

  return {
    __data_type: "ARE ",
    Name: { type: "cexolocstring", value: { "0": "Test Area" } },
    Width: { type: "int", value: width },
    Height: { type: "int", value: height },
    Tileset: { type: "resref", value: "ttf01" },
    Tile_List: { type: "list", value: tileList },
  } as unknown as GffDocument;
}

function makeForestPitSet(): string {
  return `
[GENERAL]
Name=Forest Pit Test
Interior=0
Default=Forest

[TERRAIN TYPES]
Count=2

[TERRAIN0]
Name=Forest
StrRef=-1

[TERRAIN1]
Name=Pit
StrRef=-1

[CROSSER TYPES]
Count=0

[PRIMARY RULES]
Count=2

[PRIMARY RULE0]
Placed=Forest
PlacedHeight=0
Adjacent=Pit
AdjacentHeight=0
Changed=Pit
ChangedHeight=0

[PRIMARY RULE1]
Placed=Pit
PlacedHeight=0
Adjacent=Forest
AdjacentHeight=0
Changed=Forest
ChangedHeight=0

[SECONDARY RULES]
Count=0

[TILES]
Count=4

[TILE0]
Model=forest
TopLeft=Forest
TopLeftHeight=0
TopRight=Forest
TopRightHeight=0
BottomLeft=Forest
BottomLeftHeight=0
BottomRight=Forest
BottomRightHeight=0
Top=
Right=
Bottom=
Left=
Doors=0
Sounds=0
Orientation=0

[TILE1]
Model=pit
TopLeft=Pit
TopLeftHeight=0
TopRight=Pit
TopRightHeight=0
BottomLeft=Pit
BottomLeftHeight=0
BottomRight=Pit
BottomRightHeight=0
Top=
Right=
Bottom=
Left=
Doors=0
Sounds=0
Orientation=0

[TILE2]
Model=pit_corner
TopLeft=Forest
TopLeftHeight=0
TopRight=Forest
TopRightHeight=0
BottomLeft=Pit
BottomLeftHeight=0
BottomRight=Forest
BottomRightHeight=0
Top=
Right=
Bottom=
Left=
Doors=0
Sounds=0
Orientation=0

[TILE3]
Model=pit_edge
TopLeft=Pit
TopLeftHeight=0
TopRight=Forest
TopRightHeight=0
BottomLeft=Pit
BottomLeftHeight=0
BottomRight=Forest
BottomRightHeight=0
Top=
Right=
Bottom=
Left=
Doors=0
Sounds=0
Orientation=0
`;
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
  const textBlock = result.content.find((c) => c.type === "text");
  return textBlock?.text ? JSON.parse(textBlock.text) : null;
}

beforeEach(async () => {
  tempDir = path.join(os.tmpdir(), `nwn-mcp-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await fs.mkdir(path.join(tempDir, "tileset_cache"), { recursive: true });
  await fs.writeFile(path.join(tempDir, "tileset_cache", "ttf01.set"), makeForestPitSet());
  mockIndex = createMockIndex();

  const { clearTilesetCache } = await import("../util/tileset.js");
  clearTilesetCache();
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe("paint_terrain", () => {
  it("re-solves neighboring tiles that share a painted pit tile's corners", async () => {
    const areDoc = makeTerrainPaintAreDoc();
    const arePath = path.join(tempDir, "testarea.are");
    await fs.writeFile(arePath, "{}");

    mockIndex.resources.set("testarea.are", {
      resref: "testarea",
      extension: "are",
      filePath: arePath,
      sizeBytes: 100,
    });
    mockIndex.parsedGff.set("testarea.are", areDoc);

    const { registerPaintTools } = await import("./paint-tools.js");
    const { client, cleanup } = await createTestClient(registerPaintTools);
    try {
      const result = await client.callTool({
        name: "paint_terrain",
        arguments: { area: "testarea", terrain: "Pit", tiles: JSON.stringify([{ x: 2, y: 5 }]) },
      });
      const parsed = parseResult(result) as Record<string, unknown>;

      expect(parsed.success).toBe(true);
      expect(parsed.warnings).toEqual([]);
      expect((parsed.placements as Array<Record<string, number>>).map((p) => [p.x, p.y, p.tileId, p.orientation]))
        .toEqual([
          [1, 4, 2, 2],
          [2, 4, 3, 3],
          [3, 4, 2, 3],
          [1, 5, 3, 2],
          [2, 5, 1, 0],
          [3, 5, 3, 0],
        ]);

      const tileList = ((areDoc as GffObj).Tile_List as { value: GffObj[] }).value;
      const tileAt = (x: number, y: number) => {
        const entry = tileList[y * 6 + x];
        return {
          tileId: getFieldNum(entry, "Tile_ID"),
          orientation: getFieldNum(entry, "Tile_Orientation"),
        };
      };

      expect(tileAt(1, 4)).toEqual({ tileId: 2, orientation: 2 });
      expect(tileAt(2, 4)).toEqual({ tileId: 3, orientation: 3 });
      expect(tileAt(3, 4)).toEqual({ tileId: 2, orientation: 3 });
      expect(tileAt(1, 5)).toEqual({ tileId: 3, orientation: 2 });
      expect(tileAt(2, 5)).toEqual({ tileId: 1, orientation: 0 });
      expect(tileAt(3, 5)).toEqual({ tileId: 3, orientation: 0 });
    } finally {
      await cleanup();
    }
  });
});
