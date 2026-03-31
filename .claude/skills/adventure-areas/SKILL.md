---
name: adventure-areas
description: Sub-skill of /create-adventure. Reads the plot document from adventure.md and builds all required areas — tileset selection, terrain painting, atmosphere, and transitions. Fully autonomous, no user interaction.
allowed-tools: Bash(echo *), Read, Grep, Glob
---

# Areas

Sub-skill of `/create-adventure`. Reads the plot section of `adventure.md`, builds all areas required by the plot, and appends an areas summary back to `adventure.md`.

## Prerequisites

- `adventure.md` must exist in the MCP temp directory (`$MCP_FOLDER_TEMP`, defaults to `$TEMP/nwn-mcp` or `/tmp/nwn-mcp`) and contain a completed `## Plot` section. All sub-skills read from and append to this shared file.
- A module must be loaded. If none is loaded, call `load_module` using the module name from `adventure.md`.

## Workflow

Fully autonomous. Make all decisions based on the plot document — do NOT ask the user for input.

---

### Phase 0: Clean Up Starter Area

If the module was created by `create_module`, it contains a temporary `_start` area (MicroSet 3x3). Before building real areas:
1. Call `remove_object` to remove `_start` from the GIT if needed
2. The first real area you create will become the new entry area — after creating it, update the IFO entry point: use `modify_gff_field` to set `Mod_Entry_Area` to the new area's resref, and set `Mod_Entry_X`/`Mod_Entry_Y` to a walkable position in that area
3. Remove `_start` from `Mod_Area_list` in the IFO, and delete `_start.are`, `_start.git`, `_start.gic` from the temp dir

---

### Pre-Check: Validate adventure.md

Read `adventure.md` from the MCP temp directory. Verify these sections exist and are non-empty:
- `## Module`
- `## Plot`

If any required section is missing or contains no content below its heading:
**STOP.** Output: `"ERROR: adventure.md is missing required section [name]. The prerequisite skill has not run or failed. Cannot proceed."`

---

### Phase 1: Read the Plot

Read `adventure.md`. Extract from the `## Plot` section:
- **Locations** — all areas that need to be built (name, type, description)
- **Setting** — interior or exterior? What biome/environment per location?
- **Mood** — dark, peaceful, eerie, bustling, etc.
- **Scale** — how large should each area be?
- **Connections** — which areas connect to which (for door/transition planning)

Build a mental list of all areas to create. Process them one at a time.

---

### Phase 2: Tileset Selection (per area)

Call `list_tilesets` once to see all available tilesets.

**Match terrain keywords from the plot to tileset terrain types — this is the most important criterion.** Scan ALL tilesets:
- "lava" → Dungeon (`tde01`, has Lava terrain) — NOT Crypt
- "water", "river", "lake" → look for Water terrain
- "chasm", "cliff" → look for Chasm or Cliff terrain
- "forest", "trees" → look for Trees or Forest terrain
- "pit", "bottomless" → look for Pit terrain

**Tileset Reference:**

The table below covers base game tilesets. Other tilesets may exist as custom content (HAKs) — use normal pattern matching against terrain types, crosser types, and group names for those. This list is hints, not exhaustive.

| Resref | Name | Int/Ext | Notes |
|--------|------|---------|-------|
| `tbw01` | Barrows Interior | Int | Burial mounds, barrow tunnels |
| `tib01` | Beholder Caves | Int | Organic alien caverns |
| `tno01` | Castle Exterior, Rural | Ext | Fortified keeps, castle walls in countryside |
| `tic01` | Castle Interior | Int | Throne rooms, storage, library, jail cells |
| `tni02` | Castle Interior 2 | Int | Extended castle rooms with round tower option |
| `tcn01` | City Exterior | Ext | Urban streets, docks, castle districts |
| `tin01` | City Interior | Int | Houses, shops, inns, kitchens |
| `tni01` | City Interior 2 | Int | Extended house/shop/inn layouts |
| `tdc01` | Crypt | Int | Tombs, undead lairs, pits |
| `ttd01` | Desert | Ext | Arid cliffs, sand, chasms |
| `dag01` | Lizardfolk Interior | Int | Tribal huts, primitive dwellings |
| `tde01` | Dungeon | Int | Classic dungeon with lava |
| `tts02` | Early Winter 2 | Ext | Snowy terrain with camp clearings |
| `ttf01` | Forest | Ext | Woodland paths, cliffs, streams |
| `ttf02` | Forest - Facelift | Ext | Updated forest visuals, same layout options |
| `twc03` | Fort Interior | Int | Military interior with water features |
| `tti01` | Frozen Wastes | Ext | Icy exterior with evil castle structures |
| `tii01` | Illithid Interior | Int | Mind flayer tunnels |
| `tcm02` | Medieval City 2 | Ext | Expanded city with trees, grass, castle, water |
| `trm02` | Medieval Rural 2 | Ext | Expanded rural with sand, mountains, streams |
| `tms01` | MicroSet | Ext | Test area only, do not use |
| `tdm01` | Mines and Caverns | Int | Mine shafts, tracks, underground water |
| `tdr01` | Ruins | Int | Crumbling interior/exterior plaza mix |
| `ttr01` | Rural | Ext | Farmland, streams, roads, walls |
| `tts01` | Rural Winter | Ext | Snowy countryside, roads, walls |
| `trs02` | Rural Winter - Facelift | Ext | Updated rural visuals with mountains |
| `tdt01` | Sea Caves | Int | Coastal caverns with water; seaside biome only |
| `tss13` | Sea Ships | Ext | Ship decks, docks, port districts |
| `tds01` | Sewers | Int | Underground drainage, pits |
| `tsw01` | Steamworks | Int | Mechanical/industrial dungeon |
| `ttz01` | Tropical | Ext | Jungle, beaches, sand, water |
| `ttu01` | Underdark | Ext | Vast underground with faction sectors |
| `tid01` | Drow Interior | Int | Dark elf architecture |

