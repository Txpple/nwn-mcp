---
name: adventure-challenges
description: Sub-skill of /create-adventure. Reads the plot, areas, environment, actors, and quests from adventure.md and places hostile creatures with tactical roles (melee, caster, healer) and traps. All enemies use Hostile faction. Fully autonomous, no user interaction.
allowed-tools: Bash(echo *), Read, Grep, Glob
---

# Challenges

Sub-skill of `/create-adventure`. Reads all prior sections of `adventure.md`, then places hostile creatures with tactical combat roles and traps as a layer on top of existing content. **All hostile creatures use faction 1 (Hostile).** Creatures are selected by appearance (thematic fit), then independently given stats, classes, feats, spells, and equipment to create tactical diversity. Downstream skills (`/adventure-affordances`, `/adventure-rewards`) use challenge data to stock loot and assign XP.

## Prerequisites

- `adventure.md` must exist in the MCP temp directory (`$MCP_FOLDER_TEMP`, defaults to `$TEMP/nwn-mcp` or `/tmp/nwn-mcp`) and contain completed `## Plot`, `## Areas`, `## Environment`, `## Actors`, and `## Quests` sections.
- A module must be loaded. If none is loaded, call `load_module` using the module name from `adventure.md`.

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

If any required section is missing or contains no content below its heading:
**STOP.** Output: `"ERROR: adventure.md is missing required section [name]. The prerequisite skill has not run or failed. Cannot proceed."`

---

### Phase 1: Read Adventure Context

Read `adventure.md`. Extract from all sections:

**From `## Plot`:**
- **Module metadata** — target level, tone, duration
- **Antagonists** — creature types, motivation, escalation pattern, territory
- **Challenges** — combat encounters, puzzles, hazards described in the plot
- **Locations** — which areas are safe (town/inn), which are dangerous (dungeon/forest)

**From `## Areas`:**
- **Resrefs** — area identifiers for `visualize_area` calls
- **Dimensions** — area size (affects creature count)
- **Transitions** — area connectivity (shapes difficulty escalation)
- **Doors** — chokepoints and guard positions

**From `## Environment`:**
- **Placeables** — existing objects to avoid when placing creatures
- **Waypoints** — landmarks for positioning context

