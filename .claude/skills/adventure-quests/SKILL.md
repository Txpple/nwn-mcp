---
name: adventure-quests
description: Sub-skill of /create-adventure. Reads the plot, areas, environment, and actors from adventure.md and implements quest objectives — journal entries, quest dialogs with branching, action/condition scripts. Modifies existing NPC dialogs in-place. Fully autonomous, no user interaction.
allowed-tools: Bash(echo *), Read, Grep, Glob
---

# Quests

Sub-skill of `/create-adventure`. Reads all prior sections of `adventure.md`, then implements the quest objectives defined in the plot: journal entries, quest items, condition/action scripts, and multi-stage dialog trees. **Modifies existing NPC dialogs in-place** — adds condition-gated root entries and quest conversation branches to the dialogs created by `/adventure-actors`. Downstream skills (`/adventure-challenges`, `/adventure-affordances`, `/adventure-rewards`) layer combat, loot, and XP on top.

## Prerequisites

- `adventure.md` must exist in the MCP temp directory (`$MCP_FOLDER_TEMP`, defaults to `$TEMP/nwn-mcp` or `/tmp/nwn-mcp`) and contain completed `## Plot`, `## Areas`, `## Environment`, and `## Actors` sections.
- A module must be loaded. If none is loaded, call `load_module` using the module name from `adventure.md`; it auto-routes when a Nasher project is detected.

## Workflow

Fully autonomous. Make all decisions based on the plot document and existing module state — do NOT ask the user for input.

---

### Pre-Check: Validate adventure.md

Read `adventure.md` from the MCP temp directory. Verify these sections exist and are non-empty:
- `## Module`
- `## Plot`
- `## Areas`
- `## Environment`
- `## Actors`

If any required section is missing or contains no content below its heading:
**STOP.** Output: `"ERROR: adventure.md is missing required section [name]. The prerequisite skill has not run or failed. Cannot proceed."`

---

### Phase 1: Read Adventure Context

Read `adventure.md`. Extract from all sections:

**From `## Plot`:**
- **Quest objectives** — what the player must accomplish (fetch items, talk to NPCs, explore locations, solve puzzles)
- **Key NPCs** — name, role, location, quest involvement
- **Antagonists** — who opposes the player
- **Locations** — where quest events happen
- **Challenges** — what stands between the player and objectives
- **Loot & Economy** — any quest-relevant items mentioned

**From `## Areas`:**
- **Resrefs** — area identifiers for `visualize_area` calls
- **Transitions** — how areas connect (shapes quest flow)

**From `## Environment`:**
- **Placeables** — objects that could serve as quest pivots (containers, altars, furniture, evidence)
- **Waypoints** — map notes that can guide the player

**From `## Actors`:**
- **Key NPCs** — resref, tag, position, dialog resref, source blueprint
- **Ambient creatures** — what's already placed

Build a **quest implementation plan**:
1. List each quest from the plot with its stages (accepted → in progress → complete)
2. Map each stage to the NPC(s) and/or item(s) involved
3. Identify which NPCs need dialog modifications vs which are non-quest
4. Determine quest items needed (fetch objects, keys, evidence)
5. Plan the dialog flow for each quest NPC

---

### Phase 2: Create Journal

Call `create_journal()` first (idempotent — safe if JRL already exists).

For each quest:
1. **`add_journal_quest`** — create the quest category
   - `tag`: `q_[shortname]` (max 16 chars total, e.g., `q_rescue`, `q_herbs`)
   - `name`: Human-readable quest title (e.g., "Rescue the Merchant")

2. **`add_journal_entry`** — add entries for each stage
   - `id`: Sequential integers starting at 1
   - `text`: Written from the PC's perspective ("I should find the missing merchant...")
   - `end`: `true` only on the final completion entry

**Journal writing guidelines:**
- Write entries as the PC's internal thoughts: "I should...", "I found...", "The merchant told me..."
- Each entry should give the player clear direction about what to do next
- The final entry wraps up the quest: "The merchant is safe. I should speak with [NPC] for my reward."
- Keep entries concise — 1-2 sentences each

