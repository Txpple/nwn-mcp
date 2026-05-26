import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerAnalysisTools } from "./tools/analysis-tools.js";
import { registerAreaTools } from "./tools/area-tools.js";
import { registerBlueprintTools } from "./tools/blueprint-tools.js";
import { registerBulkTools } from "./tools/bulk-tools.js";
import { registerCoreReadTools } from "./tools/core-read.js";
import { registerCreatureTools } from "./tools/creature-tools.js";
import { registerDialogTools } from "./tools/dialog-tools.js";
import { registerDatabaseTools } from "./tools/database-tools.js";
import { registerModuleTools } from "./tools/module-tools.js";
import { registerNasherTools } from "./tools/nasher-tools.js";
import { registerDialogWriteTools } from "./tools/dialog-write-tools.js";
import { registerEncounterTools } from "./tools/encounter-tools.js";
import { registerItemTools } from "./tools/item-tools.js";
import { registerJournalTools } from "./tools/journal-tools.js";
import { registerLookupTools } from "./tools/lookup-tools.js";
import { registerObjectMgmtTools } from "./tools/object-mgmt-tools.js";
import { registerPaintTools } from "./tools/paint-tools.js";
import { registerPlacementTools } from "./tools/placement-tools.js";
import { registerResmanTools } from "./tools/resman-tools.js";
import { registerScriptTools } from "./tools/script-tools.js";
import { registerTilesetTools } from "./tools/tileset-tools.js";
import { registerFactionTools } from "./tools/faction-tools.js";
import { registerUndoTools } from "./tools/undo-tools.js";
import { registerWriteTools } from "./tools/write-tools.js";
import { registerAdventureTools } from "./tools/adventure-tools.js";

const server = new McpServer({
  name: "nwn-mcp",
  version: "1.0.0",
});

// ── Base tools: module reading, querying, analysis ──────────────────────
registerCoreReadTools(server);
registerNasherTools(server);
registerAreaTools(server);
registerCreatureTools(server);
registerItemTools(server);
registerDialogTools(server);
registerScriptTools(server);
registerAnalysisTools(server);
registerLookupTools(server);
registerEncounterTools(server);
registerResmanTools(server);
registerTilesetTools(server);
registerDatabaseTools(server);

// ── Base tools: module writing, editing, placement ──────────────────────
registerWriteTools(server);
registerPaintTools(server);
registerPlacementTools(server);
registerObjectMgmtTools(server);
registerBlueprintTools(server);
registerJournalTools(server);
registerDialogWriteTools(server);
registerModuleTools(server);
registerFactionTools(server);
registerBulkTools(server);
registerUndoTools(server);

// ── Adventure creator tools ─────────────────────────────────────────────
registerAdventureTools(server);

// Start the server
const transport = new StdioServerTransport();
await server.connect(transport);

// Log to stderr (stdout is reserved for MCP protocol)
console.error("NWN MCP server started");
