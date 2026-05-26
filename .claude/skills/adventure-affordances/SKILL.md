---
name: adventure-affordances
description: Sub-skill of /create-adventure. Reads the plot, areas, environment, actors, quests, and challenges from adventure.md and places merchant stores, container loot, starting gold, and level adjustment. Fully autonomous, no user interaction.
allowed-tools: Bash(echo *), Read, Grep, Glob
---

# Affordances

Sub-skill of `/create-adventure`. Reads all prior sections of `adventure.md`, then populates the module with items, stores, and resources that help the player address challenges. Merchant stores are attached to existing NPCs via dialog modification. Useful items are placed in containers. A module start script gives starting gold and adjusts player level. Downstream skill (`/adventure-rewards`) uses affordance data to balance quest XP and end-of-adventure rewards.

## Prerequisites

- `adventure.md` must exist in the MCP temp directory (`$MCP_FOLDER_TEMP`, defaults to `$TEMP/nwn-mcp` or `/tmp/nwn-mcp`) and contain completed `## Plot`, `## Areas`, `## Environment`, `## Actors`, `## Quests`, and `## Challenges` sections.
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
- `## Actors`
- `## Quests`
- `## Challenges`

If any required section is missing or contains no content below its heading:
**STOP.** Output: `"ERROR: adventure.md is missing required section [name]. The prerequisite skill has not run or failed. Cannot proceed."`

---

### Phase 1: Read Adventure Context

Read `adventure.md`. Extract from all sections:

**From `## Plot`:**
- **Module metadata** — target level, tone, duration
- **Loot & Economy** — any items, gold, or economy notes in the plot outline
- **Key NPCs** — who could be a merchant (innkeeper, shopkeeper, trader)

**From `## Areas`:**
- **Resrefs** — area identifiers for `visualize_area` calls
- **Transitions** — area connectivity (safe areas get stores, dangerous areas get loot)

**From `## Environment`:**
- **Containers** — chests, crates, barrels, cabinets that can hold loot (look for placeables with `HasInventory` or container-type blueprints like `plc_chest1`, `plc_chest2`, `nw_yourchest`)
- **Existing placeables** — all placed objects with tags and positions

**From `## Actors`:**
- **Key NPCs** — resref, tag, dialog resref, position, area. Identify the best merchant candidate(s).
- **NPC personality** — a gruff innkeeper sells differently than a friendly herbalist

**From `## Quests`:**
- **Quest items** — what the player already receives from quests
- **Quest flow** — progression path helps decide where to place loot

**From `## Challenges`:**
- **Enemy difficulty** — determines what gear the player needs
- **Enemy equipment** — magic items on enemies become loot on death (no need to duplicate)
- **Traps** — antidotes or healing may be needed
- **CR range** — guides store inventory level

Build an **affordance plan**:
1. Identify 1-2 merchant NPCs and what they should sell
2. List containers that should receive loot, with item selection per container
3. Calculate starting gold amount
4. Determine level adjustment XP target

---

### Phase 2: Spatial Analysis (per area)

Call `visualize_area` to get the spatial payload. Extract:

- **Container positions** — placeables that are chests, barrels, or containers (match by blueprint resref or tag)
- **NPC positions** — where merchant NPCs are (store must be placed nearby)
- **Existing objects** — avoid placing stores on top of other objects
- **Area classification** — safe area (inn/town = stores) vs dangerous area (dungeon/wilderness = container loot)

Also call `get_area_placeables` for each area to get the exact GIT index of containers you want to modify.

---

### Phase 3: Design Affordance Plan

Based on context, design the full affordance layout:

**Store design:**
- **1 store per adventure** is typical for a one-shot. 2 stores max if there are distinct safe areas.
- Pick the most merchant-appropriate NPC (innkeeper, trader, shopkeeper).
- Stock 10-20 items covering: healing potions, basic weapons, basic armor, utility items (torches, scrolls, antidotes).
- Set prices to be affordable with starting gold — the player should be able to buy 3-5 key items.

**Container loot design:**
- Place useful items in 3-6 containers across the adventure.
- Early containers: minor consumables (potions, bandages).
- Mid-adventure containers: better gear or quest-relevant items.
- Pre-boss containers: strong consumables (healing kits, buff scrolls).
- Don't put loot in every container — empty containers are fine and feel realistic.

**Starting gold:**
- Base: `50 * targetLevel` gp.
- Adjust up if store prices are high or the adventure is long.

