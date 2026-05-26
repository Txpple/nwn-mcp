---
name: adventure-actors
description: Sub-skill of /create-adventure. Reads the plot, areas, and environment from adventure.md and places non-hostile NPCs with greeting dialogs and ambient creatures. All actors use Commoner faction. Fully autonomous, no user interaction.
allowed-tools: Bash(echo *), Read, Grep, Glob
---

# Actors

Sub-skill of `/create-adventure`. Reads the plot, areas, and environment sections of `adventure.md`, then places key NPCs with simple greeting dialogs and ambient creatures appropriate to each area's theme. All actors use **Commoner faction (ID 2)** — no custom factions for a one-shot module. Downstream skills (`/adventure-quests`, `/adventure-challenges`) will select from the placed actors for quest roles and hostile encounters.

## Prerequisites

- `adventure.md` must exist in the MCP temp directory (`$MCP_FOLDER_TEMP`, defaults to `$TEMP/nwn-mcp` or `/tmp/nwn-mcp`) and contain completed `## Plot`, `## Areas`, and `## Environment` sections.
- A module must be loaded. If none is loaded, call `load_module` using the module name from `adventure.md`; it auto-routes when a Nasher project is detected.

## Workflow

Fully autonomous. Make all decisions based on the plot document and spatial data — do NOT ask the user for input.

---

### Pre-Check: Validate adventure.md

Read `adventure.md` from the MCP temp directory. Verify these sections exist and are non-empty:
- `## Module`
- `## Plot`
- `## Areas`
- `## Environment`

If any required section is missing or contains no content below its heading:
**STOP.** Output: `"ERROR: adventure.md is missing required section [name]. The prerequisite skill has not run or failed. Cannot proceed."`

---

### Phase 1: Read the Plot, Areas, and Environment

Read `adventure.md`. Extract from `## Plot`:
- **Key NPCs** — name, race/appearance, role, location, personality, motivation, quest involvement
- **Locations** — mood, theme, setting keywords per area
- **Antagonists** — creature types to AVOID placing as ambient (those go in `/adventure-challenges`)

Extract from `## Areas`:
- **Resrefs** — area identifiers for `visualize_area` calls
- **Features** — multi-tile groups (lodges, temples) where NPCs naturally belong

Extract from `## Environment`:
- **Placed placeables** — for positioning NPCs near relevant objects (innkeeper near fireplace, guard near door)
- **Waypoints** — landmarks that suggest NPC positions

Build a list of all NPCs and ambient creature types to create. Process areas one at a time.

---

### Phase 2: Spatial Analysis (per area)

Call `visualize_area` to get the spatial payload. Extract:

- **Tile grid** — walkable tiles (`walkablePercent` > 50%), materials, group names
- **Features** — tile group names inform NPC placement (Lodge/Cabin → NPCs go inside, Temple → priest goes inside, Ruins → nobody lives here)
- **Existing objects** — doors, placeables, waypoints. Position NPCs near relevant objects but not on top of them.
- **Tile materials** — Wood tiles inside buildings = good NPC positions. Stone = dungeon. Grass/Dirt = exterior.

---

### Phase 3: Create Key NPC Blueprints

For each NPC described in the plot's `### Key NPCs` section:

1. **Pick a source blueprint** from the reference table that best matches the NPC's described race, gender, and appearance. The source provides the visual model — the skill overrides name, faction, and dialog.

2. **Call `create_creature_blueprint`** with:
   - `sourceResref` — the base game blueprint resref
   - `resref` — unique identifier derived from NPC name (lowercase, no spaces, max 16 chars, e.g., `elara`, `gormund`, `innkeeper`)
   - `tag` — same as resref
   - `name` — the NPC's display name from the plot (e.g., "Elara the Healer")
   - `faction` — **always `2`** (Commoner)
   - `conversation` — dialog resref, e.g., `dlg_elara`

3. **Do NOT modify stats, feats, or equipment** unless the plot specifically describes combat capability. The source blueprint's stats are fine for ambient NPCs. `/adventure-quests` or `/adventure-challenges` can upgrade stats later if needed.

---

### Phase 4: Create NPC Dialogs

For each key NPC, create a simple greeting dialog using `create_dialog`.

**Dialog structure:**
- Root node is always NPC (speaker: `"npc"`)
- NPC greeting line reflects their personality and situation from the plot
- 1-3 PC response options (curious, friendly, dismissive)
- Optional NPC follow-up lines with personality flavor
- Keep it short: 2-4 exchanges maximum

