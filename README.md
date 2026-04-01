# NWN MCP Server

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

An [MCP](https://modelcontextprotocol.io/) (Model Context Protocol) server for **Neverwinter Nights: Enhanced Edition** module files (`.mod`). It wraps [neverwinter.nim](https://github.com/niv/neverwinter.nim) CLI tools to let AI assistants read, query, and modify NWN modules through structured tool calls.

## Features

- **Load and inspect** `.mod` files — areas, creatures, items, dialogs, scripts, placeables, and more
- **Create and edit** areas, place objects, write dialogs, build quests
- **Compile scripts**, manage journals, link area transitions, and validate modules
- **Bulk operations** — rename tags, move or remove objects across areas, and orchestrate complex multi-step changes with natural language
- **Search blueprints** across the full resource stack (base game + HAKs + module)
- **Spatial awareness** — JSON payload of tile grids, walkable zones, and placed objects for AI reasoning
- **Query and update** NWN SQLite campaign databases
- **HTML area reports** — interactive visual maps of areas for human review

**Bonus:** A one-shot adventure creator skill with subagents to generate a small module with 30–60 minutes of gameplay for you and your friends. If you have the tokens, use `/create-adventure` and have fun.

Designed for two workflows:

1. **AI-assisted module design** — You stay in creative control while an AI helps build, modify, and extend your module via natural language.
2. **AI-driven adventure creation** — A small, proof-of-concept tool that lets an LLM autonomously generate one-shot adventures for you and your friends — quests, dialogue, areas, and placed content from a high-level prompt. Spoiler-free by design, so the DM can be surprised too. *Warning: Fully AI-generated content is best-effort, especially autonomous area painting. There may be dragons!*

## Prerequisites

- [Node.js](https://nodejs.org/) v18+
- [neverwinter.nim tools](https://github.com/niv/neverwinter.nim/releases) — `nwn_erf`, `nwn_gff`, `nwn_script_comp`, `nwn_twoda`, `nwn_resman_cat`
- Neverwinter Nights: Enhanced Edition (for base game data)
- MCP-compatible AI client (Claude Code, Claude Desktop, VS Code, etc.)

## Installation

### 1. Clone and build

```bash
git clone https://github.com/Txpple/nwn-mcp.git
cd nwn-mcp
npm install
npm run build
```

### 2. Download neverwinter.nim tools

Download the latest release for your platform from [neverwinter.nim releases](https://github.com/niv/neverwinter.nim/releases) and extract the binaries to a folder you'll reference below.

### 3. Configure your MCP client

Add the server to your MCP client config. The config location depends on your client:

| Client | Config file |
|--------|-------------|
| Claude Code | `.claude/settings.json` or `.mcp.json` in your project |
| Claude Desktop | `claude_desktop_config.json` |
| VS Code | MCP settings in `.vscode/mcp.json` |

```json
{
  "mcpServers": {
    "nwn-mcp": {
      "command": "node",
      "args": ["dist/index.js"],
      "cwd": "/path/to/nwn-mcp",
      "env": {
        "NIM_FOLDER_NWTOOLS": "/path/to/neverwinter-nim-tools",
        "NWN_FOLDER_DATA": "/path/to/Neverwinter Nights",
        "NWN_FOLDER_USER": "/path/to/Documents/Neverwinter Nights"
      }
    }
  }
}
```

See `.mcp.json.example` for a template you can copy and edit.

**Windows paths example:**
```json
{
  "NIM_FOLDER_NWTOOLS": "C:/tools/neverwinter.nim/bin",
  "NWN_FOLDER_DATA": "C:/Program Files (x86)/Steam/steamapps/common/Neverwinter Nights",
  "NWN_FOLDER_USER": "C:/Users/you/Documents/Neverwinter Nights"
}
```

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `NIM_FOLDER_NWTOOLS` | Yes | | Path to neverwinter.nim binaries |
| `NWN_FOLDER_DATA` | Yes | | NWN game install directory (base game 2DA/TLK) |
| `NWN_FOLDER_USER` | Yes | | NWN user documents directory (HAKs, overrides, modules) |
| `MCP_FOLDER_TEMP` | No | `%TEMP%/nwn-mcp` | Temp directory for extracted modules |
| `MCP_FOLDER_USERREPORTS` | No | | Directory for exported reports |

## Usage

Once connected, call `load_module` with a module filename to begin:

```
load_module("mymodule.mod")
```

Then use any of the 110+ tools to inspect and modify the module. Ask your AI assistant things like:

- "Load my module and show me a summary"
- "Create a forest area with a river running through it"
- "Place a merchant NPC near the tavern door and give her a shop"
- "Write a quest where the player retrieves a stolen amulet from a goblin cave"
- "Add wolves and a bear encounter to the wilderness area"
- "Go through my custom classes and update descriptions"
- "Add some new power scripts to my custom feats"
- "Validate the module and check for broken references"

Changes are written back to the `.mod` file via `repack_module`.

### Special Commands

- **`export_area_report`** / **`export_module_report`** — Generate interactive HTML maps of individual areas or the entire module for visual review in a browser.
- **`/create-adventure`** — Generate a complete one-shot adventure module from a creative prompt. Uses subagents to build areas, place NPCs, write quests, and populate the world autonomously.

#### Example `/create-adventure` prompts

```
/create-adventure I'd like to play an adventure in the wilderness where I fight off
animals and survive the elements. Give a somber tone. I'll be playing solo with a single level 2 character.
```

```
/create-adventure I'd like to play an adventure with city streets and thieves' guild
intrigue — sneaking, double-crosses, maybe a heist. Make it fun and cheeky. We'll be playing with a party of
3 level 5 characters.
```

```
/create-adventure I'd like to play an adventure where I'm an agent of a wizard society
sent to investigate the society's latest crisis. Classic tabletop style. Solo player,
level 4, lots of investigation and a climactic magical battle.
```

```
/create-adventure I'd like a classic dungeon crawl — an old crypt full of undead with
a powerful lich at the end. Make it old school classic gold box style. Party of 4 players around level 6.
```

```
/create-adventure Surprise me — you pick the setting, tone, and story. Solo player, level 3.
```

Just describe the kind of adventure you want to play and your party size and level — the skill takes it from there.

## Available Tools

### Areas

- `create_area` — create a new area with terrain tiles
- `get_area_details` — area properties, lighting, weather, music
- `set_area_properties` — modify lighting, fog, music, weather
- `paint_terrain` — zone-based terrain painting with automatic tile solving (supports `autoRepack` to save progress)
- `paint_feature` — place multi-tile features (temples, lodges, etc.)
- `get_tileset_details` — tileset info with summary mode (~2KB) or full tile catalog (~60-100KB)

> **Note:** Terrain painting is best-effort — always open the module in the toolset to review painted areas and touch up as needed.
- `visualize_area` — spatial JSON payload for AI reasoning
- `export_area_report` / `export_module_report` — HTML visualizations for human review

### Object Placement

- `place_creature` / `place_placeable` / `place_door` / `place_waypoint` — place objects in areas
- `place_encounter` / `place_trigger` / `place_sound` / `place_store` — encounters, triggers, sounds, stores
- `move_object` / `remove_object` / `bulk_remove_objects` — reposition or remove objects

### Blueprints

- `list_blueprints` — search base game + HAK + module blueprints
- `create_creature_blueprint` / `create_item_blueprint` — create new blueprints
- `create_encounter_blueprint` / `create_store_blueprint` / `create_trap_blueprint` — encounters, stores, traps

### Dialogs & Quests

- `create_dialog` / `flatten_dialog` / `add_dialog_node` — write and inspect conversations
- `add_journal_quest` / `add_journal_entry` — build quest journals
- `verify_quest_completability` — trace quests from dialog to journal end entry

### Scripts

- `write_script` / `compile_script` / `read_script_source` — NWScript authoring
- `search_scripts` / `list_script_references` — find and trace script usage

### Analysis

- `validate_module` — check for broken references across the module
- `check_area_connectivity` — verify all areas are reachable via transitions
- `balance_report` — creature difficulty and item values per area
- `suggest_encounter` — advisory tool for encounter composition by party level

### Module Management

- `load_module` / `repack_module` — load and save modules
- `get_module_info` / `module_summary` — module metadata and overview
- `undo_last_change` / `undo_history` — revert recent changes

### Adventure Creator

Tools specific to the `/create-adventure` pipeline for autonomous module building:

- `generate_area_layout` — procedural area layout generation (dungeon, cave, dwelling, forest, village styles)
- `find_walkable_position` — find guaranteed walkable coordinates in an area region
- `create_adventure_transition` — one-way portal transitions (blue light + VFX + dialog)

## Architecture

```
.mod file --> nwn_erf (extract) --> temp dir --> nwn_gff (parse GFF to JSON)
  --> in-memory ModuleIndex (tags, scripts, areas, dialogs, creatures, items)
    --> MCP tool handlers serve queries & modifications
      --> nwn_gff (serialize back) --> nwn_erf (repack) --> .mod file
```

One module is loaded at a time. The server builds a full resource manager stack on load — base game BIFs, module HAKs, user overrides, and module resources — giving tools access to the complete data hierarchy.

All tools carry [MCP annotations](https://spec.modelcontextprotocol.io/specification/2025-03-26/server/tools/#annotations) (`readOnlyHint`, `destructiveHint`, `idempotentHint`) so clients can understand tool behavior. Adventure-creator-specific tools are separated into `src/tools/adventure-tools.ts`; all other tools are base tools for general module editing.

## Scope

Targets **non-persistent world modules** — single-player and small co-op campaigns. Focused on instanced objects placed in areas (GIT contents). Blueprint modification, palette-level changes, and deep 2DA/ruleset authoring are out of scope. That being said, these are all possible with careful prompts.

## Development

```bash
npm run dev          # Run with tsx (hot reload)
npm run build        # Compile TypeScript
npm run start        # Run compiled output
npm run test         # Run tests (vitest)
npm run lint         # Lint with Biome
npm run format       # Format with Biome
```

## Troubleshooting

- **neverwinter.nim tools not found** — Verify `NIM_FOLDER_NWTOOLS` points to the directory containing the binaries, not a parent folder.

## Support

- **Issues**: [GitHub Issues](https://github.com/Txpple/nwn-mcp/issues)

## Acknowledgments

- [Niv](https://github.com/niv) at [neverwinter.nim](https://github.com/niv/neverwinter.nim) for all the awesome stuff he's provided
- The NWN Discord and Zulip communities

## License

MIT License — see [LICENSE](LICENSE) for details.
