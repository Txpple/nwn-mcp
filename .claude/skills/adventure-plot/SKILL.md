---
name: adventure-plot
description: Sub-skill of /create-adventure. Generates a structured adventure document (adventure.md) from a high-level creative prompt. Produces the narrative blueprint that all downstream skills reference.
allowed-tools: Bash(echo *), Read, Grep, Glob
---

# Plot

Sub-skill of `/create-adventure`. Takes a creative prompt (theme, level range, tone) and generates a complete structured adventure document at `adventure.md`. All downstream skills read from this file.

## Prerequisites

- The module should already be loaded (created by the `/create-adventure` orchestrator during pre-flight).
- `adventure.md` already exists in the MCP temp directory with the `# Adventure: [Title]` heading and `## Module` section. This skill appends the `## Plot` section to it.

## File Location

`adventure.md` is in the **MCP temp directory**: `$MCP_FOLDER_TEMP` (defaults to `$TEMP/nwn-mcp` or `/tmp/nwn-mcp`). Read the existing file first, then rewrite it with the full content (preserving the existing heading and module section).

## Workflow

Fully autonomous. Generate all narrative content from the user's creative prompt — do NOT ask the user for input.

---

### Pre-Check: Validate adventure.md

Read `adventure.md` from the MCP temp directory. Verify these sections exist and are non-empty:
- `## Module`

If any required section is missing or contains no content below its heading:
**STOP.** Output: `"ERROR: adventure.md is missing required section [name]. The prerequisite skill has not run or failed. Cannot proceed."`

---

### Phase 1: Understand Context

- Read the existing `adventure.md` to get the title, module metadata, and target level.
- Call `get_module_summary` to understand the loaded module state.
- Call `list_areas` to see what locations already exist.
- Call `list_tilesets` to understand what spatial environments are available. This informs what kinds of locations are buildable (forest, dungeon, crypt, city, interior, castle, etc.). Do NOT design locations that require tilesets or terrain types that don't exist.

---

### Phase 2: Generate the Adventure

Rewrite `adventure.md` preserving the existing `# Adventure: [Title]` heading and `## Module` section, then appending the full `## Plot` section using the structure below. Every section is required — downstream skills depend on specific headings and field names.

---

### Phase 3: Report

After writing the file, briefly summarize what was generated:
- Adventure title
- Number of locations
- Number of key NPCs
- Primary quest summary
- Tone and target level

---

## Adventure Document Structure

The file MUST use this exact structure. Downstream skills parse by heading name.