**From `## Actors`:**
- **Key NPCs** — positions to avoid overlapping
- **Ambient creatures** — existing creature presence (don't duplicate)

**From `## Quests`:**
- **Quest flow** — the player's progression path through areas
- **Quest objectives** — where the player needs to go (place encounters along these paths)
- **Quest items** — locations of quest pivots (guard these with enemies)

Build a **challenge placement plan**:
1. Map areas from safest to most dangerous based on quest flow
2. Determine enemy factions/themes per area (goblins in forest, undead in dungeon, etc.)
3. Plan creature count per area based on size and role
4. Assign tactical roles to enemy groups (melee/caster/healer mix)
5. Identify trap locations (corridors, treasure, chokepoints)
6. Plan boss encounter for the climax area

---

### Phase 1.5: Scale Parameters

Read **Party Size** and **Difficulty** from `## Module`.

**Party size scaling** (creature count per encounter group):
- Solo (1): base counts (2-3 per patrol, 3-5 per guard post, 4-6 per boss)
- Party of 2: +1 creature per group
- Party of 3: +1 creature per group, +1 to boss
- Party of 4: +2 creatures per group, +2 to boss

**Difficulty scaling** (CR adjustment):
- Normal: use CR targets as designed
- Hard: +1 CR to all encounters, add one extra creature to each boss encounter, boss gets +2 CR instead of +1

Apply these multipliers throughout Phase 3-6.

---

### Phase 2: Spatial Analysis (per area)

Call `visualize_area` to get the spatial payload. Extract:

- **Tile grid** — walkable tiles (`walkablePercent` > 50%), materials, group names
- **Features** — tile groups that define rooms and spaces (place encounters inside rooms)
- **Existing objects** — all NPCs, placeables, doors, waypoints. Don't overlap.
- **Zone connectivity** — identify rooms, corridors, chokepoints, open areas
- **Doors** — guard positions, ambush points near doorways

---

### Phase 3: Design Enemy Groups

For each dangerous area, design enemy encounters with tactical diversity.

**Group composition patterns:**
- **Patrol** (2-3 creatures): 2 melee + 1 ranged OR 2 melee + 1 caster
- **Guard post** (2-4 creatures): 2-3 melee + 0-1 caster, positioned near a door or objective
- **Ambush** (3-4 creatures): Mix of melee + ranged, hidden around corners
- **Boss fight** (3-5 creatures): 1 boss + 2-4 adds of mixed roles
- **Lone sentry** (1 creature): Single tough melee creature at a chokepoint

**Creature count by area role:**
- **Safe area** (inn, town) — 0 enemies (or 1-2 only if plot demands, e.g., assassins)
- **Transition area** (forest path, road) — 3-6 enemies in 1-2 groups
- **Adventure area** (cave, ruins) — 5-10 enemies in 2-3 groups
- **Dungeon** — 8-14 enemies in 3-5 groups
- **Boss room** — 1 boss + 2-4 adds

**Placement exclusion zones (never place hostile creatures here):**
- Within 10 tiles of the module start/entry point (player spawn) — gives the player time to orient before combat
- Within 6 tiles of any area transition trigger or waypoint — prevents enemies from attacking players mid-transition or instantly on arrival
- Within 8 tiles of any friendly NPC (Commoner faction) — prevents hostiles from immediately aggroing on the NPC and killing them before the player can interact

---

### Phase 4: Lookup Feat and Spell IDs

Before creating creature blueprints, look up the IDs you need.

**Feats:** Use `search_2da(table="feat", column="LABEL", value="...")` to find feat IDs. The row number IS the feat ID. Key feats to look up:

| Feat | Search value | Used by |
|------|-------------|---------|
| Power Attack | `PowerAtk` | Melee |
| Cleave | `Cleave` | Melee |
| Weapon Focus (by weapon) | `WeapFoc` | Melee |
| Dodge | `Dodge` | All |
| Toughness | `Toughness` | Tank |
| Point Blank Shot | `PointBlank` | Ranged |
| Rapid Shot | `RapidShot` | Ranged |
| Combat Casting | `CombCast` | Caster/Healer |
| Spell Focus (by school) | `SpellFoc` | Caster |
| Armor Proficiency (Light/Medium/Heavy) | `ArmProf` | By role |
| Weapon Proficiency (Martial/Simple) | `WeapProf` | By role |
| Shield Proficiency | `ShieldProf` | Melee/Healer |

**Spells:** Use `search_2da(table="spells", column="Label", value="...")` to find spell IDs. The row number IS the spell ID. Key spells to look up:

| Spell | Search value | Used by |
|-------|-------------|---------|
| Magic Missile | `Magic_Missile` | Caster |
| Burning Hands | `Burning_Hands` | Caster |
| Fireball | `Fireball` | Caster |
| Lightning Bolt | `Lightning_Bolt` | Caster |
| Melf's Acid Arrow | `Melfs_Acid_Arrow` | Caster |
| Cure Light Wounds | `Cure_Light_Wounds` | Healer |
| Cure Moderate Wounds | `Cure_Moderate_Wounds` | Healer |
| Cure Serious Wounds | `Cure_Serious_Wounds` | Healer |
| Hold Person | `Hold_Person` | Healer/Caster |
| Sleep | `Sleep` | Caster (low level) |
| Ray of Frost | `Ray_of_Frost` | Caster (cantrip) |
| Flame Strike | `Flame_Strike` | Healer |

**Cache the IDs** — look up all needed feats and spells once at the start, then reuse the IDs across all creature blueprints.

---

### Phase 5: Create Hostile Creature Blueprints

**Collision check:** Before calling `create_creature_blueprint(resref: "foo")`:
1. Call `search_by_tag(tag: "foo")`.
2. If a resource with that tag already exists in the module, **reuse it** — do not recreate.
3. Only create a new blueprint if the tag is truly unused.

For each enemy type needed, create a blueprint with `create_creature_blueprint`.

**Key principle:** Pick ANY source creature for its **appearance** (visual model). Then independently set **combat role** via classes, feats, spells, and equipment. A goblin shaman is a goblin body with Wizard class, spell-like abilities, and robes. A skeleton warrior is a skeleton body with Fighter class, weapon feats, and a sword.

**For each creature, call `create_creature_blueprint` with:**
- `sourceResref` — base game creature for appearance (see Reference Tables)
- `resref` — `hos_[type]` or `boss_[name]` (max 16 chars)
- `tag` — same as resref
- `name` — display name (e.g., "Goblin Warrior", "Skeleton Mage")
- `faction` — **always `"1"`** (Hostile)
- `lootable` — **always `true`** (hostile creatures must leave lootable corpses so players can take their equipment)
- `cr` — challenge rating scaled to target level (see Stat Scaling)
- `hp` — hit points scaled to difficulty tier
- `str`, `dex`, `con`, `int`, `wis`, `cha` — ability scores by role
- `naturalAC` — for monsters without armor
- `classes` — JSON array setting the combat class
- `feats` — JSON array of feat IDs for combat style
- `spells` — JSON array of spell-like abilities (for casters/healers)
- `equipment` — JSON object mapping slots to base game item resrefs (for humanoids)

**Equipment rules:**
- **Melee fighters:** weapon (righthand) + shield (lefthand) + armor (chest). Most use swords and shields. Mix in maces, axes, warhammers for variety.
- **Ranged fighters:** bow (righthand) + light armor (chest). No shield.
- **Casters:** staff or dagger (righthand) + robes (chest). No shield.
- **Healers:** mace or morningstar (righthand) + shield (lefthand) + medium armor (chest).
- **Tanks:** greatsword/greataxe (righthand, two-handed so no lefthand) + heavy armor (chest).
- **Monsters** (non-humanoid): No equipment — use `naturalAC` instead of armor, rely on stats and spells.

**Magic item guidelines:**
- **Standard enemies:** Mundane equipment only.
- **Elite enemies:** Minor magic items (+1 weapons or armor). Only 1-2 magic items per creature. Use base game magic item resrefs (e.g., `nw_wswmls002` for a +1 longsword).
- **Bosses:** Moderate magic items (+1 to +2). 2-3 magic items. Magic items should not exceed the wielder's power level.
- **Custom enchanted items:** When base game magic items don't fit the theme, create custom enchanted items with `create_item_blueprint` using `sourceResref` + `properties`:
  ```
  create_item_blueprint(
    resref: "hos_flmswd",
    tag: "HOS_FLMSWD",
    name: "Blazing Longsword",
    baseItem: "4",
    sourceResref: "nw_wswls001",
    properties: '[{"propertyName": 56, "subType": 0, "costTable": 2, "costValue": 1}, {"propertyName": 16, "subType": 6, "costTable": 2, "costValue": 2}]'
  )
  ```
  Common property IDs: `56`=Enhancement Bonus (costValue=bonus), `16`=Damage Bonus (subType=damage type, costValue=dice), `0`=Ability Bonus, `20`=Damage Resistance.
  Always set the `description` parameter on custom enchanted items — 1-2 sentences describing the enchantment and tying it to the adventure's plot or the creature who wields it (e.g., `"A frost-rimed blade carried by the Blackgrove's cursed guardian. Cold radiates from the steel."`). These items become player loot on kill, so their descriptions should feel rewarding to read.
- All magic items equipped on creatures are noted in adventure.md for `/adventure-rewards` to analyze as potential player loot.

---

### Phase 6: Place Hostile Creatures

**Idempotency check:** Before placing creatures in an area, call `get_area_creatures(area: "...")` and check if hostile creatures (faction 1) with the same tag are already placed. If they are, **skip placement** for those creatures — do not place duplicates.

Place each creature blueprint directly with `place_creature`. Do NOT use encounter blueprints or `place_encounter` — place all hostiles individually for precise tactical control.

**Placement rules:**
- Place on **walkable tiles** with `walkablePercent` > 50%
- **Don't overlap** existing objects (check `objects` array from `visualize_area`)
- **Group creatures together** — patrol members within 2-3 tiles of each other
- **Guards near doors/objectives** — within 1-2 tiles of what they're guarding
- **Boss in the climax area** — center or back of the final room, adds flanking
- **Vary facing** — guards face toward approaches, patrols face their route direction

**Tactical positioning:**
- Melee fighters in front (closer to doors/entrances)
- Casters/healers behind melee (deeper in rooms, 2-3 tiles back)
- Ranged fighters at elevated or distant positions
- Boss surrounded by adds, not clustered on same tile

**Coordinate calculation:** Tile center = `tile_x * 10.0 + 5.0`, `tile_y * 10.0 + 5.0`. Offset slightly (±1-2 units) for natural placement. Don't place exactly on tile center if other objects are there.

---

### Phase 7: Place Traps

**Idempotency check:** Before placing traps in an area, call `get_area_triggers(area: "...")`. If a trigger with the same tag is already placed, **skip** it.

For each trap location identified in the plan, create a script and place a trigger.

**Step 1: Write trap script** with `write_script`:

```nwscript
// a_trap_fire.nss — fire trap
void main() {
    object oPC = GetEnteringObject();
    if (!GetIsPC(oPC)) return;
    ApplyEffectToObject(DURATION_TYPE_INSTANT,
        EffectDamage(d6(2), DAMAGE_TYPE_FIRE), oPC);
    ApplyEffectToObject(DURATION_TYPE_INSTANT,
        EffectVisualEffect(VFX_IMP_FLAME_M), oPC);
}
```

**Step 2: Create trap blueprint** — Use `create_trap_blueprint` to create a dedicated trap trigger with detection/disarm DCs and the script pre-assigned:

```
create_trap_blueprint(
  resref: "trap_fire_01",
  tag: "trap_fire_01",
  name: "Fire Trap",
  scriptOnEnter: "a_trap_fire",
  detectDC: "15",
  disarmDC: "15",
  oneShot: true,
  size: "3.0"
)
```

**Step 3: Place trap** — Use `place_trigger` with the created blueprint:
```
place_trigger(area: "dungeon", blueprint: "trap_fire_01", x: "55.0", y: "45.0")
```

**Trap types:**

| Type | Damage | VFX | Script name |
|------|--------|-----|-------------|
| Fire | `d6(2)` fire | `VFX_IMP_FLAME_M` | `a_trap_fire` |
| Acid | `d6(2)` acid | `VFX_IMP_ACID_L` | `a_trap_acid` |
| Frost | `d6(2)` cold | `VFX_IMP_FROST_L` | `a_trap_frost` |
| Shock | `d6(2)` electrical | `VFX_IMP_LIGHTNING_S` | `a_trap_shock` |
| Poison | `d4(1)` + ability damage | `VFX_IMP_POISON_L` | `a_trap_poison` |
| Spike | `d6(3)` piercing | `VFX_COM_BLOOD_CRT_RED` | `a_trap_spike` |

Scale damage with target level:
- Level 1-3: `d6(1)` to `d6(2)`
- Level 4-6: `d6(2)` to `d6(3)`
- Level 7-10: `d6(3)` to `d6(4)`

**Trap placement guidelines:**
- Corridors and chokepoints (where players MUST walk through)
- In front of treasure or quest objectives
- Maximum 2-3 traps per area — don't overdo it
- Space traps apart (not back-to-back)
- Skip traps in safe areas (inn, town)

---

### Phase 7b: Patrol Paths

Some creatures should patrol rather than stand still. NWN's default AI walks creatures between waypoints tagged `WP_<creature_tag>_01`, `WP_<creature_tag>_02`, etc.

**When to add patrols:**
- **Guards:** 2-3 waypoints in a tight route (pacing a gate, walking a corridor). Spread: 2-4 tiles.
- **Animals/wildlife:** 3-5 waypoints across a wider area (dog roaming a clearing, deer through the forest). Spread: 5-10+ tiles — animals move around.
- **Dungeon patrols:** 2-4 waypoints along a corridor beat. Spread: 3-6 tiles.
- **Stationary creatures:** No patrol. Boss creatures, ambush creatures, and shopkeepers stay put.

**Flood fill constraint:** ALL patrol waypoints must be in the **same walkable zone** as the creature. Use `visualize_area` zone data to verify. A waypoint across a wall or in a disconnected zone means the creature gets stuck at the wall edge.

**Setup for each patrolling creature:**

1. Place waypoints along the patrol route:
```
place_waypoint(area: "forest", tag: "WP_goblin_patrol_01_01", name: "Patrol 1", x: "45.0", y: "35.0")
place_waypoint(area: "forest", tag: "WP_goblin_patrol_01_02", name: "Patrol 2", x: "55.0", y: "40.0")
place_waypoint(area: "forest", tag: "WP_goblin_patrol_01_03", name: "Patrol 3", x: "50.0", y: "50.0")
```

2. Ensure the creature's spawn script supports waypoint walking. Set via `modify_gff_field`:
```
modify_gff_field(resource: "<area>", type: "git", path: "Creature List.<index>.ScriptSpawn", value: "nw_c2_default9")
```

3. Avoid cluttering safe areas with patrol waypoints — they show up in the toolset.

---

### Phase 8: Verify

1. **`validate_module`** — check for broken references (missing scripts, items, blueprints)
2. Verify no creatures placed on top of existing objects
3. Verify all scripts compiled successfully

Fix any issues before proceeding.

---

### Phase 9: Update adventure.md

Append a `## Challenges` section to `adventure.md`:

```markdown
## Challenges

### [Area Name] (`resref`)

**Hostile Creatures:**
- **[Display Name]** (`hos_resref`, CR [N], HP [N]) at (x, y) — [role: melee/caster/healer/ranged/boss]. Source: `source_blueprint`. Class: [Fighter/Wizard/Cleric] [N]. Equipment: [weapon + armor summary].
...

**Traps:**
- **[Trap Name]** (`trap_tag`) at (x, y) — [effect]. Script: `a_trap_name`. Damage: [dice].
...

**Magic Items on Creatures:**
- **[Item Name]** (`item_resref`) on [creature name] — [slot]. [Brief description of properties].
...

**Difficulty:** Target level [N], area CR range [min]-[max]. Groups: [count] groups of [sizes].
```

### [Next Area] (`resref`)
...

**Faction:** All hostile creatures set to Hostile (ID 1).
```

This data is used by downstream skills:
- `/adventure-affordances` uses creature equipment to plan loot drops and merchant stock
- `/adventure-rewards` uses CR data and creature count to assign quest XP and determine reward item value

---

### Phase 10: Repack

Call `repack_module()` to save all changes.

---

## Stat Scaling

Scale creature stats based on the adventure's target level. Appearance is independent — a beholder can be CR 2 with reduced stats.

### By Difficulty Tier

**Target level 1-3:**

| Tier | CR | HP | Primary Stat | Secondary Stats | Natural AC |
|------|-----|------|-------------|-----------------|------------|
| Minion | 0.5-1 | 6-12 | 12-13 | 10-11 | 0-1 |
| Standard | 1-2 | 12-20 | 13-14 | 10-12 | 1-2 |
| Elite | 2-3 | 20-30 | 14-16 | 11-13 | 2-3 |
| Boss | 3-4 | 30-45 | 16-18 | 12-14 | 3-5 |

**Target level 4-6:**

| Tier | CR | HP | Primary Stat | Secondary Stats | Natural AC |
|------|-----|------|-------------|-----------------|------------|
| Minion | 2-3 | 15-25 | 14-15 | 10-12 | 1-2 |
| Standard | 3-5 | 25-40 | 15-16 | 11-13 | 2-3 |
| Elite | 5-6 | 40-55 | 16-18 | 12-14 | 3-4 |
| Boss | 6-8 | 55-75 | 18-20 | 14-16 | 4-6 |

**Target level 7-10:**

| Tier | CR | HP | Primary Stat | Secondary Stats | Natural AC |
|------|-----|------|-------------|-----------------|------------|
| Minion | 4-6 | 25-40 | 15-16 | 11-13 | 2-3 |
| Standard | 6-8 | 40-55 | 16-18 | 12-14 | 3-4 |
| Elite | 8-10 | 55-75 | 18-20 | 14-16 | 4-6 |
| Boss | 10-12 | 75-100 | 20-22 | 16-18 | 6-8 |

**Primary stat** = the stat most relevant to the role (STR for melee, DEX for ranged, INT for wizard, WIS for cleric, CHA for sorcerer). **Secondary stats** = everything else.

### By Combat Role

| Role | Class | Level | Primary | Key Stats | Notes |
|------|-------|-------|---------|-----------|-------|
| Melee | Fighter (4) | = target | STR | High STR, medium CON/DEX | Sword + shield |
| Tank | Barbarian (0) | = target | STR | Highest STR+CON, low DEX | Two-hander, heavy armor |
| Ranged | Ranger (7) | = target | DEX | High DEX, medium STR/CON | Bow, light armor |
| Caster | Wizard (10) or Sorcerer (9) | = target | INT or CHA | High casting stat, low physical | Robes, staff |
| Healer | Cleric (2) | = target | WIS | High WIS, medium STR/CON | Mace + shield, medium armor |

---

## Combat Role Templates

### Melee Fighter
```
classes: [{"class": 4, "level": <target>}]
feats: [<WeaponProfMartial>, <ArmorProfHeavy>, <ShieldProf>, <PowerAttack>, <WeaponFocus>]
spells: (none)
equipment: {"righthand": "<sword/mace>", "lefthand": "<shield>", "chest": "<armor>"}
```

### Tank (Two-Hander)
```
classes: [{"class": 0, "level": <target>}]
feats: [<WeaponProfMartial>, <ArmorProfHeavy>, <PowerAttack>, <Cleave>, <Toughness>]
spells: (none)
equipment: {"righthand": "<greatsword/greataxe>", "chest": "<heavy armor>"}
```

### Ranged Fighter
```
classes: [{"class": 7, "level": <target>}]
feats: [<WeaponProfMartial>, <ArmorProfLight>, <PointBlankShot>, <RapidShot>]
spells: (none)
equipment: {"righthand": "<longbow/shortbow>", "chest": "<leather>"}
```

### Caster (Wizard)
```
classes: [{"class": 10, "level": <target>}]
feats: [<WeaponProfSimple>, <CombatCasting>, <SpellFocusEvoc>]
spells: [{"spell": <MagicMissile>, "level": <target>}, {"spell": <Fireball>, "level": <target>}]
equipment: {"righthand": "<quarterstaff/dagger>", "chest": "<robes>"}
```

### Healer (Cleric)
```
classes: [{"class": 2, "level": <target>}]
feats: [<WeaponProfSimple>, <ArmorProfMedium>, <ShieldProf>, <CombatCasting>]
spells: [{"spell": <CureLightWounds>, "level": <target>}, {"spell": <HoldPerson>, "level": <target>}]
equipment: {"righthand": "<mace/morningstar>", "lefthand": "<shield>", "chest": "<chainmail/scale>"}
```

### Monster (Non-Humanoid)
```
classes: [{"class": 4, "level": <target>}]  (or appropriate)
feats: [<Toughness>]
spells: [<as needed by creature theme>]
equipment: (none — use naturalAC instead)
naturalAC: <scaled to tier>
```

---

## Creature Source Blueprints (by Theme)

Pick for **appearance only** — stats, class, feats, spells, and equipment are set independently. Don't limit choices by source CR. A beholder with CR 2 is perfectly valid.

> **These resref lists are quick-reference examples, not exhaustive catalogs.**
> If no suitable blueprint is found in these lists, call `list_blueprints(type: "utc", pattern: "[search term]")` to search the full base game and HAK stack by resref, tag, and display name (including TLK-resolved names). Always prefer a thematic match from the full catalog over forcing a poor fit from the examples.

### Undead

| Description | Resref | Notes |
|------------|--------|-------|
| Skeleton | `nw_skeleton` | Classic undead warrior |
| Skeleton (small) | `nw_s_skeleton` | Smaller variant |
| Zombie | `nw_zombie01` | Shambling undead |
| Zombie (variant) | `nw_zombie02` | Alternate zombie model |
| Zombie boss | `nw_zombieboss` | Larger zombie |
| Ghoul | `nw_ghoul` | Fast undead |
| Ghast | `nw_ghast` | Tougher ghoul |
| Shadow | `nw_shadow` | Incorporeal undead |
| Wight | `nw_wight` | Armored undead |
| Wraith | `nw_wraith` | Ghostly undead |
| Mummy | `nw_mummy` | Bandaged undead |
| Lich | `nw_lich` | Skeletal spellcaster |
| Doom Knight | `nw_doomkght` | Armored undead knight |

### Beasts

| Description | Resref | Notes |
|------------|--------|-------|
| Wolf | `nw_wolf` | Forest predator |
| Dire Wolf | `nw_direwolf` | Larger wolf |
| Winter Wolf | `nw_wolfwint` | Frost-themed wolf |
| Bear | `nw_bear` | Brown bear |
| Dire Bear | `nw_direbear` | Enormous bear |
| Boar | `nw_boar` | Aggressive pig |
| Giant Spider | `nw_spider` | Web-spinning arachnid |
| Spider (boss) | `nw_spiderboss` | Larger spider |
| Stag Beetle | `nw_beetlestag` | Giant insect |
| Bombardier Beetle | `nw_beetlebomb` | Acid-spitting insect |

### Humanoid Enemies

| Description | Resref | Notes |
|------------|--------|-------|
| Goblin | `nw_goblina` | Small green-skinned |
| Goblin (alt) | `nw_goblinb` | Alternate model |
| Goblin boss | `nw_goblinboss` | Goblin leader |
| Goblin chief | `nw_goblchf01` | Stronger leader |
| Goblin wizard | `nw_goblwiza` | Caster appearance |
| Hobgoblin | `nw_hobgoblin001` | Larger goblinoid |
| Orc | `nw_orca` | Green-skinned brute |
| Orc (alt) | `nw_orcb` | Alternate model |
| Orc chief | `nw_orcchiefa` | Orc leader |
| Orc boss | `nw_orcboss` | Strongest orc |
| Orc wizard | `nw_orcwiza` | Orc caster |
| Bugbear | `nw_bugbear` | Hairy goblinoid |
| Gnoll | `nw_gnoll` | Hyena-headed |
| Bandit | `nw_bandit001` | Human outlaw |
| Kobold | `nw_kobold001` | Small reptilian |

### Dungeon / Large

| Description | Resref | Notes |
|------------|--------|-------|
| Ogre | `nw_ogre01` | Giant humanoid |
| Ogre boss | `nw_ogreboss` | Larger ogre |
| Ogre mage | `nw_ogremage01` | Spellcasting ogre |
| Troll | `nw_troll` | Regenerating giant |
| Troll boss | `nw_trollboss` | Larger troll |
| Minotaur | `nw_minotaur` | Bull-headed |
| Gargoyle | `nw_gargoyle` | Winged stone creature |
| Golem (iron) | `nw_golemirn` | Construct |
| Golem (stone) | `nw_golemstn` | Construct |
| Golem (clay) | `nw_golemclay` | Construct |
| Ettercap | `nw_ettercap` | Spider-like humanoid |

### Outsiders / Planar

| Description | Resref | Notes |
|------------|--------|-------|
| Imp | `nw_imp` | Tiny devil |
| Quasit | `nw_quasit` | Tiny demon |
| Hell Hound | `nw_hellhound` | Fiery dog |
| Succubus | `nw_succubus` | Shapechanger demon |
| Balor | `nw_balor` | Major demon |
| Pit Fiend | `nw_pitfiend` | Major devil |

### Dragons / Reptiles

| Description | Resref | Notes |
|------------|--------|-------|
| Lizardfolk | `nw_lizard001` | Reptilian humanoid |
| Yuan-Ti | `nw_yuan_ti001` | Serpent folk |
| Wyrmling (white) | `nw_wyrmwhite` | Baby dragon |
| Young dragon | `nw_drgblue001` | Adolescent dragon |

**If the appearance you need isn't listed:** Use `resman_search(pattern="nw_[creature]")` to find alternatives. Or use `search_2da(table="appearance", column="LABEL", value="[creature_type]")` to find appearance row IDs, then create from scratch without `sourceResref` and set the `appearance` field.

---

## Equipment Reference

### Weapons

Use `resman_search(pattern="nw_w")` to find specific weapons. Common patterns:

| Weapon | Mundane Resref | Magic +1 | Notes |
|--------|---------------|----------|-------|
| Longsword | `nw_wswls001` | `nw_wswmls002` | Most common sword |
| Shortsword | `nw_wswss001` | `nw_wswmss002` | Light sword |
| Battleaxe | `nw_waxbt001` | `nw_waxmbt002` | One-handed axe |
| Mace | `nw_wblml001` | `nw_wblmml002` | Blunt weapon |
| Morningstar | `nw_wblms001` | `nw_wblmms002` | Spiked mace |
| Warhammer | `nw_wblhw001` | `nw_wblmhw002` | Hammer |
| Dagger | `nw_wswdg001` | `nw_wswmdg002` | Small blade |
| Greatsword | `nw_wswgs001` | `nw_wswmgs002` | Two-handed sword |
| Greataxe | `nw_waxgr001` | `nw_waxmgr002` | Two-handed axe |
| Halberd | `nw_wplhb001` | `nw_wplmhb002` | Polearm |
| Quarterstaff | `nw_wdbqs001` | `nw_wdbmqs002` | Two-handed staff |
| Longbow | `nw_wbwln001` | `nw_wbwmln002` | Ranged |
| Shortbow | `nw_wbwsh001` | `nw_wbwmsh002` | Ranged (light) |
| Light Crossbow | `nw_wbwxl001` | `nw_wbwmxl002` | Ranged (mechanical) |

### Armor

| Armor | Mundane Resref | Magic +1 | AC Bonus |
|-------|---------------|----------|----------|
| Cloth/Robes | `nw_cloth001` | — | 0 |
| Padded | `nw_aarcl001` | `nw_maarcl001` | 1 |
| Leather | `nw_aarcl004` | `nw_maarcl025` | 2 |
| Studded Leather | `nw_aarcl005` | `nw_maarcl026` | 3 |
| Chain Shirt | `nw_aarcl008` | `nw_maarcl029` | 4 |
| Chainmail | `nw_aarcl009` | `nw_maarcl030` | 5 |
| Scale Mail | `nw_aarcl006` | `nw_maarcl027` | 4 |
| Half-Plate | `nw_aarcl011` | `nw_maarcl032` | 7 |
| Full Plate | `nw_aarcl012` | `nw_maarcl033` | 8 |

### Shields

| Shield | Mundane Resref | Magic +1 |
|--------|---------------|----------|
| Small Shield | `nw_ashsw001` | `nw_ashmsh002` |
| Large Shield | `nw_ashlw001` | `nw_ashmlw002` |
| Tower Shield | `nw_ashto001` | `nw_ashmto002` |

**If a resref doesn't resolve:** Use `resman_search(pattern="nw_wswls")` or similar to find the correct variant. Item naming conventions vary. The skill should verify items resolve before using them in equipment.

---

## Faction Rules

- **ALL hostile creatures use faction 1 (Hostile).** No exceptions.
- Always set `faction="1"` in `create_creature_blueprint`.
- Standard NWN factions: 0=PC, 1=Hostile, 2=Commoner, 3=Merchant, 4=Defender.
- **No custom factions.** Out of scope for a one-shot module.
- Ambient creatures (non-hostile) were placed by `/adventure-actors` with faction 2 — don't touch them.

---

## Naming Conventions

| Resource | Pattern | Example | Max Length |
|----------|---------|---------|-----------|
| Hostile creature | `hos_[type]` | `hos_gobwar` | 16 chars |
| Boss creature | `boss_[name]` | `boss_chief` | 16 chars |
| Trap script | `a_trap_[type]` | `a_trap_fire` | 16 chars |

**Keep type names to 5-9 characters** to stay within the 16-char resref limit after prefixes.

Differentiate similar creatures with a numeric suffix: `hos_gobwar`, `hos_gobmag`, `hos_gobheal`. For variants of the same role: `hos_gobwar1`, `hos_gobwar2`.

---

## Important Notes

- **Tile coordinates:** Column = x (left to right), Row = y (bottom to top). World position = tile * 10.0 + 5.0 for center.
- **Do NOT auto-export HTML reports.**
- **Always set faction=1.** Every hostile creature must be faction 1.
- **Appearance ≠ stats.** Pick source creatures for visual theme, then set stats independently. A beholder can be CR 2.
- **Group roles for variety.** Every group of 3+ should have at least 2 different roles. Most enemies use melee (sword + shield), but include variety.
- **Equipment only on humanoids.** Non-humanoid creatures (spiders, undead skeletons, beasts) use `naturalAC` instead of armor and rely on claws/bites, not weapons.
- **Verify item resrefs resolve.** If `resman_search` doesn't find an expected item, try alternate resref patterns or substitute a similar item.
- **Repack after all changes.** Call `repack_module` at the end so the user can see changes in the toolset.
- **No quest logic.** Don't modify dialogs, journal entries, or quest state. That's `/adventure-quests`'s job (already done).
- **No loot or XP.** Don't place items on the ground or assign XP values. That's `/adventure-affordances` and `/adventure-rewards`.
- **Scale damage to level.** Trap damage and creature stats should match the adventure's target level.
- **Magic items are loot.** Equipped magic items on defeated creatures become player loot. Note all magic items in adventure.md for `/adventure-rewards` analysis. Don't make magic items more powerful than the creature that carries them.
- **Post-placement equipment changes.** If you need to tweak a placed creature's equipment (e.g., giving the boss a special weapon), use `set_creature_equipment(area: "[area]", tag: "[tag]", equipment: '{"righthand": "nw_wswmls002"}')`. This merges with existing equipment by default.
- **Difficulty calibration.** Use `suggest_encounter(partyLevel: "[level]", partySize: "1", difficulty: "medium")` to get CR-appropriate creature suggestions and validate your encounter compositions against XP budgets.
