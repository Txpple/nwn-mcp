# NWN MCP Server

MCP (Model Context Protocol) server for Neverwinter Nights Enhanced Edition module files (.mod). Wraps neverwinter.nim CLI tools to expose module content as structured, queryable data for LLMs.

## Working Style

- **Do NOT auto-export HTML reports** after creating or painting areas. Only export reports when the user explicitly asks for one.
- **Always repack after creating/painting test areas** so the user can see them in the toolset. Mention that you repacked.
- **MCP server restart required after code changes.** After editing TypeScript source and running `npm run build`, the MCP server must be restarted for new/changed tools to become available. Ask the user to restart before attempting to use newly added tools.

## Design Intent

This MCP serves two purposes:

**(a) AI-assisted human module design** — A human author works with an AI assistant to build, modify, and extend NWN modules via natural language. The human stays in creative control.

**(b) AI-driven creative module building** — A small, proof-of-concept tool for building one-shot adventures for yourself and friends. Spoiler-free by design, so the DM can be surprised too. An LLM autonomously designs and constructs module content based on high-level goals: generating quests, writing dialogue, designing areas, placing objects, building story. This is orchestrated via the `/create-adventure` skill and its sub-skill agents.

### Spatial Awareness

The `visualize_area` tool returns a **canonical JSON spatial payload** — the LLM's primary instrument for understanding an area (tile grid, walkable zones, zone connectivity, all placed objects with positions and properties). Call it before making placement or quest decisions.

**HTML export tools (`export_area_report`, `export_module_report`) are strictly for human inspection** — downstream of the JSON payload, never depended on by the MCP engine.

### Scope

Scoped to **non-persistent world (non-PW) modules** — single-player and small co-op campaigns. AI-driven content creation targets **instanced objects placed in areas** (GIT contents). Blueprint modification, palette-level changes, and deep 2DA/ruleset authoring are out of scope.

## Tech Stack

- **TypeScript** (ES2022, Node16 modules) — `npm run build` compiles to `dist/`
- **@modelcontextprotocol/sdk** — MCP server framework, stdio transport
- **zod** (v4) — tool parameter validation (MCP SDK requirement)
- **neverwinter.nim tools** — external binaries for binary format conversion

## Quick Start

```bash
npm run build        # Compile TypeScript to dist/
npm run dev          # Run directly with tsx (development)
npm run start        # Run compiled output
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MCP_FOLDER_USERREPORTS` | *(empty)* | Directory where user-facing reports are saved. When unset, reports go to the module temp dir |
| `NIM_FOLDER_NWTOOLS` | *(empty)* | Path to neverwinter.nim binaries |
| `NWN_FOLDER_DATA` | *(empty)* | NWN game install dir — enables base game 2DA/TLK loading via resman |
| `NWN_FOLDER_USER` | *(empty)* | NWN user documents dir — enables custom TLK, HAK, override/, development/ loading |
| `MCP_FOLDER_TEMP` | `%TEMP%/nwn-mcp` | Temp directory for extracted modules |

## Architecture

```
.mod file → nwn_erf (extract) → temp dir → nwn_gff (parse each GFF → JSON)
  → in-memory ModuleIndex (tags, scripts, areas, dialogs, creatures, items)
    → MCP tool handlers serve queries & modifications
      → nwn_gff (serialize back) → nwn_erf (repack) → .mod file
```

One module loaded at a time. `load_module` must be called before any other tool.

### Tool Organization

Tools are split between **base tools** (human-orchestrated editing) and **adventure tools** (autonomous module building):

- **Base tools** (`src/tools/*.ts` except `adventure-tools.ts`) — 22 files covering reading, querying, editing, placement, and analysis. Used by both humans and the adventure creator.
- **Adventure tools** (`src/tools/adventure-tools.ts`) — Tools specific to the `/create-adventure` pipeline: `create_adventure_transition`, `find_walkable_position`, `generate_area_layout`.

All tools have **MCP annotations** (`readOnlyHint`, `destructiveHint`, `idempotentHint`) set via the 4th positional arg to `server.tool()`.

### Layout Generator

`generate_area_layout` (in `src/util/layout-generator.ts`) is server-side procedural layout generation that encodes the area design rules from `adventure-areas/SKILL.md`. Styles: `dungeon` (BSP rooms + corridors), `cave` (organic chambers), `forest_clearing` (exterior clearings separated by trees), `village` (buildings along a road). Returns zones + crossers ready for `paint_terrain`, plus transition points.

Uses `computeValidPairs()` from `src/util/zone-solver.ts` to validate terrain adjacency chains.

#### Interior Dungeon Layout Rules