Pick the best match based on:
1. **Terrain type match** (highest priority)
2. Interior vs exterior
3. Crosser types (roads, streams, walls)
4. Group features (temples, lodges, bridges)

---

### Phase 3: Dimensions + Layout Plan

Propose area dimensions based on the plot's description of the location's scale:
- Small focused area: 8x8 to 10x10
- Medium area: 12x12 to 14x14
- Large exploration area: 16x16 to 18x18

Plan the terrain layout: which zones go where, what crossers are needed, what multi-tile features to place. **Read the "CRITICAL — Area Layout Design" section below BEFORE designing any zones.** The #1 mistake is creating one big open space — areas MUST have multiple distinct zones/rooms connected by paths or corridors.

Only call `get_tileset_details` if you need specific group names for `paint_feature`. `list_tilesets` is sufficient for terrain/crosser planning.

---

### Phase 4: Build the Area

Execute in this order:

1. **Create the area** — `create_area` with tileset, dimensions, and a resref derived from the area name (lowercase, no spaces, e.g., `darkforest`, `temple_ruins`).

2. **Paint features first** — `paint_feature` for any multi-tile groups (temples, lodges, bridges). These are preserved by the terrain solver.

3. **Paint terrain + crossers** — A single `paint_terrain` call with ALL terrain zones and crosser paths. The zone-based solver derives all tile assignments including transitions. Feature tiles are never overwritten.

   **CRITICAL — Perimeter encapsulation (applies to BOTH interior and exterior areas):**

   The outermost ring of tiles (row 0, last row, column 0, last column) must NEVER contain playable/walkable terrain. No terrain zones should extend to the perimeter. This is not optional.

   - **Interior areas:** The entire perimeter ring must remain the default Wall terrain. Do NOT place floor, room, shop, or any non-wall zone on any tile that touches the area boundary. If a room zone would extend to the edge, shrink it inward by at least 1 tile.
   - **Exterior areas:** The entire perimeter ring must be covered by impassable terrain — Trees, Cliffs, Rocky, Mountains, or the tileset's equivalent border terrain. Do NOT place Grass, Dirt, Sand, Road, or any walkable terrain on perimeter tiles. Do NOT extend crosser paths into the perimeter — the solver automatically trims crossers from border tiles. Crossers should start/end at the first/last walkable tile inside the perimeter (row 1, row height-2, col 1, col width-2).

   When building your terrain zones for `paint_terrain`, explicitly ensure every zone rectangle starts at row/column 1 (not 0) and ends at max-1 (not max). Leave the perimeter untouched as default terrain for interior, or explicitly assign border terrain for exterior.

   **CRITICAL — Terrain adjacency chains:**

   Tilesets only have transition tiles between specific terrain pairs. You CANNOT place two terrains next to each other if the tileset has no transition tiles between them — the solver will produce broken results. **Before designing zones, check adjacency compatibility.** Common chains:
   - `tno01` (Castle Exterior Rural): `Trees → Grass → CastleWall → Dirt` — you MUST place a Grass buffer zone between Trees and CastleWall.
   - `ttr01` (Rural): `Trees → Grass` (+ Water, Dirt variants)
   - For unfamiliar tilesets, call `get_tileset_details` and examine which terrain pairs share transition tiles.

   If your layout requires Trees next to CastleWall (e.g., a walled compound in a forest), add a 1-tile Grass zone between them. This is not optional — it is a tileset constraint.

If the solver warns about missing tile combinations:
- Simplify terrain (avoid 3+ terrain types meeting at one point)
- Check available tile combos with `get_tileset_details`
- Use `paint_tiles` with exact tileId for manual overrides on problem spots

---

