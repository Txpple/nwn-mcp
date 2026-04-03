# Changelog

## [1.2.0] — 2026-04-03

### Highlights

This release ships the **complete `/create-adventure` pipeline** — a fully autonomous, 9-phase module builder that goes from a one-line prompt to a playable NWN adventure. It has been end-to-end tested, producing connected multi-area modules with painted terrain, dressed environments, placed NPCs with quest dialogs, combat encounters, stores, loot, and XP rewards. The pipeline runs spoiler-free: the DM finds out what's in the module at the same time the players do.

The release also ships a major overhaul of the **zone-based terrain solver**, fixing a class of crosser/corner mismatches that caused visual artifacts in painted areas, and adding 10 layout styles for the procedural layout generator.

---

### New: `/create-adventure` Pipeline

A 9-sub-skill autonomous adventure creator, orchestrated by `/create-adventure`:

| Phase | Skill | What it does |
|-------|-------|-------------|
| 1 | `adventure-plot` | Generates narrative structure — locations, NPCs, quests, tone |
| 2 | `adventure-areas` | Tileset selection, BSP layout, terrain painting, area transitions |
| 3 | `adventure-environment` | Placeables, ambient sounds, waypoints, useable props |
| 4 | `adventure-actors` | Non-hostile NPCs with greeting dialogs, ambient creatures |
| 5 | `adventure-quests` | Journal entries, quest scripts, branching quest dialogs |
| 6 | `adventure-challenges` | Hostile creatures with tactical roles, traps |
| 7 | `adventure-affordances` | Merchant stores, container loot, starting gold, level adjustment |
| 8 | `adventure-polish` | Validation, dead-end dialog fixes, object heights, connectivity check |
| 9 | `adventure-rewards` | Quest XP, end-of-adventure reward items, peaceful-resolution bonuses |

Each sub-skill runs as an autonomous agent with bounded context. The orchestrator sequences them, checks `adventure-status.json` after each phase, and uses rollback tools to fix problems without user intervention.

### New: Layout Generator (`adventure_generate_layout`)

Server-side procedural layout generation via a unified BSP pipeline. Returns zones + crossers + feature suggestions ready for `adventure_apply_layout`.

**10 layout styles:**
- **Interior:** `dungeon`, `cave`, `dwelling`
- **Exterior:** `forest`, `rural`, `city`, `plains`, `desert`, `castle`, `tundra`

Each style has tuned parameters: split variance, room size fraction, corridor S-curve probability, L-shaped room chance, shortcut corridor count, obstacle patches, and terrain keywords.

**BSP rules enforced:**
- Minimum 3×3 rooms, margin ≥ 2 (never collapses to 1)
- `minLeaf = 6` ensures every leaf fits a room + margin
- L-shaped rooms via adjacent sibling merging
- S-curves offset corridor middle-thirds by 1 tile perpendicular
- Shortcut corridors create T-junction connections between non-adjacent rooms

### New Tools

- **`adventure_apply_layout`** — Atomically applies a `LayoutResult` (zones + crossers + features) via the zone solver. Replaces manual tile-by-tile painting for adventure areas.
- **`adventure_list_features`** — Returns solver-compatible feature groups for a tileset + style, with tile coverage estimates. Used by `adventure-areas` to select `preferredFeatures`.

### Zone Solver Fixes

- **Tile orientation normalization** — `.set` `Orientation` fields are un-rotated at parse time, normalizing all tiles to GIT orientation 0. `getRotatedCorners(tile, gitOri)` now returns correct effective corners for any placement orientation. Solver prefers tiles at their native `.set` orientation to avoid visual artifacts from non-native rotations.
- **Solver step 1.5** — New fallback step between exact-match and drop-crossers: adjusts free corners while keeping crossers, finding "corridor mouth" tiles for room-edge positions. Adjustments are written back to the corner grid so downstream tiles see them.
- **Room-corner crosser exclusion** — Tiles diagonally adjacent to rooms (but not cardinally adjacent) are excluded from corridor crosser paths. These tiles have a single non-wall corner (3-wall + 1-floor) and no tileset has crosser tiles for that pattern.
- **BSP room separation enforced** — Adjacent BSP sibling rooms are guaranteed to be separated by at least 2 tiles of wall terrain. Rooms that touch or overlap are rejected and re-split.
- **S-curve threshold** — Lowered to 3 wall tiles (from 5), producing tighter interior layouts.
- **Short interior corridors** — Corridors shorter than the S-curve threshold are converted to floor-terrain zones for walkability rather than crosser paths.
- **Feature terrain filter** — Feature groups with tiles whose corners don't all match the room's floor terrain are excluded from placement. Prevents foreign corners from locking into the solver grid.
- **Crosser propagation guard** — Crossers don't propagate onto tiles with any non-default corner. Only pure-default tiles receive propagated crossers.

### Other Fixes

- Exterior layout styles never emit secondary crosser paths (stream/river crossers are interior-only).
- `adventure_list_features` resolves floor terrain from style type (interior vs. exterior) rather than guessing.
- Fallback tile substitution is constrained to terrains already present in the corner grid.

---

## [1.1.0] — (previous release)

Initial public release with base toolset: area creation, object placement, blueprint discovery, dialog authoring, quest journals, script compilation, analysis tools, undo stack, walkmesh enforcement, and HTML area reports.
