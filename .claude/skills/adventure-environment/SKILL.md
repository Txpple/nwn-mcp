---
name: adventure-environment
description: Sub-skill of /create-adventure. Reads the plot and areas from adventure.md and dresses each area with theme-aware placeables, ambient sounds, and waypoints. Fully autonomous, no user interaction.
allowed-tools: Bash(echo *), Read, Grep, Glob
---

# Environment

Sub-skill of `/create-adventure`. Reads the plot and areas sections of `adventure.md`, then dresses each area with placeables (furniture, lights, containers, decor), ambient sound objects, and waypoints with map notes. Focus is ambience — picks should be thematic to the plot but not plot pivot points. Downstream skills (`/adventure-actors`, `/adventure-quests`, `/adventure-challenges`, `/adventure-affordances`) will select from the placed environment for their purposes.

## Prerequisites

- `adventure.md` must exist in the MCP temp directory (`$MCP_FOLDER_TEMP`, defaults to `$TEMP/nwn-mcp` or `/tmp/nwn-mcp`) and contain completed `## Plot` and `## Areas` sections.
- A module must be loaded. If none is loaded, call `load_module` using the module name from `adventure.md`.

## Workflow

Fully autonomous. Make all decisions based on the plot document and spatial data — do NOT ask the user for input.

---

### Pre-Check: Validate adventure.md

Read `adventure.md` from the MCP temp directory. Verify these sections exist and are non-empty:
- `## Module`
- `## Plot`
- `## Areas`

If any required section is missing or contains no content below its heading:
**STOP.** Output: `"ERROR: adventure.md is missing required section [name]. The prerequisite skill has not run or failed. Cannot proceed."`

---

### Phase 1: Read the Plot and Areas

Read `adventure.md`. Extract from the `## Plot` section:
- **Locations** — name, type (interior/exterior), environment keywords, mood, description
- **Setting** — biome, time of day, atmosphere
- **Key NPCs** — where they are located (for ambient dressing around their areas)

Extract from the `## Areas` section:
- **Resrefs** — area identifiers for `visualize_area` calls
- **Dimensions** — width x height in tiles
- **Terrain summary** — what zones were placed (forest, water, floor, wall, etc.)
- **Features** — any multi-tile groups placed (temples, lodges, bridges, ruins)
- **Doors** — positions and tags for area transitions

Build a list of all areas to process. Handle them one at a time.

---

### Phase 2: Spatial Analysis (per area)

Call `visualize_area` to get the spatial payload. Extract:

- **Tile grid** — each tile's `dominantMaterial`, `walkablePercent`, `groupName`, `hasWater`, and position
- **Features** — the `features` array lists multi-tile groups with names (e.g., `"Lodge_2x2"`, `"Temple_3x2"`, `"Ruins_1x2"`). These inform what to place and where.
- **Zones** — walkable connectivity regions
- **Existing objects** — doors, placeables already present. Avoid placing on top of them.

**Use tile group names as placement guidance:**
- `"Lodge"` / `"Cabin"` / `"House"` → furniture, fireplace, beds
- `"Temple"` / `"Shrine"` → altar, candles, pews, rugs
- `"Ruins"` → rubble, broken pillars, bones, weeds
- `"Tower"` / `"Fort"` / `"Keep"` → weapon racks, flags, torches
- `"Bridge"` → no placeables (walkway only)

**Use tile materials as environment cues:**
- `Wood` → interior floor, suitable for furniture
- `Stone` → dungeon or castle, torches and bones
- `Dirt` / `Grass` → exterior, nature placeables
- `Water` → skip (not walkable)

**Identify placement zones:**
- Walkable tiles (`walkablePercent` > 50%) away from doors
- Feature tile interiors (the tiles covered by a group)
- Open clearings in exterior areas

---

### Phase 3: Place Placeables

**Idempotency check:** Before placing placeables in an area, call `get_area_placeables(area: "...")`. If placeables with matching tags are already present, **skip** those — do not place duplicates. This prevents double-placement if the skill is retried.

Target **20-40 placeables per area** depending on area size:
- ~8x8 areas → ~20 placeables
- ~12x12 areas → ~30 placeables
- ~18x18 areas → ~40 placeables

Scale linearly for sizes in between. Interiors tend toward the higher end (more furnished); exteriors toward the lower end.

**Placement rules:**

1. **Position** — tile center = `col * 10 + 5, row * 10 + 5`. Add small random offsets (1-3 meters) for natural variation. Vary bearing for visual interest.
2. **Avoid** door tiles, transition tiles, tiles with `walkablePercent` < 25%, and positions within 2m of existing objects.
3. **Group logically** — place related objects together:
   - Campfire + tent + log in a forest clearing
   - Table + 2-4 chairs + mugs in a tavern
   - Altar + candles + rug in a temple
   - Coffin + candles + bones in a crypt
   - Anvil + forge + weapon rack in a smithy