### Phase 5: Atmosphere

Set ambient properties with `set_area_properties`. The reference tables below are common hints, not exhaustive — look up 2DA tables (`ambientmusic`, `ambientsound`) for more options if needed.

**Common music IDs:**
| ID | Use for |
|----|---------|
| 1 | Exterior day — countryside, village |
| 3 | Exterior night — countryside |
| 7 | Interior — dungeon, ruins, crypts |
| 8 | Interior — dungeon alternate |
| 10 | Generic battle |
| 13 | Dark interior — evil, horror |
| 16 | Town/city exterior |
| 34 | Rural battle |

**Common ambient sound IDs:**
| ID | Use for |
|----|---------|
| 30 | Soft wind — calm exterior |
| 31 | Medium wind |
| 33 | Forest wind — woodland |
| 60 | Cave drips — dungeon, crypts |
| 61 | Cave ambient alternate |
| 62 | Cave ambient alternate 2 |

**Other settings:**
- **Skybox** — exteriors: `skyBox: 1`. Interiors: `skyBox: 0`.
- **Day/night cycle** — exteriors: `true`. Interiors: `false`.
- **Fog** — Do NOT set `sunFogAmount` or `moonFogAmount` (leave at 0). Instead use `fogClipDist` to control fog density: 45 = very foggy, 80 = clear sky. Omit `fogClipDist` for no fog.
- **Wind** — `windPower`: 0=calm, 1=light, 2=strong.
- **Weather** — `chanceRain/Snow/Lightning` 0-100. Low values (5-15) for occasional weather.

---

### Phase 5b: Place Aesthetic Doors

After painting, scan the tile grid for tiles that have `doorPlacements` defined in the tileset (via `get_tileset_details`). These are visual archways built into the tile geometry — placing a door object completes the look. Place **all** door types: terrain-based, feature, and crosser-based.

Each door placement in the tileset data has two key fields:
- **`type`** — placement category: `0` = terrain/feature door (room entrances, gates), `1+` = crosser door (corridor/doorway passages)
- **`doorType`** — appearance ID (e.g., `6013`). Look this up as a row in `doortypes.2da` to get the correct door blueprint resref. Use that blueprint with `place_door`.

**Step 1: Compute the world position** for each door placement:
- World X = `col * 10 + 5 + forwardRotate(doorX, doorY, tileOrientation)[0]`
- World Y = `row * 10 + 5 + forwardRotate(doorX, doorY, tileOrientation)[1]`
- Bearing = `(doorOrientation + tileOrientation * 90) % 360`

Where `forwardRotate` for orientation 0-3: case 0=(x,y), case 1=(-y,x), case 2=(-x,-y), case 3=(y,-x).

**Step 2: Place and lock based on placement `type`:**
- **`type: 0` (terrain/feature doors):** Lock via `modify_gff_field` — set `Locked` (byte) to `1`, `Lockable` (byte) to `1`, and `Plot` (byte) to `1`. These are aesthetic and stay locked unless a quest or area transition explicitly unlocks them.
- **`type: 1+` (crosser/corridor doors):** These are passageways — do NOT lock them. Leave them unlocked so the player can pass through freely.

---

### Phase 6: Connectivity Validation

Check `paint_terrain` results for corridor tiles with `walkablePercent` below 25%. Fix with `paint_tiles` using a different tileId with the same crosser pattern but higher walkability.

Only call `visualize_area` if `paint_terrain` returned crosser mismatch warnings or if isolated zones seem likely. If called, check `zones` array — every room must be reachable from every other room. Fix isolated zones by adding corridor crossers through wall tiles and repainting.

---

### Phase 7: Link Area Transitions

Use `create_adventure_transition` for ALL area transitions — do NOT use doors, `link_doors`, or `create_area_transition`. The adventure pipeline uses the light-based transition tool exclusively.

`create_adventure_transition` creates a one-way area transition using a useable blue shaft of light ("Area Transition"). The player clicks the light, a dialog asks if they want to step through, and on confirmation a VFX plays and the PC teleports to the destination waypoint. For two-way connections, call `create_adventure_transition` **twice** with swapped source/target. No separate visual marker (`plc_solblue`) is needed — the portal IS the blue light.

**CRITICAL: Tag length limit.** The transition script resref is `a_at_<tag>`, and NWN resrefs are max 16 characters. That means the `tag` parameter can be at most **11 characters** (`16 - 5` for the `a_at_` prefix). Use short abbreviated tags like `vil_inn`, `inn_vil`, `vil_cry`, `cry_vil` — NOT `village_to_inn` (which truncates and collides with `village_to_crypt`). Every transition pair must have a **unique** tag that fits in 11 chars.

