---
name: adventure-polish
description: Sub-skill of /create-adventure. Reads the plot, areas, environment, actors, quests, challenges, and affordances from adventure.md and performs a consistency pass — fixing gaps, validating references, checking connectivity, and verifying quest completability. Fully autonomous, no user interaction.
allowed-tools: Bash(echo *), Read, Grep, Glob
---

# Polish

Sub-skill of `/create-adventure`. Reads all sections of `adventure.md` and systematically audits the built module for inconsistencies, broken references, and gameplay blockers. **Fixes problems as it finds them.** This is a cross-cutting pass — every prior skill's output is treated as a source of potential issues. Downstream skill (`/adventure-rewards`) uses the corrected module state to assign final XP and loot values.

## Prerequisites

- `adventure.md` must exist in the MCP temp directory (`$MCP_FOLDER_TEMP`, defaults to `$TEMP/nwn-mcp` or `/tmp/nwn-mcp`) and contain completed `## Plot`, `## Areas`, `## Environment`, `## Actors`, `## Quests`, `## Challenges`, and `## Affordances` sections.
- A module must be loaded. If none is loaded, call `load_module` using the module name from `adventure.md`.

## Workflow

Fully autonomous. Investigate → identify issues → fix them. Do NOT ask the user for input.

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
- `## Affordances`

If any required section is missing or contains no content below its heading:
**STOP.** Output: `"ERROR: adventure.md is missing required section [name]. The prerequisite skill has not run or failed. Cannot proceed."`

---

### Phase 1: Read Adventure Context

Read `adventure.md` in full. Build a master reference of expected module elements:

**From `## Plot`:**
- Module name, target level, tone
- All named locations (each should be an area)
- All named NPCs and their roles (quest giver, villain, merchant, etc.)
- Main quest objective and win condition
- Expected antagonist types

**From `## Areas`:**
- List of all areas: resref, name, tileset, dimensions
- All documented door/transition links (from area A to area B)
- Which areas are safe vs dangerous

**From `## Actors`:**
- All NPC resrefs, tags, dialog resrefs, positions, areas
- Ambient creature placements

**From `## Quests`:**
- Quest tags, journal entry IDs
- All condition scripts (`c_q*`) and action scripts (`a_q*`)
- Quest items (`qi_*`) and where they originate or are picked up
- NPC dialogs modified: which DLGs, how many root entries added, scripts attached

**From `## Challenges`:**
- Hostile creature resrefs, areas, positions
- Trap script names

**From `## Affordances`:**
- Store resref, area, NPC it's attached to
- Store-open script name
- Container loot placements
- Module start script name and IFO assignment

Compile an **issue checklist** to drive the audit. Work through each phase below and log every issue before fixing.

---

### Phase 2: Module Validation (Baseline)

Run `validate_module`. Read the full output.

**Triage results:**
- **Skip** known base-game false positives: scripts like `nw_c2_default*`, `nw_ch_ac*`, `nw_i0_*`, items like `nw_wblms001`. These resolve at runtime from game BIFs.
- **Fix** everything else: missing scripts, missing dialogs, missing blueprints, unresolvable resrefs.

Common fixable validation errors:

| Error type | Likely cause | Fix |
|------------|-------------|-----|
| Missing script `a_q*` or `c_q*` | Script wasn't compiled or resref typo in DLG | Re-run `write_script` or correct the DLG field |
| Missing dialog `dlg_*` or `qdlg_*` | Dialog not created | Create with `create_dialog` |
| Missing item blueprint `qi_*` | Quest item not created | Create with `create_item_blueprint` |
| Missing creature blueprint `hos_*` | Creature not created | Create with `create_creature_blueprint` |
| Missing store blueprint `str_*` | Store not created | Create with `clone_resource` + `modify_gff_field` |
| Missing script on module IFO | `Mod_OnClientEntr` pointing to nonexistent script | Re-write the script with `write_script` |

After fixing all actionable errors, re-run `validate_module` to confirm the fix. Repeat until no actionable errors remain.

---

### Phase 3: Area Connectivity Audit

For each area documented in `## Areas`, check that all transitions are working.

**Step 1:** Call `check_area_connectivity` to verify all areas are reachable from the start area. If any are unreachable, check `get_area_triggers` on each area to find missing or misconfigured transition triggers.

**Step 2:** Cross-check against the transitions table in `## Areas`. Every documented transition should have triggers in both directions. Example: if area A links to area B, area B must have a return trigger linking back to area A.

**Step 3:** Fix any missing transitions with `adventure_create_transition`. Each portal is a useable blue shaft of light with a dialog — no separate visual marker needed.

**Step 4:** Verify the starting area is reachable. Check `get_module_info` for `Mod_Entry_Area` — it should point to the safe starting area (inn, town, etc.).

If `Mod_Entry_Area` is wrong or unset:
```
modify_gff_field(
  resource: "module",
  type: "ifo",
  path: "Mod_Entry_Area",
  value: "<starting_area_resref>",
  gffType: "resref"
)
```