4. **Place thematically near landmarks** — a ruin feature gets rubble/broken pillars nearby; a well gets buckets/rope; a lodge gets outdoor furniture or woodpile.
5. **Mark ~40% of placeables as Useable with flavor text.** `place_placeable` strips `Useable` by default, so all placeables start as non-interactive decor. For roughly 40% of placed objects — bookshelves, altars, lecterns, tomes, signposts, barrels, crates, chests, beds, and anything a player might want to click on — use `modify_gff_field` to set `Useable` (byte) to `1` and set `Description` (cexolocstring) to a short, atmospheric sentence that ties to the adventure's plot. Examples: a barrel in a haunted inn → `{"0": "A dusty ale barrel. The tap is crusted with something dark — not rust."}`, a bookshelf in a crypt → `{"0": "Rotting volumes of forgotten funeral rites. One spine reads 'Wards Against the Restless Dead'."}`. This makes the world feel hand-crafted and rewards player exploration. Only mark freestanding, ground-level objects the player can walk up to and interact with — bookshelves, tables, chests, barrels, altars, signposts, beds, lecterns. Do NOT set `HasInventory` — that is handled by downstream skills (`/adventure-affordances`, `/adventure-rewards`) when they decide which containers get loot.
6. **No wall-mounted or architecture-anchored placeables.** Our spatial data shows tile terrain and walkability but not wall positions within tiles. Wall torches, sconces, mounted heads, banners, lanterns, and any placeable designed to attach to a wall or ceiling will float in midair if placed without a wall behind them. **Only place freestanding, ground-level objects.** Use braziers, candelabras, and freestanding torches (`plc_freetorch`, `x3_plc_torch001`) for lighting instead of wall-mounted variants.
7. **Placeables do NOT block walkmesh.** The NWN engine combines PWK no-walk zones with tile walkmesh at runtime. The skill does not need to worry about walkability blocking from placed placeables.

Use the reference tables below to select placeables. Do NOT look up 2DA tables or call `resman_search` for every placeable — use the curated resrefs directly. Only use `resman_search` or `find_by_resref_pattern` if you need something specific not in the tables.

---

### Phase 4: Place Sounds

Two categories of sound objects:

#### A. Placeable-Attached Sounds

Place a sound object near placeables that logically produce sound. Position the sound at or very near the placeable.

**Radius rules — proportional to placeable size:**
| Placeable type | Sound blueprint | Radius |
|----------------|-----------------|--------|
| Candle | torchfiresmall | 3-5m |
| Torch/brazier | torchfiremedium | 5-8m |
| Fireplace/firepit | fireplace or campfire | 8-12m |
| Forge/furnace | smithyfurnace | 12-15m |
| Waterfall/fountain | waterfallsmal or streammedium | 8-12m |
| Well/water pump | waterdrippingloo | 5-8m |

**Critical: sound radii must NOT overlap.** If two fire sources are within combined radius distance, only attach a sound to one of them (pick the larger/more prominent one). Space sounds apart or reduce radius.

Do NOT place a sound on every torch or candle — pick 2-4 key fire sources per area to give sound to.

#### B. Area-Wide Ambient Sounds

Place **0-3 area-wide sounds** per area for broad atmosphere. These are not tied to specific objects.

**Position:** area center = `(width * 10 / 2, height * 10 / 2)`.
**Radius:** covers the entire area = `max(width, height) * 10`.

| Area theme | Sound blueprints (pick 1-3) |
|-----------|---------------------------|
| Forest (night) | cricketsloop, owlhoots, wolfhowls |
| Forest (day) | songbirdchirps, windgustforest |
| Cave/dungeon | cavedrips, cavebats, windcaveloop |
| Crypt/undead | cryptmoans, ghosts |
| Tavern/inn | taverngroup, rowdytavern |
| Village/town | animalcriesday, merchantcalls |
| Swamp | mosquitoloop, frog, toad |
| Coast/water | seasurflarge, seasurfsmall, seagullcries |
| Storm/rain | rainheavy, thunderclapsfar |
| Underground | streamcavesmall, windgustcave |

---

### Phase 5: Place Waypoints

Place **2-5 waypoints** per area with map notes.

#### A. Entrance Waypoints

Place a waypoint near each door/transition tile. **Facing must point AWAY from the wall/door, toward the area interior**, so a player arriving through the door looks into the space they're entering.