**Level adjustment:**
- XP formula: `targetLevel * (targetLevel - 1) * 500`
- Level 1 = 0 XP, Level 2 = 1000, Level 3 = 3000, Level 4 = 6000, Level 5 = 10000, etc.

---

### Phase 4: Look Up Base Game Item Resrefs

Use `resman_search` to find item resrefs for store inventory and container loot.

> **These resref lists are quick-reference examples, not exhaustive catalogs.**
> If no suitable blueprint is found in these lists, call `list_blueprints(type: "uti", pattern: "[search term]")` to search the full base game and HAK stack by resref, tag, and display name (including TLK-resolved names). Always prefer a thematic match from the full catalog over forcing a poor fit from the examples.

**Common items to look up:**

| Item | Search pattern | Notes |
|------|---------------|-------|
| Healing potions | `nw_it_mpotion001` through `003` | Cure Light/Moderate/Serious |
| Antidote | `nw_it_mpotion006` | Cure poison |
| Torch | `nw_it_torch001` | Light source |
| Healing kit | `nw_it_medkit001` through `004` | Heal skill item |
| Scroll (Bless) | search `nw_it_sparscr` | Divine scroll |
| Scroll (Magic Missile) | search `nw_it_spdvscr` | Arcane scroll |
| Ammunition (arrows) | `nw_wamar001` | For bows |
| Ammunition (bolts) | `nw_wambo001` | For crossbows |

**Weapons and armor:** Reuse the same resrefs documented in `/adventure-challenges` Equipment Reference. Stock mundane versions in shops — the player can buy gear to match the threats they'll face.

**Verify every resref** with `resman_search` before using it. If an expected resref doesn't resolve, search for alternatives.

Also search for a base game store blueprint to clone:
```
resman_search(pattern="store", type=".utm")
```
or try patterns like `nw_shopgen`, `x2_store`, `nw_mer`. Pick the simplest store (fewest pre-stocked items to clean out).

---

### Phase 5: Create Store Blueprint

Use `create_store_blueprint` to create a fully stocked store in one call:

```
create_store_blueprint(
  resref: "str_general",
  tag: "STR_GENERAL",
  name: "General Store",
  markUp: "120",
  markDown: "80",
  storeGold: "-1",
  maxBuyPrice: "0",
  identifyPrice: "100",
  inventory: '[{"resref": "nw_wswls001", "infinite": true, "category": 1}, {"resref": "nw_it_mpotion001", "infinite": true, "category": 2}, ...]'
)
```

**Inventory parameter:** JSON array where each item has:
- `resref` — base game or module item blueprint resref
- `infinite` — `true` for unlimited supply (typical for stores), `false` for limited stock
- `category` (optional) — 0=Armor, 1=Weapons, 2=Potions/Scrolls, 3=Wands/Magic, 4=Misc. Auto-detected from baseItem type if omitted.

**Store inventory categories** (standard 5 categories in NWN stores):
- Category 0: Armor
- Category 1: Weapons
- Category 2: Potions / Scrolls / Miscellaneous
- Category 3: Wands / Magic items
- Category 4: Miscellaneous / General

Stock items appropriate to the adventure's target level and theme. For a level 3 adventure:
- Mundane weapons (longswords, maces, bows) — category 1
- Light and medium armor (leather, chainmail) — category 0
- Healing potions (Cure Light Wounds x5, Cure Moderate x2) — category 2
- Antidote potions (x2-3 if traps include poison) — category 2
- Arrows/bolts (x99) — category 1
- Torches (x5) — category 4

---

### Phase 6: Create Custom Items (if needed)

Use `create_item_blueprint` for any adventure-specific items not available in the base game. The tool supports `sourceResref` to clone and modify a base game item, and `properties` for adding enchantments.

**Naming convention:** `aff_[name]` (max 16 chars).

**Creating enchanted items:**
```
create_item_blueprint(
  resref: "aff_holywtr",
  tag: "AFF_HOLYWTR",
  name: "Blessed Water",
  baseItem: "19",
  sourceResref: "nw_it_mpotion001",
  cost: "25",
  description: "Water blessed by a village priest. Effective against undead.",
  properties: '[{"propertyName": 56, "subType": 0, "costTable": 2, "costValue": 1}]'
)
```