Also verify `Mod_Entry_X`, `Mod_Entry_Y`, `Mod_Entry_Z` place the player in a walkable tile of the starting area. Use `visualize_area` to confirm a walkable tile exists at those coordinates. Fix if needed.

---

### Phase 4: Quest Completability Trace

**Step 0: Automated verification** — Call `verify_quest_completability`. This checks:
- Every journal entry has a script that sets it (`AddJournalQuestEntry`)
- Quest-giver NPCs are in reachable areas
- End entries exist for all quests

Review the output. Fix any gaps flagged as `completable: false` before proceeding to manual checks.

**Manual follow-up for each quest in `## Quests`:**

#### Step 1: Quest offer reachable?
- The quest-giver NPC must be in the starting area (or an area reachable from it without combat blockers).
- Call `get_area_creatures` on the starting area to confirm the NPC is placed there.
- If the NPC is in a dangerous area and the quest offer should be in a safe area, flag it.

#### Step 2: Dialog tree intact?
Call `flatten_dialog` on each modified dialog. Verify:
- Root entries (StartingList) are in the correct order — conditioned entries before unconditioned.
- Every condition script referenced exists (already confirmed in Phase 2).
- Every action script referenced exists.
- The unconditioned root entry is LAST in the StartingList.
- No dead-end NPC entries (NPC says something with no PC reply and no `EndConversation` marker) — these leave the player stuck.

**Dead-end check:** In `flatten_dialog` output, any NPC entry with no children and no `End: true` is a dead end. Fix by adding a PC reply that ends the conversation, using `add_dialog_node`.

#### Step 3: Quest objectives reachable?
- For fetch quests: the object/NPC to find must exist in the module. Check `search_by_tag` for the target tag.
- For kill quests: the target creature must be placed in an area reachable from the quest giver.
- For delivery quests: the recipient NPC must be accessible.