**Dialog content rules:**
- **Flavor/personality ONLY** — no quest logic, no `AddJournalQuestEntry`, no scripts. That's `/adventure-quests`'s job.
- Reflect the NPC's personality from the plot: gruff, nervous, welcoming, suspicious, etc.
- NPCs can hint at the plot situation ("Strange things have been happening...") but don't assign quests.
- PC responses should feel natural, not like a quest menu.

**Resref naming:** `dlg_[npc_resref]` (e.g., `dlg_elara`, `dlg_gormund`)

**Example dialog tree:**
```json
[
  {
    "speaker": "npc",
    "text": "Welcome, traveler. You look like you could use a warm meal. Though I warn you — the stew's been sitting a while.",
    "children": [
      {
        "speaker": "pc",
        "text": "I'll take my chances with the stew.",
        "children": [
          {
            "speaker": "npc",
            "text": "Ha! Brave soul. That'll be two coppers. Find yourself a seat."
          }
        ]
      },
      {
        "speaker": "pc",
        "text": "What's the mood around here? Seems tense.",
        "children": [
          {
            "speaker": "npc",
            "text": "Aye, folk have been on edge lately. Strange noises from the forest at night. But that's none of my business — I just pour the drinks."
          }
        ]
      },
      {
        "speaker": "pc",
        "text": "Just passing through."
      }
    ]
  }
]
```

---

### Phase 5: Place Ambient Creatures

**Idempotency check:** Before placing creatures in an area, call `get_area_creatures(area: "...")`. If creatures with matching tags are already present, **skip** those — do not place duplicates.

**Appearance sanity check:** After cloning a creature blueprint, verify its appearance makes sense for the placement context. Call `resolve_2da(table: "appearance", row: "<appearance_id>", column: "LABEL")` and check the label. NWN creature names can be misleading — `nw_cat` is a **leopard** (appearance `Cat_Leopard`), not a housecat. If the appearance label doesn't match what you'd expect to see in the location, don't place it. There is no domestic cat model in NWN.

For each area, select ambient creatures that fit the theme from the reference table.

1. **Clone each creature type once** with `create_creature_blueprint`:
   - `sourceResref` — base game animal blueprint
   - `resref` — `amb_[creature]` (e.g., `amb_cat`, `amb_deer`, `amb_rat`)
   - `tag` — same as resref
   - `name` — leave from source (use the base game name)
   - `faction` — **always `2`** (Commoner), even for creatures that are hostile by default (cat, rat, wolf, raven)
   - No `conversation` — ambient creatures don't talk

2. **Place 3-8 ambient creatures per area** depending on area size:
   - ~8x8 → 3-4 creatures
   - ~12x12 → 5-6 creatures
   - ~18x18 → 7-8 creatures

3. **Placement rules:**
   - Spread across walkable tiles, not clustered
   - Animals belong outdoors (Grass/Dirt tiles), not inside buildings (unless cats/dogs in an inn)
   - Dungeon creatures (rats, bats) can go anywhere underground
   - Avoid placing on door tiles or right next to NPCs
   - Vary facing for natural appearance

---

### Phase 6: Place Key NPCs

**Idempotency check:** Before placing NPCs in an area, call `get_area_creatures(area: "...")`. If a creature with the same tag is already placed, **skip** it.

Place each NPC blueprint in the area specified by the plot.

**Positioning guidelines:**
- Place near **relevant environment objects**: innkeeper near bar/fireplace, guard near door, shopkeeper near market stall, priest near altar
- Place **inside features** (tile group names): NPCs belong inside Lodge, Cabin, Temple, Tower — not on Bridge or Ruins
- Place on **walkable tiles** with `walkablePercent` > 50%
- Don't place on top of existing objects (check `objects` array from `visualize_area`)
- Position at tile center with small offset for natural placement

**Facing:** Orient NPCs toward the player's likely approach:
- Behind a counter/bar → face the open side
- In a room → face the door/entrance
- In an open area → face the nearest path or clearing

---

### Phase 6b: Set Up Walk Waypoints

NPCs and ambient creatures should walk waypoint routes instead of standing still. The NWN default AI (`nw_c2_default9`) supports this via the `NW_GENERIC_MASTER` local variable and tagged waypoints.

#### Step 1: Set Walk Flags on Creature Blueprints

After creating each creature blueprint (key NPC or ambient), use `modify_gff_field` to add a `VarTable` entry that enables day/night walk posting. The `NW_GENERIC_MASTER` variable is a bitmask — set bit 10 (`NW_FLAG_DAY_NIGHT_POSTING` = `0x400` = `1024`):

