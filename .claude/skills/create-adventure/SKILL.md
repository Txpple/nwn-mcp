# /create-adventure

**Master directive skill.** Given a high-level creative goal ("make me an adventure for 3rd level characters in a haunted forest"), orchestrate the full module-building pipeline by invoking sub-skills in sequence.

## Core Philosophy: Black Box Adventure Creation

The create-adventure pipeline is a **white-glove, spoiler-free experience**. The user provides a prompt and gets back a playable module — they should know **nothing** about the plot, encounters, NPCs, puzzles, or story beats. The fun is in discovering it all during play.

**Rules for the orchestrator:**
- **NEVER reveal plot details, encounter compositions, NPC names, quest objectives, puzzle solutions, or story twists to the user.** Not in status updates, not in error messages, not in progress reports.
- **Status updates must be vague and atmospheric.** Say things like *"The world is taking shape..."*, *"Populating the tavern..."*, *"Adding some surprises..."* — never *"Placing 3 goblins in the cave"* or *"Creating a quest where the blacksmith asks you to find his hammer."*
- **Sub-skills do NOT interact with the user.** They are fully autonomous. If a sub-skill encounters a judgment call (too many monsters? unclear quest flow? conflicting placements?), the **orchestrator makes the call** — it does not ask the user. This introduces creative randomness, which is part of the fun.
- **The orchestrator is the decision-maker.** When a sub-skill would normally need guidance, the orchestrator uses its own judgment. Lean toward "more fun" over "perfectly balanced." A slightly overtuned encounter or an unexpected twist is better than a bland, safe adventure.

## Pre-Flight (before invoking any sub-skill)

> **Heads up before we dive in:** Building a full adventure takes a while — typically 20–40 minutes of autonomous work across 9 phases. To avoid constant approval prompts, consider enabling **Bypass permissions** mode:
> - **Desktop/VS Code:** Settings → enable *Allow dangerously skip permissions*, then select **Bypass permissions** from the mode dropdown next to the send button.
> - **CLI:** Launch with `claude --dangerously-skip-permissions`
> - **settings.json:** Set `"permissions": { "defaultMode": "bypassPermissions" }`
>
> Once pre-flight is done, the pipeline runs completely hands-free.

Before starting the pipeline, resolve these with the user:

1. **Level range required.** The user's prompt must include a level range (e.g., "level 3-5", "for 5th level characters"). If missing, ask for one before proceeding — every downstream skill (challenges, affordances, rewards) depends on it.

2. **D&D theme check.** NWN is a D&D game with medieval fantasy tilesets, creatures, and items. If the user's prompt is non-fantasy (sci-fi, modern, etc.), warn them: *"NWN's assets are medieval fantasy — a [genre] adventure won't have matching tilesets, creatures, or items. It won't look or feel right. Want to proceed anyway?"* If they confirm, continue. Otherwise help them adjust the concept.

3. **Party size.** Ask: "How many players? (1-4, default 1)". If the user doesn't specify, default to 1.

4. **Difficulty.** Ask: "Difficulty — Normal or Hard? (default Normal)". If the user doesn't specify, default to Normal.

5. **Adventure title & module creation.** Before invoking any sub-skill:
   - Invent a compelling adventure title based on the user's prompt.
   - Pitch it to the user in a casual, enthusiastic way: *"How about **'[Title]'**? If that sounds fun, I'll create the module and we'll get started!"*
   - If the user doesn't like it, propose a different title. Keep iterating until they're happy.
   - Once the user confirms the title:
     - The module filename is the **adventure title exactly as written** — spaces, case, and all (e.g., "The Harvest of Bones" → filename `The Harvest of Bones`, which NWN saves as `The Harvest of Bones.mod`).
     - Write the initial `adventure.md` to the MCP temp directory (`$MCP_FOLDER_TEMP`, defaults to `$TEMP/nwn-mcp`) with just the heading and `## Module` section:
       ```markdown
       # Adventure: [Title]

       ## Module
       - **Title:** [The exact adventure title, e.g., "The Harvest of Bones"]
       - **Filename:** [Exact title with spaces, e.g., "The Harvest of Bones"]
       - **Target Level:** [level]
       - **Tone:** [tone]
       - **Estimated Duration:** [duration]
       - **Party Size:** [1-4]
       - **Difficulty:** [Normal/Hard]
       ```
     - Call `create_module` with both `name` and `filename` set to the **adventure title exactly as written** (e.g., `name: "The Harvest of Bones"`, `filename: "The Harvest of Bones"`). The .mod file will be saved as `The Harvest of Bones.mod`.
   - If a module is already loaded and the user wants to add to it, skip module creation.