- **BSP rooms**: minimum 3x3, margin=2 (4-tile wall gaps between rooms). Split threshold 10.
- **Corridor routing**: axis-overlap detection (straight connection at shared Y/X), L-bend fallback when rooms don't overlap on either axis.
- **S-curves**: 50% chance on straight corridors ≥5 wall tiles. Offsets middle third by 1 tile perpendicular. Creates two bends.
- **T-junctions**: after sequential room connections, one shortcut corridor between the closest non-adjacent room pair. Creates 3-way/4-way intersections where corridors cross.
- **Corridor crossers stay on wall tiles only.** Never extend crosser paths into room floor tiles — this creates corridor arches inside rooms (wrong). Room boundary tiles are regular floor tiles resolved by the corner grid.
- **Crosser type**: use `corridor` (self-contained per tile). Never use `doorway` — doorway crossers require matched pairs on shared edges (arch geometry split between adjacent tiles).
- **Propagation guard**: crossers don't propagate onto tiles with any non-default corner (boundary or room tiles). Only pure-default tiles receive propagated crossers.
- **Solver fallback priority for uniform corners** (all-floor room tiles): drop crossers first (preserve floor), then try corner substitution. For mixed corners (wall-floor boundaries): try corner substitution to preserve crossers first, then drop.

### Resource Loading

On `load_module`, the server builds a full resman stack (lowest to highest priority):