```
modify_gff_field(
  file: "<blueprint_resref>.utc",
  path: "VarTable",
  value: [
    {
      "__struct_id": 0,
      "Name": { "type": "cexostring", "value": "NW_GENERIC_MASTER" },
      "Type": { "type": "dword", "value": 1 },
      "Value": { "type": "int", "value": 1024 }
    }
  ],
  fieldType: "list"
)
```

If the blueprint already has a `VarTable`, merge into it rather than replacing.

#### Step 2: Place Walk Waypoints

For each creature placed in an area, place **2-4 waypoints** along a logical patrol route near the creature's position. Tag them using the NWN convention:

- `WP_[creature_tag]_01` — first waypoint (place at or near the creature's position)
- `WP_[creature_tag]_02` — second waypoint (5-15m away, on a walkable tile)
- `WP_[creature_tag]_03` — optional third waypoint
- `WP_[creature_tag]_04` — optional fourth waypoint

Use `place_waypoint` for each. The creature will walk between these points in order, then loop back to `_01`.

**Route planning guidelines:**
- **Key NPCs** — short routes (2-3 waypoints) near their functional area. An innkeeper walks behind the bar. A guard patrols near the door. Keep routes within 10-20m.
- **Ambient creatures** — longer routes (3-4 waypoints) across the area. A dog roams the village. A deer crosses a clearing. Routes can span 20-40m.
- All waypoints must be on walkable tiles (`walkablePercent` > 50%)
- Routes should not cross through walls, doors, or impassable terrain
- Vary route shapes — L-shapes, loops, back-and-forth. Not just straight lines.
- For NPCs near features (lodge, temple), keep routes inside the feature tiles

**Night posting (optional):** If the area has day/night cycle enabled and an NPC should move to a different spot at night (e.g., guard goes indoors), place waypoints tagged `NIGHT_[creature_tag]_01`, `NIGHT_[creature_tag]_02`. If no night waypoints are placed, the creature uses the day route at all times.

**Single post point:** If an NPC should stand in one place (e.g., a bartender behind a counter who shouldn't wander), place a single waypoint tagged `POST_[creature_tag]` instead of numbered walk waypoints. This makes the creature return to that spot after any interaction.

---

### Phase 7: Update adventure.md

Append an `## Actors` section to `adventure.md` with this structure:

```markdown
## Actors

### [Area Name] (`resref`)

**Key NPCs:**
- **[NPC Name]** (`resref`, tag: `tag`) at (x, y) — [role]. Dialog: `dlg_resref`. Source: `source_blueprint`.
...

**Ambient Creatures:**
- [creature type] x[count] (`amb_resref`) — [brief note, e.g., "wandering the clearing"]
...

**Faction:** All actors set to Commoner (ID 2).
```

This data is used by downstream skills to select actors for quest roles (`/adventure-quests`) and to know which areas already have creature presence (`/adventure-challenges`).

Save/sync the result. For standalone `.mod` workflows, call `repack_module`. For Nasher workflows, call `sync_nasher_source` at the end if any write response lacked `nasherSync` or if you are unsure; call `repack_module` only when a packed `.mod` is needed.

---

## Faction Rules

- **ALL actors placed by this skill use Commoner faction (ID 2).** No exceptions.
- Always set `faction=2` in `create_creature_blueprint` regardless of the source blueprint's default faction.
- Standard NWN factions only: 0=PC, 1=Hostile, 2=Commoner, 3=Merchant, 4=Defender.
- **No custom factions.** Out of scope for a one-shot module.
- Hostile creatures are placed by `/adventure-challenges`, not this skill.
- If `/adventure-quests` needs a merchant NPC, it can change the faction to 3 (Merchant) later.

---

## Humanoid NPC Source Blueprints

Pick the one that best matches the plot's NPC description. Clone it and override name/faction/dialog.

**IMPORTANT:** Always set `faction=2` when cloning. Many of these blueprints default to Hostile.

> **These resref lists are quick-reference examples, not exhaustive catalogs.**
> If no suitable blueprint is found in these lists, call `list_blueprints(type: "utc", pattern: "[search term]")` to search the full base game and HAK stack by resref, tag, and display name (including TLK-resolved names). Always prefer a thematic match from the full catalog over forcing a poor fit from the examples.

| Description | Resref | Notes |
|------------|--------|-------|
| Elderly human male | nw_oldman | Commoner class |
| Elderly human female | nw_oldwoman | Commoner class |
| Bartender / innkeeper | nw_bartender | Commoner class |
| Shopkeeper | nw_shopkeep | Commoner class |
| Waitress / barmaid | nw_waitress | Commoner class, female |
| Guard / soldier | nw_guard | Fighter lv1, has armor |
| Convict / prisoner | nw_convict | Commoner class |
| Luskan thug | nw_luskanite | Commoner class |
| Human fighter (lv2) | nw_humanmerc001 | Fighter, light armor |
| Human fighter (lv4) | nw_humanmerc002 | Fighter, medium armor |
| Human fighter (lv6) | nw_humanmerc003 | Fighter, heavier gear |
| Human fighter (lv8) | nw_humanmerc004 | Fighter, good gear |
| Human fighter (lv10) | nw_humanmerc005 | Fighter, heavy gear |
| Human fighter (lv12) | nw_humanmerc006 | Fighter, best gear |
| Dwarf fighter (lv2) | nw_dwarfmerc001 | Fighter |
| Dwarf fighter (lv4) | nw_dwarfmerc002 | Fighter |
| Dwarf fighter (lv6) | nw_dwarfmerc003 | Fighter |
| Elf ranger (lv2) | nw_elfmerc001 | Ranger |
| Elf ranger (lv4) | nw_elfmerc002 | Ranger |
| Elf mage (lv2) | nw_elfmage001 | Wizard |
| Elf mage (lv6) | nw_elfmage005 | Wizard |
| Halfling rogue (lv2) | nw_halfmerc001 | Rogue |
| Halfling rogue (lv4) | nw_halfmerc002 | Rogue |
| Half-elf cleric | nw_halfcel001 | Cleric |
| Half-drow fighter | nw_halfdra001 | Fighter |
| Halfling commoner | nw_halfling001 | Commoner |
| Bandit (lv1) | nw_bandit001 | Fighter, ragged |

**If no blueprint matches:** Use `resman_search` with a keyword (e.g., `nw_priest`, `nw_monk`) to find alternatives. Or use `create_creature_blueprint` without `sourceResref` and set the `appearance` field directly from appearance.2da (use `search_2da` on `appearance` table).

---

## Ambient Creature Blueprints

Clone each type once with `create_creature_blueprint`, setting `faction=2`.

| Creature | Resref | Default Faction | Ambient Resref |
|----------|--------|-----------------|----------------|
| Dog | nw_dog | 2 (Commoner) | amb_dog |
| Chicken | nw_chicken | 2 (Commoner) | amb_chicken |
| Cow | nw_cow | 2 (Commoner) | amb_cow |
| Deer | nw_deer | 2 (Commoner) | amb_deer |
| Ox | nw_ox | 2 (Commoner) | amb_ox |
| Bat | nw_bat | 2 (Commoner) | amb_bat |
| Raven | nw_raven | 1 (Hostile) | amb_raven |
| Rat | nw_rat001 | 1 (Hostile) | amb_rat |
| Wolf | nw_wolf | 1 (Hostile) | amb_wolf |
| Boar | nw_boar | 1 (Hostile) | amb_boar |
| Seagull | nw_seagullwalk | unknown | amb_seagull |
| Parrot | nw_parrot | unknown | amb_parrot |

**Creatures by area theme:**

| Theme | Creatures |
|-------|-----------|
| Forest / exterior | nw_deer, nw_dog, nw_raven, nw_boar |
| Village / town | nw_dog, nw_chicken, nw_cow, nw_ox |
| Inn / tavern | nw_dog |
| Dungeon / crypt | nw_rat001, nw_bat |
| Cave | nw_bat, nw_rat001 |
| Coast / harbor | nw_seagullwalk, nw_parrot |

---

## Important Notes

- **Tile coordinates:** Column = x (left to right), Row = y (bottom to top). World position = tile * 10.0 + 5.0 for center.
- **Do NOT auto-export HTML reports.**
- **Always set faction=2.** Never trust the source blueprint's default faction.
- **Dialog resref must be created before the creature blueprint** that references it (or create them in the right order: dialog first, then blueprint with `conversation` field).
- **No quest logic in dialogs.** NPCs can hint at the situation but do NOT assign quests, give journal entries, or run scripts. That's `/adventure-quests`'s job.
- **Save/sync after placing.** Standalone `.mod`: call `repack_module`. Nasher: call `sync_nasher_source` at the end if any write response lacked `nasherSync` or if you are unsure; call `repack_module` only when a packed `.mod` is needed.
- **Ambient creatures don't get dialogs.** Only key NPCs from the plot get `create_dialog` calls.
- **Max 16 character resrefs.** NWN has a 16-char limit on resref identifiers.