#### Step 4: Quest items obtainable?
- If a quest item (`qi_*`) is given by an NPC via `CreateItemOnObject` in an action script — verify the script exists and has the right resref.
- If a quest item is placed in a container — verify the container has the item in its `ItemList` (call `get_area_placeables` on the relevant area and check the container's data).
- If a quest item is dropped by a creature — the creature blueprint should have it in `Equip_ItemList` or on its body.

#### Step 5: Quest completion reachable?
- The turn-in NPC must be in an accessible area.
- The completion dialog branch must be condition-gated on the correct quest stage.
- The completion action script must call `AddJournalQuestEntry` with an entry that has `end: true`.

Log any gaps found and fix them.

---

### Phase 5: NPC and Dialog Integrity

For each NPC in `## Actors`:

**Step 1:** Verify the NPC is placed in the correct area. Call `get_area_creatures` on their documented area and confirm their tag is present.

**Step 2:** Verify their dialog file exists. Use `get_resource` or `flatten_dialog` — if the dialog doesn't load, it's broken.

**Step 3:** If `/adventure-affordances` added a "browse wares" option, call `flatten_dialog` and verify:
- A PC reply with store-opening text exists.
- The reply has an action script assigned.
- If the NPC has multiple condition-gated root entries (from `/adventure-quests`), the "browse wares" reply should appear under ALL of them, not just the first.

If the browse-wares reply is missing from some root entries:
```
add_dialog_node(
  dialog: "dlg_[npc]",
  parentType: "entry",
  parentIndex: "[N]",
  text: "I'd like to see what you have for sale.",
  script: "a_str_[store]"
)
```
Repeat for each root entry missing the option.

---

### Phase 6: Challenge Placement Audit

For each area marked as dangerous in `## Areas`:

**Step 1:** Call `get_area_creatures` and verify hostile creatures are present.

**Step 2:** Spot-check creature positions via `visualize_area`:
- Creatures should not overlap placeables or doors.
- Groups should be spatially coherent (within 2-3 tiles of each other).

**Step 3:** Verify the boss encounter exists in the climax area. The climax area is the deepest or final area in the quest path. If no boss-tier creature is found there, flag it.

**Step 4:** Check that safe areas (inn, starting area) have NO hostile creatures. Call `get_area_creatures` and filter for faction 1. If any hostile creatures are in a safe area by mistake, remove them with `remove_object`.

---

### Phase 7: Affordances Integrity

**Step 1: Module start script**
Call `get_module_info`. Check `Mod_OnClientEntr` — it should be set to the module start script (e.g., `a_mod_enter`).

If it's unset or set to a non-existent script:
- Check if the script exists with `read_script_source`.
- If the script doesn't exist, re-write it (see `/adventure-affordances` Phase 10 for the template).
- If it exists but isn't assigned, assign it via `modify_gff_field`.

**Step 2: Store stocked**
Call `get_store_details` on each store resref in `## Affordances`. Verify:
- `StoreGold` is set (not 0 unless intentional)
- At least one `StoreList` category has items
- No placeholder resrefs (items that don't resolve)

Run `validate_module` output again if store items look suspect — missing item blueprints will appear there.

**Step 3: Store accessible**
Call `get_area_placeables` on the area where the store is documented. Confirm the store (as a placeable or via its tag) is present.

If the store was placed but `OpenStore()` in the script uses `GetNearestObjectByTag("str_resref")`, verify the store tag matches exactly what the script looks for.

---

### Phase 8: Plot vs Module Consistency

High-level narrative checks:

**Locations:** Every location named in `## Plot` should correspond to an area in `## Areas`. If a plot location has no area, it was dropped — this may be intentional for a short module, but flag it.

**Antagonists:** The enemy types in `## Challenges` should match the antagonists described in `## Plot`. If the plot says goblins but challenges has zombies, that's a mismatch. Fix by noting it in the Polish section of adventure.md (don't rework enemies unless it's a trivial fix like a tag rename).

**NPC roles:** Every NPC named in the plot as a quest giver, villain, or key figure should appear in `## Actors` AND have the appropriate quest treatment in `## Quests`. If a plot-essential NPC is missing a quest branch, flag it.

**Win condition:** Re-read the plot's stated win condition ("defeat the villain", "recover the artifact", "rescue the prisoner"). Verify the quest completion chain actually achieves this win condition. If the final journal entry describes the adventure concluding but there's no mechanical way to trigger it (e.g., the boss can't be killed because it's faction 2 instead of 1), flag and fix it.

---

### Phase 9: Final Validation

Run `validate_module` one final time. All actionable errors should be resolved by now. Document any remaining issues in the Polish section of `adventure.md` with a note explaining why they weren't fixed (e.g., base-game false positives).

---

### Phase 10: Update adventure.md

Append a `## Polish` section to `adventure.md`:

```markdown
## Polish

### Issues Found and Fixed

**Module Validation:**
- [List each fixed validation error: type, resource, fix applied]
- (or "No actionable errors found")

**Area Connectivity:**
- [List door fixes, entry point corrections, or "All transitions verified correct"]

**Quest Completability:**
- [List dialog fixes, dead-end patches, missing item fixes, or "All quests verified completable"]

**NPC/Dialog Integrity:**
- [List browse-wares additions, dialog fixes, or "All NPC dialogs intact"]

**Challenge Placement:**
- [List creature removal (safe areas), overlap fixes, or "All creature placements correct"]

**Affordances Integrity:**
- [List store restock fixes, script assignment fixes, or "All affordances verified"]

**Plot Consistency:**
- [List narrative mismatches noted, or "Plot and module content consistent"]

### Remaining Known Issues

- [Any issues not fixed, with explanation — e.g., base-game false positives in validate_module]
- (or "None")

### Validation Status

`validate_module` final result: [N actionable errors | Clean]
```

---

### Phase 11: Repack

Call `repack_module()` to save all changes.

---

## Issue Priority

Fix in this order:

1. **Blocking** — player cannot progress: broken area transitions, inaccessible quest NPC, quest item unobtainable, no way to trigger quest completion
2. **Breaking** — module fails to load or crashes: missing scripts referenced in dialogs/IFO, unresolvable blueprints
3. **Wrong** — content works but is incorrect: hostile creature in safe area, boss missing from climax, store not stocked
4. **Minor** — small gaps: dead-end dialog node, wrong entry point coordinates, missing browse-wares on secondary root entry

Never skip Blocking or Breaking issues. Minor issues can be documented without fixing if the fix is complex and the game still works.

---

## Important Notes

- **Do NOT auto-export HTML reports.**
- **Repack after all changes.** Call `repack_module` at the end.
- **Don't rebuild what works.** If a dialog is functional but not perfect, note it — don't rewrite it.
- **Filter base-game false positives** from `validate_module`. Scripts and items from the base game BIFs (`nw_*`, `x0_*`, `x2_*`) that appear as "missing" are resolved at runtime and are NOT errors.
- **Trace, don't assume.** Use `flatten_dialog`, `get_area_creatures`, `get_area_doors` to verify — don't assume prior skills did everything correctly.
- **One fix, one verify.** After each structural fix (door link, dialog change, script write), re-check the specific thing you fixed before moving on.
- **Don't place new content.** Polish fixes existing content — it does not add new areas, creatures, placeables, or NPCs. That's `/adventure-rewards`'s job if new reward items are needed.
- **Quest XP is not set here.** Condition on quest completion scripts may call `GiveXPToCreature` — leave these amounts as-is. `/adventure-rewards` handles final XP balancing.
- **Faction validation.** Use `get_faction_details` to verify faction relationships. If a custom faction is needed but missing, use `create_faction` to add it. Use `set_faction_reputation` to fix incorrect faction relationships.
- **Bulk cleanup.** Use `bulk_remove_objects(tagPattern: "temp_*", listName: "...", dryRun: true)` to find and remove orphaned objects. Always dry-run first.
- **Undo safety net.** If a fix goes wrong, use `undo_last_change` to revert. Check `undo_history` to review recent mutations.