```markdown
# Adventure: [Title]

## Module
- **Title:** [The adventure title as a proper name, e.g., "The Harvest of Bones"]
- **Filename:** [kebab-case filename without extension, e.g., "the-harvest-of-bones"]
- **Target Level:** [e.g., 3, or 2-4]
- **Tone:** [dark / lighthearted / mysterious / epic / grim / whimsical]
- **Estimated Duration:** [short (~1hr) / medium (~2-3hr) / long (~4hr+)]

## Plot

### Premise
[2-3 paragraphs. What is happening in this place? Why are the adventurers here?
What is at stake? Set the scene and establish the central conflict.]

### Locations

#### 1. [Location Name]
- **Resref:** [lowercase, no spaces, max 16 chars — e.g., darkforest, inn_upper]
- **Type:** [interior / exterior]
- **Environment:** [terrain/biome keywords — forest, crypt, village, cave, castle, swamp, etc.]
- **Mood:** [eerie / bustling / oppressive / serene / tense / foreboding]
- **Scale:** [small / medium / large — abstract size hint, the areas skill determines actual tile dimensions]
- **Description:** [What does this area look like spatially? Key landmarks, terrain features,
  notable structures. Think about what the player sees and navigates.]
- **Role in Story:** [Why does this location matter? What happens here plot-wise?]

#### 2. [Next Location]
...

### Connections
[Area-to-area transition graph. Each connection on its own line.]
- [Area A] <-> [Area B] via [transition type: door, cave mouth, path, stairs, trapdoor, etc.]
- [Area B] <-> [Area C] via [transition type]

### Key NPCs

#### [NPC Name]
- **Race/Appearance:** [e.g., elderly human male, scarred half-orc woman]
- **Role:** [quest giver / ally / villain / merchant / informant / bystander]
- **Location:** [which area they're found in]
- **Motivation:** [what do they want?]
- **Personality:** [how do they speak and act? 1-2 sentences]
- **Quest Involvement:** [what part do they play in objectives?]

#### [Next NPC]
...

### Antagonists
- **Type:** [creature types, factions, or named individuals]
- **Motivation:** [why do they oppose the player? Make it more than "evil"]
- **Escalation:** [how does the threat increase through the adventure?]
- **Lair/Territory:** [which areas are they concentrated in?]

### Quest Objectives

#### Primary Quest: [Quest Name]
[Brief description of the overall goal]

**Stage 1: [Stage Name]**
- **Trigger:** [what starts this stage — talking to NPC, entering area, finding item]
- **Description:** [what the player needs to do]
- **Completion:** [what resolves this stage]

**Stage 2: [Stage Name]**
...

**Stage 3 (Resolution): [Stage Name]**
...

#### Side Quest: [Quest Name] (optional)
- **Trigger:** [how the player discovers this]
- **Description:** [what's involved]
- **Completion:** [how it resolves]
- **Reward Hint:** [what the player gets — XP, item, ally, information]

### Challenges
- **Combat Encounters:** [types of enemies per area, rough difficulty relative to target level.
  Specify creature types that exist in the NWN base game palette.]
- **Puzzles/Obstacles:** [non-combat challenges — locked doors, riddles, environmental hazards]
- **Social Encounters:** [NPC interactions that can go multiple ways — persuasion, deception, intimidation]
- **Environmental Hazards:** [traps, terrain dangers, timed events]

### Loot & Economy
- **Key Items:** [plot-critical items — keys, quest tokens, mcguffins. Include name and brief description.]
- **Notable Rewards:** [interesting equipment or items the player can earn]
- **Merchants:** [any shops, what they sell thematically — potions, weapons, supplies]
```

---

## Creative Guidelines

Follow these principles when generating content:

- **Location count: 2-5 areas.** One-shot adventures work best with focused scope. 3 is the sweet spot.
- **Every area earns its place.** Each location should serve the plot — don't add areas just for padding.
- **NPCs have distinct voices.** Give each NPC a clear personality and motivation. Avoid generic quest-givers.
- **Quest flow routes through all areas.** The primary quest should take the player through every location.
- **Challenges escalate.** Early areas have easier encounters; the climax area has the hardest.
- **Include non-combat solutions.** At least one major obstacle should be solvable through dialogue, cleverness, or exploration rather than fighting.
- **Antagonist depth.** The villain or opposing force should have understandable (if not sympathetic) motivations.
- **Key items have character.** Name them, describe them, tie them to the narrative. "Elara's Locket" not "quest item 3".
- **Use NWN base game creatures.** Reference creature types that exist in the game palette (goblins, skeletons, wolves, bandits, zombies, etc.) rather than inventing creatures that can't be placed.
- **Terrain keywords must be buildable.** Only describe environments that NWN tilesets can represent. Check `list_tilesets` output — if no tileset has "lava" terrain, don't design a lava area.
- **Resrefs are permanent identifiers.** Choose descriptive, stable resrefs for locations (max 16 chars, lowercase, no spaces). These become area filenames in the module.

## Important Notes

- This skill produces a DOCUMENT, not module content. It does not create areas, place creatures, or write scripts. Those are handled by downstream skills.
- The `## Plot` section heading and all `###` sub-headings must be preserved exactly — `/adventure-areas` and other skills parse them by name.
- If extending an existing module, incorporate existing areas and content into the plot rather than ignoring them.
- The adventure document is the single source of truth for the entire pipeline. Be thorough.