**Bearing calculation:** determine which edge of the area the door is on, then face inward:
- Door on north edge → bearing = 180 (face south, into area)
- Door on south edge → bearing = 0 (face north, into area)
- Door on east edge → bearing = 270 (face west, into area)
- Door on west edge → bearing = 90 (face east, into area)

For doors not on edges, face away from the nearest wall or toward the largest open space.

Map note text: the connected area name (e.g., "To The Forest", "To Inn Basement").

#### B. Landmark Waypoints

Place waypoints at notable features and placeable clusters.

**Derive labels from tile group names** — strip the dimension suffix:
- `"Lodge_2x2"` → "Lodge"
- `"Temple_3x2"` → "Temple"
- `"Ruins_1x2"` → "Ruins"
- `"Tower_2x2"` → "Tower"

For non-feature landmarks, use descriptive names: "Campfire", "Well", "Altar", "Forge".

Facing should point toward the landmark from the player's likely approach direction.

---

### Phase 6: Update adventure.md

Append an `## Environment` section to `adventure.md` with this structure per area:

```markdown
## Environment

### [Area Name] (`resref`)

**Placeables (N placed):**
- [blueprint] at (x, y) — [brief description, e.g., "table with chairs"]
- [blueprint] at (x, y) — [description]
...

**Sounds (N placed):**
- [blueprint] at (x, y), radius Nm — [description, e.g., "fireplace crackle"]
- [blueprint] area-wide — [description, e.g., "cricket ambience"]
...

**Waypoints (N placed):**
- "[label]" at (x, y) — [map note text]
...
```

This data is used by downstream skills to select from existing environment objects for quest purposes.

Repack the module with `repack_module`.

---

## Placeable Reference Tables

Use these resrefs directly. Organized by environment theme. Mix and match across themes where appropriate.

> **These resref lists are quick-reference examples, not exhaustive catalogs.**
> If no suitable blueprint is found in these lists, call `list_blueprints(type: "utp", pattern: "[search term]")` to search the full base game and HAK stack by resref, tag, and display name (including TLK-resolved names). Always prefer a thematic match from the full catalog over forcing a poor fit from the examples.

### Tavern / Inn
| Category | Resrefs |
|----------|---------|
| Tables | plc_table, x0_smalldesk, tm_pl_tablelong, tm_pl_tablepoor, tm_pl_tablefancy |
| Chairs | plc_chair, x0_chair2, plc_stool, tm_pl_stool01, tm_pl_bench1 |
| Beds | plc_bed, x0_beddouble, x0_largebed, plc_cot |
| Fire | tm_pl_fireplace1, tm_pl_fireplace2, plc_candelabra |
| Barrels/Kegs | plc_barrel, plc_keg, x0_barrel |
| Rugs | x0_rugoriental, x0_ruglarge, plc_throwrug |
| Shelves | plc_bookshelf, plc_cabinet, plc_armoire |
| Misc | plc_bench, x0_cookpot, plc_woodoven |

### Forest / Exterior
| Category | Resrefs |
|----------|---------|
| Rocks | plc_boulder, x0_boulder, nw_plc_rock1, nw_plc_rock2, nw_plc_rock3 |
| Bushes | plc_shrub, tm_pl_bush11a, tm_pl_bushgrs01, x3_plc_bush001 |
| Mushrooms | nw_plc_mushroom1, nw_plc_mushroom2, nw_plc_mushroom3, nw_plc_mushroom4 |
| Camp | plc_campfrwbench, x3_plc_torch001, nw_plc_ropecoil1 |
| Logs/Wood | plc_sawhorse, plc_emptywagon, plc_fullwagon |
| Grass | plc_grasstuft, tm_pl_graspatch1, x3_plc_grass001 |
| Signs | plc_signpost, plc_signpost2, plc_signpost3 |
| Water | plc_well, plc_watertrough |

### Dungeon / Crypt
| Category | Resrefs |
|----------|---------|
| Bones/Bodies | plc_bones, plc_bloodstain, plc_corpse1, plc_corpse2, nw_pl_skeleton |
| Coffins | plc_sarco1, plc_sarco2, plc_sarco3 |
| Torches | plc_freetorch |
| Chains/Cages | plc_stocks, plc_torture1, plc_torture2 |
| Pillars | plc_pillar1, plc_pillar2, plc_pillar3 |
| Altars | plc_altrevil, plc_altrneutral |
| Cobwebs | x3_plc_sweed001, x3_plc_sweed002 |
| Misc | plc_brazier, plc_hangmnpost, plc_impledcrpse1 |