1. **Base game BIFs** (via `NWN_FOLDER_DATA`)
2. **Module HAKs** (from `Mod_HakList` in IFO)
3. **User override/** (`NWN_FOLDER_USER/override/`)
4. **User development/** (`NWN_FOLDER_USER/development/`)
All 2DAs from the stack are extracted and parsed at load time (~598 base game tables). `load_module` accepts just a filename (e.g., `"mymod.mod"`) which resolves from `NWN_FOLDER_USER/modules/`.

## GFF Data Model

Every GFF field is type-wrapped: `{ type: "dword", value: 100 }`. Use helpers from `types/gff.ts`:
- `getFieldStr(obj, "Tag")` → unwraps cexostring/resref
- `getFieldNum(obj, "ChallengeRating")` → unwraps byte/char/word/dword/int/float/double
- `getFieldLocStr(obj, "FirstName")` → extracts text from cexolocstring (prefers lang 0/English)
- `getFieldLocStrResolved(obj, "FirstName", tlkLookup)` → resolves `[TLK:N]` strrefs via lookup function
- `getFieldList(obj, "Creature List")` → unwraps list to array of structs
- `setField(obj, "Tag", "cexostring", "my_tag")` → set or create a typed field
- `setFieldNum(obj, "Tile_ID", 42, "int")` / `setFieldStr(obj, "Tag", "my_tag")` → shorthands

`GffObj` type alias (`Record<string, unknown>`) used throughout. `GIT_STRUCT_ID` constants in `config.ts`: CREATURE=4, WAYPOINT=5, SOUND=6, ENCOUNTER=7, DOOR=8, PLACEABLE=9, STORE=11, TRIGGER=1.

## Object Placement

**Position fields differ by type:**
- Creatures/Waypoints/Triggers/Encounters/Sounds/Stores: `XPosition`, `YPosition`, `ZPosition`, `XOrientation`, `YOrientation`
- Placeables/Doors: `X`, `Y`, `Z`, `Bearing` (radians)

**Blueprint resolution chain:** module parsedGff cache → module resources on disk → resman (base game/HAKs, 120s timeout). Always deep-cloned before mutation.

## Walkmesh Caching

The `wok_cache/` directory is lazy-initialized on first use via `ensureWokCacheDir()` in `walkmesh.ts`. Reset on each `load_module` via `setWokCacheDir(tempDir)`. All walkmesh consumers (placement tools, paint tools) call `ensureWokCacheDir()` — never create the dir manually.

## Undo Stack

Simple undo stack for GIT mutations — `snapshotGitForUndo()` before each mutation, `popUndo()` to revert. Max 50 entries. MCP tools: `undo_last_change`, `undo_history` in `undo-tools.ts`. For bulk rollback of a failed phase, use `bulk_remove_objects` with tag patterns.

## Blueprint Discovery

`list_blueprints` tool searches the full resman stack (base game + HAKs + module) with 3-layer matching:
1. **Resref** — filename substring match
2. **Binary content** — finds tags and hardcoded locstring names in GFF data
3. **TLK names** — resolves strref-based names via `index.baseTlk`/`index.customTlk`

Returns type-specific summaries (utc: CR/race/classes, uti: baseItem/cost, etc.). Results cached in `blueprint_cache/`.

## Area Connectivity

`check_area_connectivity` tool does BFS from the module start area through linked doors/triggers. Returns reachable/unreachable areas and the full transition graph. Implemented in `analysis-tools.ts`, reuses `buildTagToAreaMap`/`buildAreaTransitions` from `tileset-tools.ts`.

## Area Transitions

Three mechanisms for moving between areas:
- **`link_doors`** — bidirectional door-to-door linking. Doors are two-way objects.
- **`create_area_transition`** — one-way trigger→waypoint transition. Places an Area Transition trigger (Type=1, LinkedToFlags=2=Waypoint) in the source area and a waypoint in the target area. Call twice with swapped source/target for two-way transitions.
- **`create_adventure_transition`** — one-way portal for adventure modules. Places a useable blue shaft of light (`plc_solblue`) with an OnUsed script that opens a dialog ("Step through?" / "Turn away"). On confirmation, plays VFX_FNF_SUMMON_MONSTER_2 and jumps the PC to the destination waypoint after 2 seconds. The `/create-adventure` pipeline uses this exclusively instead of `create_area_transition`.

## Trap Blueprints

`create_trap_blueprint` creates a UTT trigger blueprint with NWN trap fields: `TrapDetectDC`, `TrapDisarmable`, `TrapFlag`, `TrapOneShot`, and a default square geometry. Place with `place_trigger`.

## Quest Completability

`verify_quest_completability` traces all journal quests from quest-giver dialog through `AddJournalQuestEntry` script calls to the end entry. Checks area reachability. Returns structured gaps for each quest.

## Placement Collision Detection

`place_creature` and `place_placeable` check for nearby objects within 1m radius. Returns `collisionWarning` in the response JSON when objects would overlap. Informational only — does not block placement.

## Walkability Enforcement

All placement and movement tools **block** if the target position is non-walkable or within 1m of a non-walkable surface. Uses `checkPlacementWalkable()` in `walkmesh.ts` which checks the target point plus 4 cardinal probes at 1m distance.

**Enforced on:** `place_creature`, `place_placeable`, `place_waypoint`, `place_trigger`, `place_encounter`, `place_store`, `move_object`, `bulk_move_objects`, `create_area_transition`, `create_adventure_transition` (both source and target positions).

**Excluded:** `place_door` (doors sit at tile boundaries near walls), `place_sound` (audio sources don't need walkable positions), movement of Door List and SoundList objects.

## Walkmesh Caching

The `wok_cache/` directory is lazy-initialized on first use via `ensureWokCacheDir()` in `walkmesh.ts`. Reset on each `load_module` via `setWokCacheDir(tempDir)`. All walkmesh consumers (placement tools, paint tools) call `ensureWokCacheDir()` — never create the dir manually.

## Object Height Correction

`fix_object_heights` adjusts Z height of all placed objects in an area (or all areas) to match the walkmesh ground plane. Iterates creatures, placeables, waypoints, triggers, encounters, stores, and sounds. Only adjusts objects where the walkmesh Z differs from the current Z by more than 0.01. The walkmesh check uses the highest walkable face at each position (handles overlapping faces at different heights).

## Zone-Based Terrain Solver

`paint_terrain` takes terrain zones + crosser paths and re-solves ALL non-feature tiles via a corner grid approach (`src/util/zone-solver.ts`). Feature tiles (from `paint_feature`) are preserved automatically. `paint_tiles` is for exact tileId manual overrides only. Pass `autoRepack: "true"` to automatically save to the .mod file after painting (prevents lost work if context runs out).

`get_tileset_details` defaults to `detail: "summary"` (~2KB) which includes terrain types, crosser types, valid terrain adjacencies, and group names. Use `detail: "full"` for the complete 60-100KB tile catalog.

### Terrain Adjacency Constraint

**Zone layouts must respect tileset terrain adjacency chains.** Tilesets only have transition tiles between specific terrain pairs. If two terrains can't transition directly, a buffer zone of the intermediate terrain is REQUIRED — the solver will NOT fabricate intermediate terrains.

**Before designing zones**, call `get_tileset_details` and check which terrains have transition tiles between them. Common adjacency chains:
- `tno01` (Castle Exterior Rural): `Trees → Grass → CastleWall → Dirt`
- `ttr01` (Rural): `Trees → Grass` (+ Water, Dirt variants)

You cannot skip terrains in the chain. For example, in `tno01` you must place a 1-tile `Grass` zone between `Trees` and `CastleWall` — no direct Trees↔CastleWall transition tiles exist. The solver will warn and fall back to incorrect tiles if adjacencies are invalid.

## Known Pitfalls

- **`nwn_script_comp` positional arg.** Most nim tools use `-i <file>`, but `nwn_script_comp` takes the source file as a **positional argument** (last): `nwn_script_comp [options] [-o out] file.nss`. Using `-i` silently fails.
- **`nwn_twoda` no JSON.** Use `-k csv --write-id-column` instead. The CSV parser in `nim-tools.ts` handles it.
- **Numeric tool params must use `z.string()`.** The MCP SDK validates JSON Schema before Zod transforms execute, so `z.coerce.number()` fails when clients send strings. Use `z.string()` + `toF()`/`toI()` helpers from `src/util/params.ts`. Same for complex array params — use `z.string()` + `JSON.parse()`.
- **Resman tools are slow.** Every invocation initializes the full resman stack. Default timeout (30s) is too short for piped operations — `resmanCatToJson()` uses 120s.
- **Temp dir contains cache subdirs.** `resman_2da/`, `tileset_cache/`, `wok_cache/`, `blueprint_cache/` — all auto-excluded from `erfPack()` by the `isFile()` filter. Never pack these into the module.
- **`validate_module` false positives.** Base game scripts (`nw_c2_default5`, etc.) and items (`nw_wblms001`) are resolved at runtime — filter these "missing" references.
- **Primary/secondary rules in .set files are NOT used.** The tile solver works entirely by matching corner terrains and edge crossers on tile entries. Ignore `[PRIMARY RULES]` and `[SECONDARY RULES]` sections.
- **Height tiles excluded from solving.** Tiles with any corner height > 0 are filtered out. All solver-placed tiles are flat.
- **Tile rotation: do NOT swap cases 1 and 3.** Case 1 = 90° CW, case 3 = 270° CW. Verified against `forwardRotate` + SVG normalization pipeline.
- **DLG field completeness is critical.** The NWN engine silently fails to load dialogs missing standard fields. Every entry/reply MUST include `Animation`, `AnimLoop`, `Comment`, `Delay`, `Quest`, `Script`, `Sound`. Every link struct MUST include `IsChild`. The `makeEntry`/`makeReply`/`makeLink` helpers in `dialog-write-tools.ts` handle this.
- **`create_dialog` condition field.** The `condition` on a node goes on the **link pointing to it** (`Active` field), not the node itself.
- **Tileset door placement.** Each tile's .set file has `[TILE<id>DOOR<n>]` subsections with local-space offsets. Use `getTileDoorWorldPositions()` in `tileset.ts` to convert to world space. Never guess door positions.
- **CPDB blob format.** Campaign database blobs (compressed=1) use a 24-byte header (`"CPDB"` + version + fields) followed by zstd-compressed data (NOT zlib). The payload is JSON text, not binary GFF. Vartype codes are ASCII chars: F=70 float, I=73 int, J=74 json, L=76 location, O=79 object, S=83 string, V=86 vector. F/I/L/V are uncompressed ASCII; J/O/S are CPDB/zstd compressed.
- **Database files are `.sqlite3`**, not `.sqlite`. Located in `NWN_FOLDER_USER/database/`.
- **GIT trigger field name is `TriggerList`** (no space), not `"Trigger List"`. Other no-space list names: `SoundList`, `StoreList`, `WaypointList`. With-space names: `Creature List`, `Door List`, `Encounter List`, `Placeable List`.
- **Triggers need Geometry in placed instances.** UTT blueprints from resman do NOT contain geometry. When placing triggers, always ensure the `Geometry` list field exists with at least 4 vertices (PointX/PointY/PointZ). Without geometry, the engine won't detect entry and the toolset won't render the trigger.
- **GIC must be synced with GIT.** The toolset uses the GIC file to index objects in an area. `writeBackGit()` automatically syncs the GIC. Without GIC entries, objects exist in the GIT but the toolset doesn't show them.
- **Placeable display name field is `LocName`**, not `LocalizedName`. Setting `LocalizedName` on a placeable has no effect — the toolset and engine read `LocName` (a cexolocstring).
- **Placement Z height from walkmesh.** All placement tools automatically set the object's Z position from the walkmesh surface height. The walkmesh check returns the highest walkable face Z at the position. Use `fix_object_heights` to retroactively fix objects placed before this feature.
- **Zone solver rejects incompatible adjacencies.** `paint_terrain` returns early with zero placements and `INCOMPATIBLE TERRAIN ADJACENCY` errors if the zone layout contains terrain pairs with no transition tiles. Fix the zone layout, don't retry.
- **`fallbackSubstitute` is constrained.** The zone solver's fallback only tries terrains present in the corner grid (zone-defined + default). It will never inject an alien terrain.