```
# Village → Cave
create_adventure_transition(
  sourceArea: "village", sourceX: "85.0", sourceY: "45.0",
  targetArea: "cave", targetX: "15.0", targetY: "15.0",
  tag: "vil_cave"
)

# Cave → Village (return path)
create_adventure_transition(
  sourceArea: "cave", sourceX: "12.0", sourceY: "15.0",
  targetArea: "village", targetX: "82.0", targetY: "45.0",
  tag: "cave_vil"
)
```

The tool places a useable blue shaft of light ("Area Transition") with an OnUsed script that plays a teleport VFX and jumps the PC to the destination. No separate visual marker needed — the light IS the visual marker.

Place the target waypoint at the same position as the destination portal. Since portals require clicking (not walk-through), there's no risk of re-triggering.

**Transition placement rules:**
- **On crosser paths (roads/streams):** Place the light on the **last crosser tile before the border** — the tile where the crosser ends. Center on that tile (tile_col * 10 + 5, tile_row * 10 + 5).
- **Without crossers:** Place the light on the walkable tile closest to the cliff/wall edge. Typically at row 1 or row (height-2), col 1 or col (width-2).
- **At buildings/structures:** Place the light directly in front of feature doors.
- **Never place on border/transition tiles** (tiles where cliff/wall meets walkable terrain). Stay at least 1 tile inside the walkable area.

---

### Phase 8: Update adventure.md

Append an `## Areas` section to `adventure.md` with:
- Each area: resref, name, tileset, dimensions
- Terrain summary (what zones were placed)
- Features placed
- Area transition links (which trigger tags connect which areas)

This data is used by downstream skills (`/adventure-environment`, `/adventure-actors`, `/adventure-quests`, `/adventure-challenges`, `/adventure-affordances`) to place content correctly.

Repack the module with `repack_module`.

---

## CRITICAL — Area Layout Design (applies to ALL tilesets)

**NEVER design an area as one big open space.** This is the single most important layout rule. Areas must have spatial structure — distinct zones connected by paths/passages. A large flat rectangle of the same terrain is boring to explore and looks artificial.

**The rule: 30-50% of tiles should be "rooms" or clearings. The rest should be walls, trees, or other impassable terrain that creates corridors, paths, and chokepoints between the open spaces.**

### Exterior areas:
- **Edge encapsulation** — place Trees, Cliffs, Rocky, or other impassable terrain along all four edges. Areas shouldn't end with open ground at the border.
- **Break up open space with terrain.** Don't carve one big clearing in the middle. Instead create multiple clearings (Grass, Dirt) separated by trees or rocks, connected by road/path crossers. Think of it as outdoor "rooms" — a village green, a market area, a garden, a courtyard — each separated by tree lines or terrain features.
- **Use roads/streams as corridors.** Crosser paths (Road, Stream) through tree or rocky terrain create natural passages. These serve the same purpose as interior corridors.
- **Example good layout (12x12 exterior):** Perimeter trees → 3 Grass clearings (3x3 each) separated by 2-tile tree strips → Road crosser connecting them north-south.
- **Example bad layout:** Perimeter trees → one big 8x8 Grass rectangle in the middle. This is what the agent defaults to and it MUST be avoided.

### Interior areas:
- **Perimeter must be Wall.** Never place floor/room/shop zones on the outermost row or column of tiles.
- **Use Corridor/Doorway crossers for passages between rooms.** These create the visual doorways.
- **Walls create structure.** Default Wall terrain is solid. Floor zones carve rooms. Corridor crossers cut passages.
- **Design 2-4 distinct rooms** connected by corridor crossers. NOT one big open floor.
- **Zig-zag corridors ~50% of the time.** Creates better exploration flow.
- **2-tile room separation.** Leave at least 2 Wall tiles between rooms to prevent the corner grid from merging them.
- **Terrain names must match the tile catalog key.** Use short lowercase names (e.g., `"floor"` not `"floor (interior)"`). Use `defaultTerrain` from `list_tilesets` as reference.
- **Corridor crossers go on Wall tiles.** Bridge crossers go on Pit tiles. Road/Stream on Grass.
- **Void terrain must be visible.** Add a doorway crosser at wall/chasm boundaries so players can see into pits.

## Crosser Behavior at Terrain Boundaries

The solver prioritizes preserving crossers over exact corner matching. At a Pit/Floor boundary with Bridge crossers, it substitutes corners to find a bridge tile. Only specify crossers on tiles that naturally support them — the solver handles boundary transitions.

## Important Notes

- **Tile coordinates:** Column = x (left to right), Row = y (bottom to top). World position = tile * 10.0.
- **Feature placement:** `paint_feature` x,y is the bottom-left corner of the feature group.
- **Zone-based solver:** `paint_terrain` re-solves ALL non-feature tiles each call. Pass ALL zones each time.
- **Manual overrides:** Use `paint_tiles` with exact tileId for tiles the zone solver can't handle.
- **Do NOT auto-export HTML reports.**