**Once pre-flight is complete, the user's involvement is done.** From here forward, the orchestrator runs autonomously and only reports vague, spoiler-free progress.

## Sub-Skill Execution: Use the Agent Tool

**CRITICAL: Never use the `Skill` tool to invoke sub-skills during the pipeline.** The Skill tool runs inline — all of its reasoning, tool calls, and output appear directly in the user's chat, leaking spoilers. Instead, use the **Agent tool** (`subagent_type: "general-purpose"`) for every sub-skill invocation after pre-flight.

**How to invoke each sub-skill:**
1. Use the Agent tool with a prompt like: *"You are the /adventure-areas sub-skill. Read your instructions from `.claude/skills/areas/SKILL.md`, then execute them. Adventure doc: `<path>/adventure.md`. Module: `<name>`."*
2. **Do NOT read the sub-skill's SKILL.md yourself** — let the agent read its own instructions. This keeps sub-skill content out of the orchestrator's context.
3. Pass any orchestrator context the agent needs (e.g., area resrefs from prior phases) in the prompt.
4. When the agent completes, read `adventure-status.json` and `adventure.md` to check results.
5. Show ONLY the rune progress bar to the user — no tool calls, no spoilers.

### Heartbeat Messages for Long Phases

Agents run silently — the user sees nothing while an agent works. For phases that take a long time (especially `/adventure-areas`, `/adventure-environment`, `/adventure-challenges`, `/adventure-quests`), **split the work into multiple agent calls** so the orchestrator regains control between them and can print spoiler-free heartbeat messages.

**Splitting strategy:**
- **`/adventure-areas`**: One agent call per area. Between each, print: *"Shaping the land... (area 2 of 3)"*
- **`/adventure-environment`**: One agent call per area. Between each, print: *"Dressing the world... (2 of 3)"*
- **`/adventure-actors`**: One agent call for all (usually fast enough). If many NPCs, split per area.
- **`/adventure-challenges`**: One agent call per area. Between each, print: *"Placing dangers... (2 of 3)"*
- **`/adventure-quests`**: Usually one call (quest logic is cross-area). Print a single *"Weaving fates..."* before launching.
- **`/adventure-affordances`**, **`/adventure-polish`**, **`/adventure-rewards`**: One call each (fast).

When splitting a phase into per-area calls, pass the sub-skill SKILL.md each time but scope the arguments to a single area. The agent should append to `adventure.md` incrementally (or the orchestrator consolidates after all area agents finish).

**Heartbeat message rules:**
- Spoiler-free — never mention area names, NPC names, or content details
- Brief — one short line
- Include progress fraction when splitting (e.g., "2 of 3")
- Use atmospheric language, not technical language

## Purpose

The LLM does not try to do everything in one pass. Instead it decomposes the goal into phases and hands each phase to a focused sub-skill. Each sub-skill has bounded context, clear inputs, and clear outputs. The master directive sequences them, passes context forward, and makes creative judgment calls so the user never has to.

## Undo & Rollback Toolkit

The orchestrator has access to tools for correcting mistakes made by sub-skills without starting over. Use these proactively when reviewing sub-skill output:

- **`undo_last_change`** — Revert the most recent GIT mutation (object placement, removal, linking). Use when a sub-skill's last action was clearly wrong.
- **`undo_history`** — View the undo stack to see recent mutations. Use to assess how far back to roll if multiple things went wrong.
- **`remove_object`** — Remove a specific object from an area by tag or index. Use when a particular placement is bad but surrounding work is fine.
- **`bulk_remove_objects`** — Remove objects matching a tag pattern from one or all areas. Supports wildcards (e.g., `goblin_*`). Has dry-run mode. Use when an entire category of placements needs to go — this is the primary "rollback" mechanism for failed phases.
- **`remove_journal_quest` / `remove_journal_entry`** — Remove quest entries that don't fit or are broken.
- **`remove_items_from_container`** — Pull items from a container or store that shouldn't be there.
- **`clear_creature_equipment`** — Strip all equipment from a creature blueprint to re-equip it properly.

**When to use these tools:** After each sub-skill completes, the orchestrator should review the results (via `visualize_area`, `validate_module`, `flatten_dialog`, etc.). If something is off — too many creatures crowding one spot, a door that leads nowhere, a quest item placed in an unreachable area — use the remove tools to fix it before moving to the next phase. Don't let problems cascade. For wholesale phase failures, use `bulk_remove_objects` with a tag pattern to clear the phase's work and re-run the sub-skill.

## Sub-Skill Status Sidecar