### Village / Town
| Category | Resrefs |
|----------|---------|
| Market | tm_pl_stallmark1, tm_pl_stallmark2, tm_pl_stallmark3 |
| Carts | plc_emptywagon, plc_fullwagon, plc_wagonwheel |
| Wells | plc_well, tm_pl_wellcover1 |
| Signs | plc_signpost, plc_signpost2, dd_pl_signblk |
| Crates | plc_box1, plc_box2, x2_easy_crate1, x2_easy_crate2 |
| Barrels | plc_barrel, x0_barrel, x3_plc_barrel1 |
| Flags | plc_flag1, plc_flag2, plc_flag3 |
| Misc | plc_sundial, plc_archtarget, plc_anvil |

### Cave / Underground
| Category | Resrefs |
|----------|---------|
| Rocks | nw_plc_rock1, nw_plc_rock2, nw_plc_rock3, plc_boulder |
| Mushrooms | nw_plc_mushroom1, nw_plc_mushroom2, x3_plc_mshroom1, x3_plc_mshroom2 |
| Puddles | nw_plc_puddle1, nw_plc_puddle2, tm_pl_puddle1 |
| Bones | plc_bones, plc_corpse1, nw_pl_skeleton |
| Webs | x3_plc_sweed001, x3_plc_sweed002 |
| Camp | plc_campfrwbench, plc_bedroll |

### Temple / Shrine
| Category | Resrefs |
|----------|---------|
| Altars | plc_altrgood, plc_altrevil, plc_altrneutral, x0_altar |
| Candelabras | plc_candelabra |
| Pedestals | plc_pedestal, x3_plc_pedestal |
| Statues | plc_statue1, plc_statue2, plc_statue3 |
| Rugs | x0_rugoriental, x0_roundrugorien, plc_throwrug |
| Books | plc_lecturn, plc_bookshelf |
| Braziers | plc_brazier, x3_plc_brazier |

### Containers (use across any theme)
| Type | Resrefs |
|------|---------|
| Chests | plc_chest1, plc_chest2, plc_chest3, plc_chest4 |
| Barrels | plc_barrel, x0_barrel |
| Crates | plc_box1, plc_box2, x2_easy_crate1 |
| Sacks | plc_lootbag1, plc_lootbag2 |
| Cabinets | plc_cabinet, plc_armoire |

### Lighting (use across any theme)
| Type | Resrefs |
|------|---------|
| Torches | plc_freetorch, x3_plc_torch001 |
| Candelabras | plc_candelabra |
| Braziers | plc_brazier, x3_plc_brazier, tm_pl_brazierwd1 |
| Flames | plc_flamesmall, plc_flamemedium, plc_flamelarge |

---

## Placeable Grouping Patterns

When placing placeables, group related objects together (within 2-4m of each other) for natural-looking scenes:

| Scene | Objects |
|-------|---------|
| Dining area | plc_table + 2-4 plc_chair + plc_barrel |
| Campsite | plc_campfrwbench + nw_plc_ropecoil1 + plc_bedroll + plc_barrel |
| Reading nook | x0_smalldesk + plc_chair + plc_bookshelf |
| Altar scene | plc_altrgood + plc_candelabra + x0_rugoriental |
| Torture room | plc_stocks + plc_torture1 + plc_brazier + plc_bloodstain |
| Smithy area | plc_anvil + plc_forge + plc_weaponrack + plc_barrel |
| Bedroom | plc_bed + plc_armoire + x0_rugoriental |
| Guard post | plc_weaponrack + plc_chair + plc_freetorch + plc_barrel |
| Merchant stall | tm_pl_stallmark1 + plc_box1 + plc_barrel + plc_signpost |
| Graveyard | plc_sarco1 + plc_bones + plc_brazier + plc_bloodstain |

---

## Important Notes

- **Tile coordinates:** Column = x (left to right), Row = y (bottom to top). World position = tile * 10.0 + 5.0 for center.
- **Do NOT auto-export HTML reports.**
- **Placeables do not block walkmesh.** PWK no-walk zones combine with tile walkmesh at runtime.
- **Sound radius non-overlap is critical.** Check distances between sound-producing placeables before assigning sounds.
- **Area-wide sounds go at area center.** Radius = `max(width, height) * 10` to cover the entire area.
- **Waypoint facing matters.** Entrance waypoints face into the area. Landmark waypoints face toward the landmark from the player's approach.
- **Group name → waypoint label.** Strip dimension suffixes: `"Lodge_2x2"` → `"Lodge"`, `"Temple_3x2"` → `"Temple"`.
- **Repack after placing.** Call `repack_module` at the end so the user can see changes in the toolset.