**Common item property IDs** (from itempropdef.2da):
- `0` = Ability Bonus (subType: 0=STR, 1=DEX, 2=CON, 3=INT, 4=WIS, 5=CHA; costValue=bonus amount)
- `6` = Attack Bonus (costValue=bonus 1-20)
- `16` = Damage Bonus (subType=damage type; costTable=2, costValue=damage dice)
- `56` = Enhancement Bonus (costValue=bonus 1-20)
- `20` = Damage Resistance (subType=damage type, costValue=amount)

**Item descriptions are mandatory for custom items.** Always set the `description` parameter to a 1-2 sentence text that:
1. Describes what the item does mechanically (e.g., "Deals bonus fire damage on hit")
2. Ties it to the adventure's plot or setting (e.g., "Blessed by the village priest before the darkness came")

Example: `description: "A vial of water blessed at the shrine of Lathander. Burns undead on contact. The priest warned there were only a few left."`

Most affordance items can use base game resrefs. Only create custom items when:
- The plot requires a unique utility item
- A themed consumable enhances the adventure (e.g., "Blessed Water" for undead adventure)
- An antidote or remedy is needed that doesn't exist in base game
- A store needs a themed enchanted item (e.g., "+1 silver dagger" for a werewolf adventure)

---

### Phase 7: Place Store in Area

**Idempotency check:** Before placing a store, call `get_area_placeables(area: "...")` and check the store list from `visualize_area`. If a store with the same tag is already placed in the area, **skip** placement.

Use `place_store` to place the store blueprint in the area near its merchant NPC.

**Placement rules:**
- Place within 2-3 tiles of the merchant NPC
- Place on a walkable tile
- Don't overlap existing objects
- Stores are invisible in-game — they're accessed via `OpenStore()` script call, so exact position doesn't need to be visually perfect

**Coordinate calculation:** Use the merchant NPC's position from `visualize_area`. Place the store at the same position or offset by 1-2 world units.

---

### Phase 8: Add "Browse Wares" Dialog to Merchant NPC

Modify the merchant NPC's existing dialog to add a "browse wares" option.

**Step 1: Write store-open script** with `write_script`:

```nwscript
// a_str_general.nss
void main() {
    object oPC = GetPCSpeaker();
    object oStore = GetNearestObjectByTag("str_general");
    OpenStore(oStore, oPC);
}
```

Compile the script (write_script compiles by default).

**Step 2: Read the NPC's existing dialog** with `flatten_dialog` to find the greeting entry structure.

**Step 3: Add a PC reply** to the NPC's greeting (first NPC entry) using `add_dialog_node`:

```
add_dialog_node(
  dialog: "dlg_[npc]",
  parentType: "entry",
  parentIndex: "0",
  text: "I'd like to see what you have for sale.",
  script: "a_str_general"
)
```