---

### Phase 3: Create Quest Items

**Collision check:** Before calling `create_item_blueprint(resref: "foo")`:
1. Call `search_by_tag(tag: "foo")`.
2. If a resource with that tag already exists in the module, **reuse it** — do not recreate.
3. Only create a new blueprint if the tag is truly unused.

For each item referenced in the quest plan (fetch objects, keys, evidence, delivery items):

Call `create_item_blueprint`:
- `resref`: `qi_[shortname]` (max 16 chars, e.g., `qi_herbs`, `qi_letter`)
- `tag`: same as resref
- `name`: Display name (e.g., "Bundle of Moon Herbs")
- `baseItem`: `40` (Miscellaneous Small) for most quest tokens. Use `42` (Key) for actual keys.
- `plot`: `true` (prevents player from dropping/selling quest items)
- `description`: Brief flavor text explaining what the item is

**Skip this phase** if no quest items are needed (e.g., pure dialogue quests).

---

### Phase 4: Write Condition Scripts

For each quest stage that needs a dialog condition check, write a script using `write_script`.

**Naming convention:** `c_q[tag]_s[N]` where `[tag]` is the quest short name (without `q_` prefix) and `[N]` is the stage number.

**Stage check pattern:**
```nwscript
// c_qrescue_s1.nss — checks if quest "q_rescue" is at stage 1
int StartingConditional() {
    object oPC = GetPCSpeaker();
    return GetLocalInt(oPC, "q_rescue") == 1;
}
```

**Item possession check pattern:**
```nwscript
// c_qrescue_has.nss — checks if PC has the quest item
int StartingConditional() {
    object oPC = GetPCSpeaker();
    return GetIsObjectValid(GetItemPossessedBy(oPC, "qi_herbs"));
}
```

**Combined check pattern (stage + item):**
```nwscript
// c_qrescue_s2.nss — stage 2 AND has the item
int StartingConditional() {
    object oPC = GetPCSpeaker();
    if (GetLocalInt(oPC, "q_rescue") != 2) return FALSE;
    return GetIsObjectValid(GetItemPossessedBy(oPC, "qi_herbs"));
}
```

**Important:** Always use `GetPCSpeaker()` (not `OBJECT_SELF`) for state storage. This enables cross-NPC quest state — NPC A sets a variable that NPC B checks.

**Error recovery:** If `write_script` returns a compile error:
1. Read the error message. Fix the syntax issue in the source.
2. Call `write_script` again with the corrected source.
3. If the second attempt also fails: write the script with `compile: false`.
   Add a note to `## Quests` in adventure.md: `**UNCOMPILED:** [resref] — [error summary]`.
   Continue with the next script. `/adventure-polish` will catch uncompiled scripts.
4. Never retry more than twice. Two failures means the script needs manual review.

---

### Phase 5: Write Action Scripts

For each quest state transition, write an action script using `write_script`.

**Naming convention:** `a_q[tag]_s[N]` where `[N]` is the stage being SET (not the stage being checked).

**Accept quest pattern:**
```nwscript
// a_qrescue_s1.nss — player accepts the rescue quest
void main() {
    object oPC = GetPCSpeaker();
    SetLocalInt(oPC, "q_rescue", 1);
    AddJournalQuestEntry("q_rescue", 1, oPC);
}
```

**Advance quest pattern:**
```nwscript
// a_qrescue_s2.nss — advance to stage 2
void main() {
    object oPC = GetPCSpeaker();
    SetLocalInt(oPC, "q_rescue", 2);
    AddJournalQuestEntry("q_rescue", 2, oPC);
}
```

**Give item to player pattern:**
```nwscript
// a_qrescue_s1.nss — accept quest + receive item
void main() {
    object oPC = GetPCSpeaker();
    SetLocalInt(oPC, "q_rescue", 1);
    AddJournalQuestEntry("q_rescue", 1, oPC);
    CreateItemOnObject("qi_letter", oPC);
}
```