Each sub-skill writes its completion status to `adventure-status.json` in the MCP temp directory (same location as `adventure.md`). The orchestrator reads this before launching the next phase.

**Format:**
```json
{
  "phases": {
    "plot": { "status": "success", "warnings": [], "errors": [] },
    "areas": { "status": "success", "warnings": ["crosser mismatch on tile 3,5 — fallback used"], "errors": [] },
    "quests": { "status": "partial", "warnings": [], "errors": ["c_q_stage2.nss failed to compile"] }
  }
}
```

**Status values:** `"success"`, `"partial"` (completed with errors), `"failed"` (could not complete).

**Orchestrator behavior:**
- Read `adventure-status.json` after each sub-skill returns.
- If `"success"`: proceed to next phase.
- If `"partial"`: review errors. If fixable (e.g., broken script), fix and continue. If cascading (e.g., missing area), halt and report.
- If `"failed"`: rollback the phase, re-run the sub-skill, or halt.
- **Compile errors are the most common "partial" case.** If a script failed to compile, the dialog/quest that references it is broken. Fix the script or remove the reference before proceeding.

**Each sub-skill is responsible for:**
1. Reading the existing `adventure-status.json` (or creating it if missing).
2. Appending its phase entry with status, warnings, and errors.
3. Writing the updated JSON back to disk.

## Sub-Skills

Each sub-skill has its own SKILL.md with full instructions. The agent reads it at runtime. The orchestrator only needs to know the phase order and what context to pass.

| Phase | Skill | Reads from adventure.md | Appends section |
|-------|-------|------------------------|-----------------|
| 1 | `/adventure-plot` | Module | `## Plot` |
| 2 | `/adventure-areas` | Module, Plot | `## Areas` |
| 3 | `/adventure-environment` | Module, Plot, Areas | `## Environment` |
| 4 | `/adventure-actors` | Module, Plot, Areas, Environment | `## Actors` |
| 5 | `/adventure-quests` | All prior | `## Quests` |
| 6 | `/adventure-challenges` | All prior | `## Challenges` |
| 7 | `/adventure-affordances` | All prior | `## Affordances` |
| 8 | `/adventure-polish` | All + module state | `## Polish` |
| 9 | `/adventure-rewards` | All | `## Rewards` |

## Orchestrator Review

Only review after two critical phases — trust `/adventure-polish` to catch everything else:

- **After /adventure-areas:** Run `check_area_connectivity`. If any area is unreachable, fix transitions before proceeding — everything downstream depends on area connectivity.
- **After /adventure-quests:** Run `verify_quest_completability`. If scripts failed to compile or quest paths are broken, fix before proceeding — later phases layer on top of quest state.

For all other phases, read `adventure-status.json`. If `"success"`, proceed. If `"partial"`, check the errors — fix compile failures, otherwise move on. If `"failed"`, re-run the sub-skill.

## Progress Bar

After each phase, show a rune progress bar. 9 runes total — ✦ for completed, ✧ for pending. Pair with a short, vague, atmospheric message (e.g., *"Lands shaped..."*, *"Dangers set..."*). Vary the wording but keep it spoiler-free.

Example after phase 3: `✦ ✦ ✦ ✧ ✧ ✧ ✧ ✧ ✧   World dressed...`

## Guiding Principles

- **Autonomy over consultation.** Make creative calls yourself. Don't ask the user. The randomness of your judgment IS the feature.
- **Fix it, don't flag it.** If a sub-skill produces something questionable, use remove tools to fix it. Don't tell the user about the problem.
- **adventure.md is the shared state.** Every sub-skill reads from it and appends to it. This is how context passes between phases.
- **Keep it moving.** Don't get stuck on minor imperfections. A delivered adventure with rough edges is better than a perfect adventure that never finishes.

## Final Delivery

When all sub-skills complete and the module is repacked, deliver a spoiler-free completion message:

> *"Your adventure **'[Title]'** is ready! No spoilers from me — go discover what awaits. Have fun!"*

Then ask:

> *"Would you like a copy of the adventure document saved to your reports folder? (Warning: it contains full spoilers!)"*

If the user says yes and `MCP_FOLDER_USERREPORTS` is set, copy the final `adventure.md` from the MCP temp directory to `$MCP_FOLDER_USERREPORTS/<AdventureTitle>.md`, where `<AdventureTitle>` is the adventure title exactly as written with spaces preserved (e.g., `The Bones Beneath.md`).

If `MCP_FOLDER_USERREPORTS` is not set, tell the user the env var isn't configured and give them the temp directory path so they can copy it manually.