This adds a new PC reply option to entry 0 (the NPC's greeting). When the player selects it, the action script fires and opens the store.

**Important:** The `script` field on the `add_dialog_node` call becomes the `Script` (action) on the new reply node. When the PC clicks this reply, the store opens.

**If the NPC has quest-gated root entries:** The "browse wares" option should appear on ALL greeting entries, not just entry 0. Check `flatten_dialog` output — if the NPC has multiple condition-gated greetings (from `/adventure-quests`), add the browse-wares reply to each one so the player can always shop regardless of quest stage.

---

### Phase 9: Add Loot to Containers

Find containers (chests, crates, barrels) placed by `/adventure-environment` and add items to their inventory.

**Step 1:** For each area, call `get_area_placeables` to get the list of placeables with their tags and indices.

**Step 2:** Identify container placeables by their blueprint resref or tag. Common container blueprints:
- `plc_chest1`, `plc_chest2`, `plc_chest3` — wooden chests
- `plc_footchest` — small footlocker
- `nw_yourchest` — personal chest
- `plc_crate1`, `plc_crate2` — wooden crates
- `plc_barrel1`, `plc_barrel2` — barrels
- `plc_cabinet` — cabinet

Not all placeables with these resrefs are containers — check if they have `HasInventory: 1` or if they appear in the environment section as containers. When in doubt, check the `HasInventory` field via `get_resource` on the placeable blueprint.

**Step 3:** For each container that should receive loot, use `add_items_to_container`:

```
add_items_to_container(
  area: "[area_resref]",
  containerTag: "[container_tag]",
  items: '[{"resref": "nw_it_mpotion001"}, {"resref": "nw_it_mpotion002", "quantity": 3}]'
)
```

This tool automatically:
- Finds the container by tag in the area's Placeable List
- Enables `HasInventory` on the container
- Creates `ItemList` if it doesn't exist
- Resolves item blueprints from module or base game
- Auto-assigns inventory grid positions
- Sets items as identified

**Container description update:** After adding items to a container, update its `Description` via `modify_gff_field` to hint at the contents while staying in-world. If the container already has a description from `/adventure-environment` (ambient flavor text), **integrate** the existing text with the new loot hint — don't replace it. Read the current `Description` first, then append or weave in the loot hint.

Examples:
- Existing ambient: `"A dusty ale barrel. The tap is crusted with something dark."` + loot added → `"A dusty ale barrel. The tap is crusted with something dark. Something clinks inside when you nudge it."`
- No existing description + healing potions added → `"A weathered crate. Faint herbal scent seeps through the slats."`
- Pre-boss chest + good gear → `"An iron-banded strongbox, half-buried in rubble. Whatever's inside, someone wanted it kept safe."`

**Loot placement guidelines:**
- **Safe area containers** (inn, town): Minor consumables — 1-2 healing potions, a torch, maybe some gold (use a gold item or potion)
- **Early adventure containers**: Basic gear — a weapon, light armor, or healing supplies
- **Mid-adventure containers**: Better consumables — healing kits, buff scrolls, antidotes
- **Pre-boss containers**: Strong consumables — multiple healing potions, a good weapon if the player might need it
- **Don't overstock** — 1-3 items per container is plenty. Not every container needs loot.
- **Don't duplicate enemy loot** — enemies already drop their equipped items on death. Container loot should complement, not duplicate.

---

### Phase 10: Write Module Start Script

Write a `Mod_OnClientEntr` script that runs once per player to give starting gold and adjust level.

**Step 1: Check existing module scripts.**
Call `get_module_info` to check if `Mod_OnClientEntr` (or `onClientEnter`) already has a script assigned. If one exists, read it with `read_script_source` and extend it rather than replacing it.

**Step 2: Write the script** with `write_script`:

```nwscript
// a_mod_enter.nss
void main() {
    object oPC = GetEnteringObject();
    if (!GetIsPC(oPC)) return;

    // Run once per player
    if (GetLocalInt(oPC, "mod_init") == 1) return;
    SetLocalInt(oPC, "mod_init", 1);

    // Starting gold
    GiveGoldToCreature(oPC, <AMOUNT>);

    // Level adjustment — give enough XP to reach target level
    int nTargetXP = <TARGET_XP>;
    if (GetXP(oPC) < nTargetXP) {
        SetXP(oPC, nTargetXP);
    }
}
```

Replace `<AMOUNT>` with the calculated starting gold and `<TARGET_XP>` with `targetLevel * (targetLevel - 1) * 500`.

**XP thresholds:**
| Level | XP Required |
|-------|-------------|
| 1 | 0 |
| 2 | 1,000 |
| 3 | 3,000 |
| 4 | 6,000 |
| 5 | 10,000 |
| 6 | 15,000 |
| 7 | 21,000 |
| 8 | 28,000 |
| 9 | 36,000 |
| 10 | 45,000 |

**If extending an existing script:** Wrap the affordance logic inside the existing script's `main()`, preserving whatever logic was already there.

---

### Phase 11: Set Module IFO Script

Assign the module start script to the module's IFO using `set_module_scripts`:

```
set_module_scripts(Mod_OnClientEntr: "a_mod_enter")
```

If `Mod_OnClientEntr` already has a value and you extended the existing script, no IFO change is needed.

---

### Phase 12: Verify

1. **`validate_module`** — check for broken references (missing scripts, items, blueprints)
2. **Check store inventory** — call `get_store_details` on each created store to verify items are stocked
3. **Check NPC dialog** — call `flatten_dialog` on the merchant NPC to verify "browse wares" option exists
4. **Verify scripts compiled** — all `write_script` calls should auto-compile; check for errors

Fix any issues before proceeding.

---

### Phase 13: Update adventure.md

Append a `## Affordances` section to `adventure.md`:

```markdown
## Affordances

### Stores

- **[Store Name]** (`str_resref`) in [Area Name] (`area_resref`) near [NPC Name] (`npc_tag`)
  - Inventory: [list of key items — type, resref, price]
  - Markup: [N]%, Markdown: [N]%
  - Script: `a_str_resref` on `dlg_[npc]` "browse wares" option

### Container Loot

- **[Container tag]** in [Area Name] (`area_resref`) at (x, y):
  - [Item 1] (`resref`)
  - [Item 2] (`resref`)
...

### Starting Resources

- Starting gold: [N] gp
- Level adjustment: Target level [N], XP threshold: [N]
- Script: `a_mod_enter` assigned to Mod_OnClientEntr
- Behavior: Once per PC — gives gold and sets XP if below target

### Custom Items

- **[Item Name]** (`aff_resref`) — [description, base item type, where used]
(omit this section if no custom items were created)
```

This data is used by downstream skill:
- `/adventure-rewards` uses affordance data to avoid duplicating loot and to balance quest XP relative to starting resources

---

### Phase 14: Save/Sync

Save/sync all changes. For standalone `.mod` workflows, call `repack_module`. For Nasher workflows, call `sync_nasher_source` at the end if any write response lacked `nasherSync` or if you are unsure; call `repack_module` only when a packed `.mod` is needed.

---

## Store Inventory Guidelines

### By Target Level

**Level 1-3 (low-level adventure):**
- Weapons: mundane longsword, shortsword, mace, dagger, shortbow, light crossbow
- Armor: leather, studded leather, chainmail, small shield
- Potions: Cure Light Wounds (x5), Antidote (x2)
- Consumables: torches (x5), healing kit (basic)
- Ammunition: arrows (x99), bolts (x99)
- Budget: ~150 gp starting gold

**Level 4-6 (mid-level adventure):**
- Weapons: longsword, battleaxe, longbow, morningstar
- Armor: chainmail, scale mail, large shield
- Potions: Cure Light (x5), Cure Moderate (x3), Antidote (x3)
- Consumables: healing kit (standard), buff scrolls (Bless, Bull's Strength)
- Ammunition: arrows (x99), bolts (x99)
- Budget: ~250 gp starting gold

**Level 7-10 (higher-level adventure):**
- Weapons: longsword, greatsword, longbow, warhammer
- Armor: half-plate, full plate, tower shield
- Potions: Cure Moderate (x5), Cure Serious (x3), Antidote (x3), Restoration (x1)
- Consumables: healing kit (advanced), buff scrolls, utility scrolls
- Ammunition: arrows (x99), bolts (x99)
- Budget: ~400 gp starting gold

### Pricing

Use base game item costs. If a store's total affordable inventory exceeds starting gold by 3-4x, that's about right — the player should have to choose what to buy, not buy everything.

---

## Naming Conventions

| Resource | Pattern | Example | Max Length |
|----------|---------|---------|-----------|
| Store blueprint | `str_[name]` | `str_general` | 16 chars |
| Store-open script | `a_str_[name]` | `a_str_general` | 16 chars |
| Module start script | `a_mod_enter` | `a_mod_enter` | 16 chars |
| Custom items | `aff_[name]` | `aff_healkit` | 16 chars |

**Keep names to 5-9 characters** to stay within the 16-char resref limit after prefixes.

---

## Important Notes

- **Do NOT auto-export HTML reports.**
- **1-2 stores max.** One-shot adventures don't need a shopping district. One general store is usually enough.
- **Don't duplicate enemy loot.** Defeated enemies drop their equipped items automatically. Container loot and store inventory should complement enemy drops, not repeat them.
- **Verify every item resref** with `resman_search` before using it in store inventory or containers. Items that don't resolve will cause silent failures.
- **Store placement is invisible.** Stores are data objects accessed via `OpenStore()` — they don't render in-game. Place them near the merchant NPC for the `GetNearestObjectByTag` call to work.
- **Container `ItemList` may not exist.** If a placeable doesn't already have an `ItemList`, you may need to create the field via `modify_gff_field` with `gffType: "list"`.
- **Browse wares on all greetings.** If `/adventure-quests` added multiple condition-gated root entries to the NPC's dialog, add the "browse wares" reply to each greeting entry so it's always accessible.
- **Module script conflicts.** Always check `get_module_info` for an existing `Mod_OnClientEntr` script before writing a new one. Extend, don't replace.
- **Gold is generous, not excessive.** The player should be able to buy core gear (weapon + armor + potions) but not everything in the store. This creates meaningful choices.
- **Save/sync after all changes.** Standalone `.mod`: call `repack_module`. Nasher: call `sync_nasher_source` at the end if any write response lacked `nasherSync` or if you are unsure; call `repack_module` only when a packed `.mod` is needed.