**Take item from player + advance pattern:**
```nwscript
// a_qrescue_s3.nss — turn in item, complete quest
void main() {
    object oPC = GetPCSpeaker();
    object oItem = GetItemPossessedBy(oPC, "qi_herbs");
    if (GetIsObjectValid(oItem)) DestroyObject(oItem);
    SetLocalInt(oPC, "q_rescue", 3);
    AddJournalQuestEntry("q_rescue", 3, oPC);
}
```

**Reward pattern (XP + gold):**
```nwscript
void main() {
    object oPC = GetPCSpeaker();
    SetLocalInt(oPC, "q_rescue", 99);
    AddJournalQuestEntry("q_rescue", 4, oPC);
    GiveXPToCreature(oPC, 200);
    GiveGoldToCreature(oPC, 50);
}
```

---

### Phase 6: Modify/Build Quest Dialogs

This is the core phase. For each quest-involved NPC, integrate quest conversations into their existing dialog.

#### Step 1: Analyze Existing Dialog

Call `flatten_dialog(dlg_[npc])` to understand the current dialog structure:
- How many root entries (StartingList nodes)?
- What text does the NPC currently say?
- How many PC reply branches exist?

Note the entry and reply indices — you'll reference these when adding nodes.

#### Step 2: Design the Quest Dialog Tree

Plan the conversation flow for each quest stage. The key mechanism is **multiple root entries with condition scripts** in the StartingList. NWN evaluates StartingList top-to-bottom, using the first entry whose condition returns TRUE.

**Ordering rule:** Higher quest stages first, original greeting last.

```
StartingList[0] [condition: c_qrescue_s3] → "Quest complete" NPC line
StartingList[1] [condition: c_qrescue_s2] → "Have you found it?" NPC line
StartingList[2] [condition: c_qrescue_s1] → "Any luck?" NPC line
StartingList[3] [no condition]             → Original greeting (MUST be last)
```

#### Step 3: Add Root Entries

Use `add_dialog_node` with `parentType: "dialog"` to add condition-gated root entries.

**Insert order matters.** Add them from lowest-priority to highest-priority, each at position 0 (beginning of StartingList). This pushes earlier entries down, resulting in highest-stage first:

```
1. add_dialog_node(dialog="dlg_npc", parentType="dialog", parentIndex="0",
     text="Any luck finding those herbs?", condition="c_qrescue_s1")

2. add_dialog_node(dialog="dlg_npc", parentType="dialog", parentIndex="0",
     text="You found the herbs! Let me see them.", condition="c_qrescue_s2")

3. add_dialog_node(dialog="dlg_npc", parentType="dialog", parentIndex="0",
     text="Thank you again for your help, friend.", condition="c_qrescue_s3")
```

After these three inserts, the StartingList is:
```
[0] condition: c_qrescue_s3  (quest complete — added last, pushed to top)
[1] condition: c_qrescue_s2  (turn in)
[2] condition: c_qrescue_s1  (in progress)
[3] no condition              (original greeting — untouched)
```

#### Step 4: Build Quest Branches

For each new root entry, add PC replies and NPC follow-ups using `add_dialog_node` with `parentType: "entry"` and `parentType: "reply"`:

**Quest offer (in the original greeting or a new root):**
```
NPC Entry: "Welcome, traveler..." (existing root, or new root for stage 0)
  ├─ PC Reply: "What's troubling you?" (existing or new)
  │   └─ NPC Entry: "The merchant went missing in the forest..."
  │       ├─ PC Reply: "I'll find them." [script: a_qrescue_s1]
  │       │   └─ NPC Entry: "Bless you! Here, take this map."
  │       └─ PC Reply: "Not my problem."
  │           └─ NPC Entry: "I understand... perhaps another will help."
  ├─ PC Reply: "Just passing through." (existing)
```

**Quest in-progress (new root with condition):**
```
NPC Entry: "Any luck finding the merchant?" [condition: c_qrescue_s1]
  ├─ PC Reply: "Still looking."
  │   └─ NPC Entry: "Please hurry — I fear the worst."
  └─ PC Reply: "Where should I search?"
      └─ NPC Entry: "Try the old forest path, near the ruins."
```

**Quest turn-in (new root with condition):**
```
NPC Entry: "You found them! Is the merchant safe?" [condition: c_qrescue_s2]
  ├─ PC Reply: "Safe and sound." [script: a_qrescue_s3]
  │   └─ NPC Entry: "Thank the gods! Here's your reward."
  └─ PC Reply: "It was a close call, but yes."  [script: a_qrescue_s3]
      └─ NPC Entry: "You have my eternal gratitude."
```

#### Step 5: Verify Each Dialog (Mandatory)

**After adding all nodes for a quest NPC:**
1. Call `flatten_dialog(dialog: "dlg_[npc]")`.
2. Check that the **unconditioned root entry** (original greeting) appears LAST in the StartingList.
3. Check that **higher quest stages** appear BEFORE lower stages.
4. If ordering is wrong: the root entry was inserted at the wrong position. Use `remove_object` to remove the misplaced entry and re-insert with the correct `parentIndex`.
5. Do NOT proceed to the next NPC until this NPC's dialog verifies correctly.

Also verify:
- All conditions and scripts are attached
- Conversation flows make sense
- No dead-end nodes missing PC replies

#### Dialog Content Guidelines

- **Personality consistency:** Quest dialog should match the NPC's personality established in the greeting. If the innkeeper is gruff, quest dialog should be gruff too.
- **Natural transitions:** The quest offer should feel organic, not like a quest menu. NPCs mention their problems in conversation; the PC can choose to help.
- **Multiple PC response styles:** Offer helpful, curious, and dismissive options when appropriate.
- **Clear objectives:** When accepting a quest, the NPC should clearly state what needs to be done and where.
- **Quest completion feedback:** The NPC should react meaningfully when the quest is done — gratitude, relief, new information.

#### Fallback: Create New Dialog (Rare)

Only if the existing dialog is semantically incompatible (e.g., the NPC's entire role changes from the plot):

1. `create_dialog` with resref `qdlg_[npc]`
2. Repoint creature via `modify_gff_field`:
   - UTC: `modify_gff_field(resource=[npc], type=utc, path="Conversation", value="qdlg_[npc]")`
   - GIT: `modify_gff_field(resource=[area], type=git, path="Creature List.[index].Conversation", value="qdlg_[npc]")`
3. Get creature index from `get_area_creatures(area)` — creatures are listed in GIT order

---

### Phase 7: Verify

1. **`flatten_dialog`** for each modified dialog — check structure, conditions, scripts
2. **`get_journal`** — verify all quests and entries are present
3. **`validate_module`** — check for broken references (missing scripts, dialogs, items)

Fix any issues found before proceeding.

---

### Phase 8: Update adventure.md

Append a `## Quests` section to `adventure.md`:

```markdown
## Quests

### Quest: [Display Name] (`q_[tag]`)

**Journal Entries:**
| ID | Text | End? |
|----|------|------|
| 1 | I should find the missing merchant in the forest. | No |
| 2 | I found the merchant. I should report back to [NPC]. | No |
| 3 | The merchant is safe. [NPC] rewarded me for my help. | Yes |

**Quest Items:**
- **[Item Name]** (`qi_[tag]`, base: 40) — [description]

**Scripts:**
- Conditions: `c_q[tag]_s1`, `c_q[tag]_s2`, `c_q[tag]_has`
- Actions: `a_q[tag]_s1`, `a_q[tag]_s2`, `a_q[tag]_s3`

**NPCs Involved:**
- **[NPC Name]** (`[resref]` in `[area]`) — dialog: `dlg_[npc]` (modified in-place). Role: [quest giver / turn-in / info].
  - StartingList updated: [N] new root entries with conditions added

**Quest Flow:**
1. Player talks to [NPC A] → offered quest → accepts → journal entry 1
2. Player goes to [area] → finds [item/NPC] → journal entry 2
3. Player returns to [NPC A] → turns in → journal entry 3 (complete)
```

This data is used by downstream skills:
- `/adventure-challenges` uses quest flow to place hostile encounters along quest paths
- `/adventure-affordances` uses quest items to stock relevant merchants
- `/adventure-rewards` uses quest entries to assign XP values

---

### Phase 9: Save/Sync

Save/sync all changes. For standalone `.mod` workflows, call `repack_module`. For Nasher workflows, call `sync_nasher_source` at the end if any write response lacked `nasherSync` or if you are unsure; call `repack_module` only when a packed `.mod` is needed.

---

## Quest State Model

**All quest state is stored on the PC object** (not on NPCs) using `SetLocalInt` / `GetLocalInt`. This enables:
- Cross-NPC quests (NPC A sets state, NPC B checks it)
- Multiple quests tracked simultaneously
- Persistent state across area transitions

**Variable naming:** `q_[tag]` where `[tag]` is the quest tag (e.g., `q_rescue`)
**Stage values:** 0 = not started (default), 1+ = quest stages, 99 = fully complete

---

## Naming Conventions

| Resource | Pattern | Example | Max Length |
|----------|---------|---------|-----------|
| Quest tag | `q_[name]` | `q_rescue` | 16 chars |
| Quest dialog (fallback only) | `qdlg_[npc]` | `qdlg_elara` | 16 chars |
| Condition script | `c_q[name]_s[N]` | `c_qrescue_s2` | 16 chars |
| Action script | `a_q[name]_s[N]` | `a_qrescue_s1` | 16 chars |
| Item check condition | `c_q[name]_has` | `c_qrescue_has` | 16 chars |
| Quest item | `qi_[name]` | `qi_herbs` | 16 chars |

**Keep quest short names to 5-7 characters** to stay within the 16-char resref limit after prefixes.

---

## Important Notes

- **Modify existing dialogs first.** Only create new dialogs as a fallback when semantic incompatibility makes modification infeasible.
- **StartingList order is critical.** Higher quest stages first, original greeting last. The unconditioned entry MUST be the last StartingList entry — otherwise it will always match.
- **Use PC-local variables.** Always `GetPCSpeaker()` for state, never `OBJECT_SELF`. This enables cross-NPC state sharing.
- **All scripts must compile.** If `write_script` reports errors, fix and retry.
- **16-character resref limit.** Plan quest names to be short: `rescue`, `herbs`, `curse`, `bones`.
- **Tile coordinates:** Column = x (left to right), Row = y (bottom to top). World position = tile * 10.0 + 5.0 for center.
- **Do NOT auto-export HTML reports.**
- **Save/sync after all changes.** Standalone `.mod`: call `repack_module`. Nasher: call `sync_nasher_source` at the end if any write response lacked `nasherSync` or if you are unsure; call `repack_module` only when a packed `.mod` is needed.
- **No combat encounters.** Quest dialogs can reference danger but do NOT place hostile creatures or encounters. That's `/adventure-challenges`'s job.
- **No XP/reward assignment.** Quest completion scripts should NOT call `GiveXPToCreature` or grant rewards. That's `/adventure-rewards`'s job. Exception: if an action script must give a quest item to the player, that's fine.
- **Condition scripts use `int StartingConditional()`**, not `void main()`. Action scripts use `void main()`.
- **Area event scripts.** For quests that trigger on entering an area (e.g., ambush, cutscene, journal update), write an OnEnter script and assign it with `set_area_scripts(area: "[area]", onEnter: "a_q[tag]_enter")`. For module-level events (e.g., giving quest items on module start), use `set_module_scripts(Mod_OnClientEntr: "a_mod_enter")`.
