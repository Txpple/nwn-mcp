/**
 * HTML map generator for NWN areas.
 *
 * Three-layer architecture:
 * - renderMapSection()              — shared helper: emits grid + legend + info for one area (no HTML wrapper)
 * - generateHtmlReportSingleArea()  — full HTML page for one area with enhanced detail
 * - generateHtmlReportAllAreas()    — full HTML page with module summary + all area maps
 *
 * Tile colors are determined by dominant walkmesh surface material
 * from surfacemat.2da (standardized engine types), NOT tileset terrain names.
 */

import type { TileRenderData, FeatureLabel, AreaObjectData } from "./area-data.js";
import { MATERIAL_COLORS, MATERIAL_WALKABLE, MATERIAL_IS_WATER, getMaterialColor } from "./area-data.js";
import type { ZoneInfo } from "./walkmesh.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface HtmlMapOptions {
  showObjects?: boolean;
}

export interface AreaMapData {
  resref: string;
  name: string;
  tag?: string;
  width: number;
  height: number;
  tilesetName: string;
  grid: TileRenderData[][];
  features: FeatureLabel[];
  zones: ZoneInfo[];
  objects: AreaObjectData[];
}

export interface DoorLink {
  fromArea: string;
  fromTag: string;
  toArea: string;
  toTag: string;
  locked: boolean;
  keyName: string;
  lockDC: number;
}

export interface CreatureInfo {
  name: string;
  tag: string;
  cr: number;
  hp: number;
  classes: string;
  area: string;
  hostile: boolean;
  hasDialog: boolean;
}

export interface ModuleReportData {
  moduleName: string;
  areas: AreaMapData[];
  doorLinks: DoorLink[];
  creatures: CreatureInfo[];
  itemCount: number;
  scriptCount: number;
  dialogCount: number;
}

// ─── Crosser Colors ─────────────────────────────────────────────────────────

const CROSSER_COLORS: Record<string, string> = {
  "Road": "#d4a017", "road": "#d4a017",
  "Stream": "#4a9eda", "stream": "#4a9eda",
  "Wall": "#888888", "wall": "#888888",
  "Bridge": "#d4a017", "bridge": "#d4a017",
  "Tracks": "#666666", "tracks": "#666666",
  "Dock": "#d4a017", "dock": "#d4a017",
  "Corridor": "#888888", "corridor": "#888888",
  "Doorway": "#CD853F", "doorway": "#CD853F",
};

const MARKER_COLORS: Record<string, string> = {
  creature:   "#ff6b35",  // vivid orange
  placeable:  "#00d4ff",  // electric cyan
  transition: "#e74cff",  // vivid magenta
};

const MARKER_LABELS: Record<string, string> = {
  creature:   "C",
  placeable:  "P",
  transition: "T",
};

const CELL_SIZE = 64;
const GROUP_BORDER_COLOR = "#9b59b6";

// ─── Shared CSS ─────────────────────────────────────────────────────────────

function sharedCss(): string {
  return `
:root { --cell: ${CELL_SIZE}px; }
* { box-sizing: border-box; margin: 0; padding: 0; }
body { background: #1a1a1a; color: #d4d4d4; font-family: 'Segoe UI', system-ui, sans-serif; padding: 1.5rem; }

.controls { display: flex; gap: 1.5rem; margin-bottom: 1rem; flex-wrap: wrap; }
.controls label { display: flex; align-items: center; gap: 0.4rem; cursor: pointer; font-size: 0.85rem; color: #bbb; }
.controls input[type=checkbox] { accent-color: #4a9eda; }

.map-wrap { position: relative; overflow: auto; }
.col-labels { display: flex; padding-left: 2rem; }
.col-label { width: var(--cell); text-align: center; font-size: 0.7rem; color: #666; flex-shrink: 0; }
.row-wrap { display: flex; }
.row-labels { display: flex; flex-direction: column; justify-content: space-around; width: 2rem; flex-shrink: 0; }
.row-label { height: var(--cell); display: flex; align-items: center; justify-content: flex-end; padding-right: 0.4rem; font-size: 0.7rem; color: #666; }

.area-grid {
  display: grid; gap: 0; border: 1px solid #444;
}
.tile {
  position: relative; overflow: visible; cursor: pointer;
  border: 1px solid rgba(255,255,255,0.08);
}
.tile:hover { outline: 2px solid #fff; outline-offset: -2px; z-index: 10; }

.tile-geo { position: absolute; inset: 0; width: 100%; height: 100%; }

.crosser-line { position: absolute; z-index: 4; pointer-events: none; }
.crosser-top { left: 50%; top: -1px; transform: translateX(-50%); width: 6px; height: 30%; }
.crosser-right { top: 50%; right: -1px; transform: translateY(-50%); height: 6px; width: 30%; }
.crosser-bottom { left: 50%; bottom: -1px; transform: translateX(-50%); width: 6px; height: 30%; }
.crosser-left { top: 50%; left: -1px; transform: translateY(-50%); height: 6px; width: 30%; }
.hide-crossers .crosser-line { display: none; }

.group-label { position: absolute; z-index: 5; pointer-events: none; font-size: 0.6rem; font-weight: bold; color: #fff; background: rgba(0,0,0,0.6); padding: 1px 3px; border-radius: 2px; white-space: nowrap; left: 50%; top: 50%; transform: translate(-50%,-50%); }
.hide-groups .group-label { display: none; }

.group-border { position: absolute; z-index: 3; pointer-events: none; }
.group-border-top { top: -2px; left: -2px; right: -2px; height: 3px; }
.group-border-right { right: -2px; top: -2px; bottom: -2px; width: 3px; }
.group-border-bottom { bottom: -2px; left: -2px; right: -2px; height: 3px; }
.group-border-left { left: -2px; top: -2px; bottom: -2px; width: 3px; }
.hide-groups .group-border { display: none; }

.obj-marker { position: absolute; width: 16px; height: 16px; transform: translate(-50%,-50%); z-index: 6; border: 1.5px solid rgba(0,0,0,0.6); color: #fff; font-size: 9px; font-weight: bold; text-align: center; line-height: 16px; pointer-events: none; }
.obj-creature { border-radius: 50%; background: ${MARKER_COLORS.creature}; }
.obj-placeable { border-radius: 3px; background: ${MARKER_COLORS.placeable}; }
.obj-transition { border-radius: 2px; background: ${MARKER_COLORS.transition}; transform: translate(-50%,-50%) rotate(45deg); }
.obj-transition span { display: block; transform: rotate(-45deg); line-height: 16px; }
.hide-placeables .obj-placeable { display: none; }
.hide-creatures .obj-creature { display: none; }
.hide-transitions .obj-transition { display: none; }

.walk-overlay { position: absolute; inset: 0; z-index: 5; display: flex; align-items: center; justify-content: center; pointer-events: none; font-size: 0.6rem; font-weight: bold; line-height: 1; text-shadow: 0 0 3px rgba(0,0,0,0.9); }
.walk-overlay { color: #fff; }
.show-walkability .walk-overlay { display: flex; }
.walk-overlay { display: none; }

.area-tooltip { display: none; position: fixed; z-index: 100; background: #2a2a2a; border: 1px solid #555; border-radius: 4px; padding: 0.5rem 0.75rem; font-size: 0.75rem; color: #ddd; max-width: 300px; pointer-events: none; box-shadow: 0 4px 12px rgba(0,0,0,0.5); }
.area-tooltip .tt-title { font-weight: bold; color: #fff; margin-bottom: 0.3rem; }
.area-tooltip .tt-row { display: flex; justify-content: space-between; gap: 1rem; }
.area-tooltip .tt-label { color: #999; }
.area-tooltip .tt-materials { margin-top: 0.3rem; }
.area-tooltip .tt-mat-bar { display: flex; height: 6px; border-radius: 2px; overflow: hidden; margin-top: 2px; }
.area-tooltip .tt-mat-seg { height: 100%; }
.area-tooltip .tt-objects { margin-top: 0.3rem; border-top: 1px solid #444; padding-top: 0.3rem; }

.legend { margin-top: 1.5rem; }
.legend h3 { font-size: 0.85rem; color: #aaa; margin-bottom: 0.5rem; }
.legend-grid { display: flex; flex-wrap: wrap; gap: 0.5rem; }
.legend-item { display: flex; align-items: center; gap: 0.3rem; font-size: 0.75rem; }
.legend-swatch { width: 16px; height: 16px; border-radius: 2px; border: 1px solid rgba(255,255,255,0.15); flex-shrink: 0; }
.legend-label { color: #bbb; }
.legend-walk { font-size: 0.65rem; color: #888; }
.crosser-legend { margin-top: 0.75rem; }
.crosser-swatch { width: 24px; height: 4px; display: inline-block; vertical-align: middle; margin-right: 0.3rem; }
.obj-legend { margin-top: 0.75rem; }
.obj-swatch { width: 14px; height: 14px; display: inline-flex; align-items: center; justify-content: center; vertical-align: middle; margin-right: 0.3rem; border: 1px solid rgba(0,0,0,0.3); color: #fff; font-size: 8px; font-weight: bold; }
.obj-swatch-creature { border-radius: 50%; }
.obj-swatch-placeable { border-radius: 2px; }
.obj-swatch-transition { border-radius: 2px; transform: rotate(45deg); }
.obj-swatch-transition span { transform: rotate(-45deg); display: block; }
.info-section { margin-top: 1rem; }
.info-section h3 { font-size: 0.85rem; color: #aaa; margin-bottom: 0.3rem; }
.info-section p, .info-section li { font-size: 0.75rem; color: #bbb; }
.info-section ul { list-style: none; padding: 0; }

.accordion { margin-top: 1rem; border: 1px solid #333; border-radius: 4px; overflow: hidden; }
.accordion summary { cursor: pointer; padding: 0.5rem 0.75rem; background: #252525; font-size: 0.85rem; color: #ccc; font-weight: bold; user-select: none; }
.accordion summary:hover { background: #2a2a2a; }
.accordion summary::marker { color: #666; }
.accordion .accordion-body { padding: 0.5rem 0.75rem; background: #1e1e1e; }
.accordion .accordion-body ul { list-style: none; padding: 0; }
.accordion .accordion-body li { font-size: 0.75rem; color: #bbb; padding: 0.15rem 0; }
`;
}

// ─── Report-specific CSS ────────────────────────────────────────────────────

function reportCss(): string {
  return `
.report { max-width: 1200px; margin: 0 auto; }
h1 { font-size: 1.8rem; color: #eee; border-bottom: 2px solid #444; padding-bottom: 0.5rem; margin-bottom: 0.5rem; }
h2 { font-size: 1.3rem; color: #ddd; margin-top: 2.5rem; margin-bottom: 0.25rem; }
h2 .area-tag { font-size: 0.8rem; color: #666; font-weight: normal; }
.summary { color: #bbb; font-size: 0.9rem; line-height: 1.6; margin-bottom: 2rem; }
.summary strong { color: #ddd; }
.transition-diagram { font-family: 'Consolas', monospace; font-size: 0.85rem; color: #aaa; background: #222; padding: 1rem 1.5rem; border-radius: 6px; margin: 1rem 0; display: inline-block; line-height: 1.8; }
.transition-diagram .area-name { color: #4a9eda; font-weight: bold; }
.transition-diagram .arrow { color: #888; }
.transition-diagram .door-info { color: #cd853f; font-size: 0.75rem; }
.npc-card { display: inline-flex; align-items: center; gap: 0.5rem; background: #252525; padding: 0.4rem 0.8rem; border-radius: 4px; margin: 0.2rem; border-left: 3px solid; }
.npc-hostile { border-color: #ff4444; }
.npc-friendly { border-color: #44cc44; }
.npc-name { color: #eee; font-weight: bold; font-size: 0.85rem; }
.npc-detail { color: #888; font-size: 0.75rem; }
.area-subtitle { color: #888; font-size: 0.85rem; margin-bottom: 0.75rem; }
.area-section { margin-bottom: 3rem; padding-bottom: 2rem; border-bottom: 1px solid #333; }
hr.section-break { border: none; border-top: 2px solid #333; margin: 2rem 0; }
`;
}

// ─── Shared Tooltip JS ──────────────────────────────────────────────────────

function tooltipJs(prefix: string): string {
  return `(function(){
var g=document.getElementById('grid-${prefix}'),t=document.getElementById('tt-${prefix}'),tT=document.getElementById('ttt-${prefix}'),tB=document.getElementById('ttb-${prefix}');
var tg={'chk-crossers-${prefix}':['hide-crossers',1],'chk-groups-${prefix}':['hide-groups',1],'chk-placeables-${prefix}':['hide-placeables',1],'chk-creatures-${prefix}':['hide-creatures',1],'chk-transitions-${prefix}':['hide-transitions',1],'chk-walkability-${prefix}':['show-walkability',0]};
for(var id in tg){var c=document.getElementById(id);if(!c)continue;(function(c,cls,inv){c.addEventListener('change',function(){g.classList.toggle(cls,inv?!c.checked:c.checked)})})(c,tg[id][0],tg[id][1]);}
var MC=${JSON.stringify(MATERIAL_COLORS)};
g.addEventListener('mousemove',function(e){
var ti=e.target.closest('.tile');if(!ti){t.style.display='none';return;}var d=ti.dataset;
tT.textContent='Tile ('+d.col+','+d.row+')'+(d.group?'\\u2014 '+d.group:'');
var b='<div class="tt-row"><span class="tt-label">Tileset ID:</span><span>'+d.tid+'</span></div>';
b+='<div class="tt-row"><span class="tt-label">Tile Filename:</span><span>'+d.model+'</span></div>';
b+='<div class="tt-row"><span class="tt-label">Walkable:</span><span>'+d.walk+'%</span></div>';
if(d.crossers)b+='<div class="tt-row"><span class="tt-label">Crossers:</span><span>'+d.crossers+'</span></div>';
if(d.mats){b+='<div class="tt-materials"><span class="tt-label">Materials:</span><div class="tt-mat-bar">';d.mats.split(',').forEach(function(p){var a=p.split(':');b+='<div class="tt-mat-seg" style="width:'+a[1]+'%;background:'+(MC[a[0]]||'#555')+'"></div>';});b+='</div><div style="font-size:0.65rem;color:#999;margin-top:1px">'+d.mats.split(',').map(function(p){var a=p.split(':');return a[0]+' '+a[1]+'%';}).join(', ')+'</div></div>';}
var MK=${JSON.stringify(MARKER_COLORS)};var mk=ti.querySelectorAll('.obj-marker');if(mk.length>0){b+='<div class="tt-objects">';mk.forEach(function(m){var mt=m.dataset.mtype||'';b+='<div style="font-size:0.7rem"><span style="color:'+(MK[mt]||'#fff')+'">\\u25cf</span> '+m.dataset.name+'</div>';});b+='</div>';}
tB.innerHTML=b;t.style.display='block';var x=e.clientX+15,y=e.clientY+15;t.style.left=(x+t.offsetWidth>window.innerWidth?e.clientX-t.offsetWidth-10:x)+'px';t.style.top=(y+t.offsetHeight>window.innerHeight?e.clientY-t.offsetHeight-10:y)+'px';
});
g.addEventListener('mouseleave',function(){t.style.display='none';});
})();`;
}

// ─── Layer 1: Render Map Section ────────────────────────────────────────────

/** Lookup map: area resref → { name, tag } for cross-linking in module reports */
export interface AreaLookupEntry { name: string; tag: string; }

function renderMapSection(
  prefix: string,
  area: AreaMapData,
  areaLookup?: Map<string, AreaLookupEntry>,
): string {
  const { width, height, grid, features, zones, objects } = area;
  const gridMinW = width * CELL_SIZE;
  const gridMinH = height * CELL_SIZE;

  // Build group membership lookup: "col,row" → groupName
  const groupAt = new Map<string, string>();
  for (const row of grid) {
    for (const tile of row) {
      if (tile.groupName) groupAt.set(`${tile.col},${tile.row}`, tile.groupName);
    }
  }

  // Group objects by tile
  const objectsByTile = new Map<string, AreaObjectData[]>();
  for (const obj of objects) {
    const key = `${Math.floor(obj.x / 10)},${Math.floor(obj.y / 10)}`;
    if (!objectsByTile.has(key)) objectsByTile.set(key, []);
    objectsByTile.get(key)!.push(obj);
  }

  const h: string[] = [];

  // Controls
  h.push(`<div class="controls">
  <label><input type="checkbox" id="chk-crossers-${prefix}" checked> Crossers</label>
  <label><input type="checkbox" id="chk-groups-${prefix}" checked> Tile Groups</label>
  <label><input type="checkbox" id="chk-placeables-${prefix}" checked> Placeables</label>
  <label><input type="checkbox" id="chk-creatures-${prefix}" checked> Creatures</label>
  <label><input type="checkbox" id="chk-transitions-${prefix}" checked> Transitions</label>
  <label><input type="checkbox" id="chk-walkability-${prefix}"> Walkability (for spatial payload analysis)</label>
</div>`);

  // Map
  h.push(`<div class="map-wrap"><div class="col-labels">`);
  for (let col = 0; col < width; col++) h.push(`<div class="col-label">${col}</div>`);
  h.push(`</div><div class="row-wrap"><div class="row-labels">`);
  for (let row = height - 1; row >= 0; row--) h.push(`<div class="row-label">${row}</div>`);
  h.push(`</div><div class="area-grid" id="grid-${prefix}" style="grid-template-columns:repeat(${width},var(--cell));grid-template-rows:repeat(${height},var(--cell));min-width:${gridMinW}px;min-height:${gridMinH}px;">`);

  // Tiles
  for (let row = height - 1; row >= 0; row--) {
    for (let col = 0; col < width; col++) {
      const tile = grid[row][col];
      const bgColor = getMaterialColor(tile.dominantMaterial);

      // Material breakdown
      const totalFaces = [...tile.materials.values()].reduce((a, b) => a + b, 0);
      const matStr = totalFaces > 0
        ? [...tile.materials.entries()].sort((a, b) => b[1] - a[1]).map(([m, c]) => `${m}:${Math.round(c / totalFaces * 100)}`).join(",")
        : "";

      // Crosser data for tooltip
      const crStr = [tile.crossers.top && `T:${tile.crossers.top}`, tile.crossers.right && `R:${tile.crossers.right}`, tile.crossers.bottom && `B:${tile.crossers.bottom}`, tile.crossers.left && `L:${tile.crossers.left}`].filter(Boolean).join(",");

      const hasTris = tile.triangles.length > 0;
      const tileBg = hasTris ? "#111" : bgColor;  // dark fallback behind SVG
      h.push(`<div class="tile" style="background:${tileBg};width:var(--cell);height:var(--cell)" data-col="${col}" data-row="${row}" data-tid="${tile.tileId}" data-ori="${tile.orientation}" data-terrain="${esc(tile.dominantTerrain)}" data-material="${esc(tile.dominantMaterial)}" data-walk="${tile.walkablePercent}" data-mats="${esc(matStr)}" data-crossers="${esc(crStr)}" data-group="${esc(tile.groupName || "")}" data-water="${tile.hasWater}" data-model="${esc(tile.tileModel || "")}">`);

      // Walkmesh triangle geometry SVG
      if (hasTris) {
        h.push(`<svg class="tile-geo" viewBox="0 0 1 1" preserveAspectRatio="none">`);
        for (const tri of tile.triangles) {
          h.push(`<polygon points="${tri.points}" fill="${tri.color}"/>`);
        }
        h.push(`</svg>`);
      }

      // Walkability percentage overlay
      h.push(`<div class="walk-overlay">${tile.walkablePercent}%</div>`);

      // Crosser overlay lines (on grid boundaries)
      for (const [edge, cls] of [["top", "crosser-top"], ["right", "crosser-right"], ["bottom", "crosser-bottom"], ["left", "crosser-left"]] as const) {
        const cr = tile.crossers[edge];
        if (cr) {
          const color = CROSSER_COLORS[cr] ?? "#888";
          h.push(`<div class="crosser-line ${cls}" style="background:${color}"></div>`);
        }
      }

      // Group perimeter borders (purple, only on edges not shared with same group)
      if (tile.groupName) {
        const gn = tile.groupName;
        // Check each neighbor — if neighbor is NOT in the same group, this edge is perimeter
        if (groupAt.get(`${col},${row + 1}`) !== gn) h.push(`<div class="group-border group-border-top" style="background:${GROUP_BORDER_COLOR}"></div>`);
        if (groupAt.get(`${col + 1},${row}`) !== gn) h.push(`<div class="group-border group-border-right" style="background:${GROUP_BORDER_COLOR}"></div>`);
        if (groupAt.get(`${col},${row - 1}`) !== gn) h.push(`<div class="group-border group-border-bottom" style="background:${GROUP_BORDER_COLOR}"></div>`);
        if (groupAt.get(`${col - 1},${row}`) !== gn) h.push(`<div class="group-border group-border-left" style="background:${GROUP_BORDER_COLOR}"></div>`);
      }

      // Group label
      for (const fl of features) {
        if (row === fl.row + Math.floor(fl.rows / 2) && col === fl.col + Math.floor(fl.cols / 2)) {
          h.push(`<span class="group-label">${esc(fl.name)}</span>`);
        }
      }

      // Object markers (creatures, placeables, transitions only)
      const tileObjs = objectsByTile.get(`${col},${row}`);
      if (tileObjs) {
        for (const obj of tileObjs) {
          // Determine marker type
          let markerType: string;
          if (obj.type === "creature") {
            markerType = "creature";
          } else if (obj.type === "placeable") {
            markerType = "placeable";
          } else if ((obj.type === "door" || obj.type === "trigger") && obj.linkedToFlags === 1 && obj.linkedTo) {
            markerType = "transition";
          } else {
            continue; // skip other object types
          }

          const px = ((obj.x % 10) / 10) * 100;
          const py = (1 - (obj.y % 10) / 10) * 100;
          const label = MARKER_LABELS[markerType] || "?";
          const content = markerType === "transition" ? `<span>${label}</span>` : label;
          h.push(`<div class="obj-marker obj-${markerType}" style="left:${px.toFixed(1)}%;top:${py.toFixed(1)}%" data-name="${esc(obj.name)}" data-tag="${esc(obj.tag)}" data-mtype="${markerType}">${content}</div>`);
        }
      }

      h.push(`</div>`);
    }
  }

  h.push(`</div></div></div>`);

  // Tooltip
  h.push(`<div class="area-tooltip" id="tt-${prefix}"><div class="tt-title" id="ttt-${prefix}"></div><div id="ttb-${prefix}"></div></div>`);

  // Legend - ALL Surface Materials from surfacemat.2da
  h.push(`<div class="legend"><h3>Surface Materials</h3><div class="legend-grid">`);
  const allMats = Object.keys(MATERIAL_COLORS).sort((a, b) => {
    const aw = MATERIAL_WALKABLE[a] ?? false, bw = MATERIAL_WALKABLE[b] ?? false;
    if (aw !== bw) return aw ? -1 : 1;
    return a.localeCompare(b);
  });
  for (const mat of allMats) {
    const tags: string[] = [];
    if (!(MATERIAL_WALKABLE[mat] ?? false)) tags.push("no-walk");
    if (MATERIAL_IS_WATER[mat]) tags.push("water");
    h.push(`<div class="legend-item"><div class="legend-swatch" style="background:${getMaterialColor(mat)}"></div><span class="legend-label">${esc(mat)}</span><span class="legend-walk">${tags.length ? ` (${tags.join(", ")})` : ""}</span></div>`);
  }
  h.push(`</div>`);

  // Legend - Crossers
  const presentCrossers = new Set<string>();
  for (const row of grid) for (const tile of row) for (const c of [tile.crossers.top, tile.crossers.right, tile.crossers.bottom, tile.crossers.left]) if (c) presentCrossers.add(c);
  if (presentCrossers.size > 0) {
    h.push(`<div class="crosser-legend"><h3>Crossers</h3><div class="legend-grid">`);
    for (const cr of presentCrossers) { const color = CROSSER_COLORS[cr]; if (color) h.push(`<div class="legend-item"><span class="crosser-swatch" style="background:${color}"></span><span class="legend-label">${esc(cr)}</span></div>`); }
    h.push(`</div></div>`);
  }

  // Legend - Map Markers
  {
    // Count visible marker types
    const creatureCount = objects.filter(o => o.type === "creature").length;
    const placeableCount = objects.filter(o => o.type === "placeable").length;
    const transitionCount = objects.filter(o => (o.type === "door" || o.type === "trigger") && o.linkedToFlags === 1 && o.linkedTo).length;
    const markerTypes: Array<{ key: string; label: string; count: number; shape: string }> = [
      { key: "creature", label: "Creatures", count: creatureCount, shape: "creature" },
      { key: "placeable", label: "Placeables", count: placeableCount, shape: "placeable" },
      { key: "transition", label: "Transitions", count: transitionCount, shape: "transition" },
    ].filter(m => m.count > 0);
    if (markerTypes.length > 0) {
      h.push(`<div class="obj-legend"><h3>Map Markers</h3><div class="legend-grid">`);
      for (const m of markerTypes) {
        const color = MARKER_COLORS[m.key] || "#fff";
        const lbl = MARKER_LABELS[m.key] || "?";
        const inner = m.shape === "transition" ? `<span>${lbl}</span>` : lbl;
        h.push(`<div class="legend-item"><span class="obj-swatch obj-swatch-${m.shape}" style="background:${color}">${inner}</span><span class="legend-label">${m.label} (${m.count})</span></div>`);
      }
      h.push(`</div></div>`);
    }
  }

  h.push(`</div>`);

  // Area Transitions accordion — show transition destinations from walkable zones
  {
    const connectedAreas = new Set<string>();
    for (const z of zones) {
      if (z.transitionsOut) for (const a of z.transitionsOut) connectedAreas.add(a);
    }
    if (connectedAreas.size > 0) {
      h.push(`<details class="accordion"><summary>Area Transitions</summary><div class="accordion-body"><ul>`);
      for (const resref of connectedAreas) {
        const info = areaLookup?.get(resref);
        const displayName = info?.name || resref;
        const tag = info?.tag || resref;
        const anchor = areaLookup ? `area-${resref.replace(/[^a-z0-9]/gi, "_")}` : "";
        if (anchor) {
          h.push(`<li><a href="#${anchor}" style="color:#4a9eda;text-decoration:none">${esc(displayName)}</a> <span style="color:#888">${esc(tag)}</span> <span style="color:#666">(${esc(resref)})</span></li>`);
        } else {
          h.push(`<li>${esc(displayName)} <span style="color:#888">${esc(tag)}</span> <span style="color:#666">(${esc(resref)})</span></li>`);
        }
      }
      h.push(`</ul></div></details>`);
    }
  }

  return h.join("\n");
}

// ─── Layer 2: Single Area Report ────────────────────────────────────────────

/** Generate a full HTML page for a single area with enhanced detail. */
export function generateHtmlReportSingleArea(area: AreaMapData): string {
  const prefix = area.resref.replace(/[^a-z0-9]/gi, "_");
  const mapSection = renderMapSection(prefix, area);

  // Count objects by type
  const objCounts: Record<string, number> = {};
  for (const obj of area.objects) objCounts[obj.type] = (objCounts[obj.type] ?? 0) + 1;
  const objSummary = Object.entries(objCounts).map(([t, c]) => `${c} ${t}${c > 1 ? "s" : ""}`).join(", ") || "none";

  // Build creature accordion
  const creatures = area.objects.filter(o => o.type === "creature");
  let creatureAccordion = "";
  if (creatures.length > 0) {
    const cards = creatures.map(c => {
      const cls = c.hostile ? "npc-hostile" : "npc-friendly";
      return `<div class="npc-card ${cls}"><span class="npc-name">${esc(c.name)}</span><span class="npc-detail">CR ${c.cr ?? 0}, HP ${c.hp ?? 0}, ${esc(c.classes || "unknown")}${c.hasDialog ? " (dialog)" : ""}</span></div>`;
    }).join("");
    creatureAccordion = `<details class="accordion"><summary>Area Creatures (${creatures.length})</summary><div class="accordion-body"><div style="display:flex;flex-wrap:wrap;gap:0.3rem;margin:0.3rem 0">${cards}</div></div></details>`;
  }

  // Build placeable accordion
  const placeables = area.objects.filter(o => o.type === "placeable");
  let placeableAccordion = "";
  if (placeables.length > 0) {
    const cards = placeables.map(p => {
      const props: string[] = [];
      props.push(p.useable ? "useable" : "not useable");
      props.push(p.hasInventory ? "has inventory" : "no inventory");
      props.push(p.static ? "static" : "dynamic");
      return `<div class="npc-card" style="border-color:#00d4ff"><span class="npc-name">${esc(p.name)}</span><span class="npc-detail">${props.join(", ")}</span></div>`;
    }).join("");
    placeableAccordion = `<details class="accordion"><summary>Area Placeables (${placeables.length})</summary><div class="accordion-body"><div style="display:flex;flex-wrap:wrap;gap:0.3rem;margin:0.3rem 0">${cards}</div></div></details>`;
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>${esc(area.name)} &mdash; ${esc(area.resref)}</title>
<style>${sharedCss()}${reportCss()}</style>
</head>
<body>
<h1 style="font-size:1.4rem;color:#eee;margin-bottom:0.25rem;">${esc(area.name)}</h1>
<div style="color:#888;font-size:0.85rem;margin-bottom:0.5rem;">${esc(area.resref)} &mdash; ${area.width}x${area.height} (${area.width * 10}m &times; ${area.height * 10}m) &mdash; ${esc(area.tilesetName)}</div>
<div style="color:#bbb;font-size:0.85rem;margin-bottom:1rem;">Objects: ${objSummary}</div>
${mapSection}
${creatureAccordion}
${placeableAccordion}
<script>${tooltipJs(prefix)}</script>
</body>
</html>`;
}

// ─── Layer 3: All Areas Report ──────────────────────────────────────────────

/** Generate a full HTML page with module summary and all area maps. */
export function generateHtmlReportAllAreas(data: ModuleReportData): string {
  const h: string[] = [];

  h.push(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>${esc(data.moduleName)} &mdash; Module Report</title>
<style>${sharedCss()}${reportCss()}</style>
</head>
<body>
<div class="report">
<h1>${esc(data.moduleName)}</h1>`);

  // Summary
  h.push(`<div class="summary">`);
  h.push(`<p><strong>${data.areas.length} areas</strong>, <strong>${data.creatures.length} creatures</strong>, <strong>${data.itemCount} items</strong>, <strong>${data.dialogCount} dialogs</strong>, <strong>${data.scriptCount} scripts</strong></p>`);

  // Transitions — collapsed accordion
  if (data.doorLinks.length > 0) {
    h.push(`<details class="accordion"><summary>Module Transitions Overview</summary><div class="accordion-body"><div class="transition-diagram">`);
    for (const link of data.doorLinks) {
      const lockInfo = link.locked ? `, locked (DC ${link.lockDC}${link.keyName ? `, key: ${esc(link.keyName)}` : ""})` : "";
      h.push(`<span class="area-name">${esc(link.fromArea)}</span> <span class="arrow">&mdash;[</span><span class="door-info">${esc(link.fromTag)} &harr; ${esc(link.toTag)}${lockInfo}</span><span class="arrow">]&rarr;</span> <span class="area-name">${esc(link.toArea)}</span><br>`);
    }
    h.push(`</div></div></details>`);
  }

  h.push(`</div><hr class="section-break">`);

  // Build area lookup for cross-linking
  const areaLookup = new Map<string, AreaLookupEntry>();
  for (const area of data.areas) {
    areaLookup.set(area.resref, { name: area.name, tag: area.tag || area.resref });
  }

  // Area sections
  const scripts: string[] = [];
  for (let i = 0; i < data.areas.length; i++) {
    const area = data.areas[i];
    const prefix = area.resref.replace(/[^a-z0-9]/gi, "_");
    const anchorId = `area-${prefix}`;

    const objCounts: Record<string, number> = {};
    for (const obj of area.objects) objCounts[obj.type] = (objCounts[obj.type] ?? 0) + 1;
    const objSummary = Object.entries(objCounts).map(([t, c]) => `${c} ${t}${c > 1 ? "s" : ""}`).join(", ") || "none";

    h.push(`<div class="area-section" id="${anchorId}">`);
    h.push(`<h2>${i + 1}. ${esc(area.name)} <span class="area-tag">${esc(area.resref)} &mdash; ${area.width}&times;${area.height} (${area.width * 10}m &times; ${area.height * 10}m) &mdash; ${esc(area.tilesetName)}</span></h2>`);
    h.push(`<div class="area-subtitle">Objects: ${objSummary}</div>`);
    h.push(renderMapSection(prefix, area, areaLookup));

    // Per-area creature cards accordion
    const areaCreatures = data.creatures.filter(c => c.area === area.resref || c.area === area.name);
    if (areaCreatures.length > 0) {
      h.push(`<details class="accordion"><summary>Area Creatures (${areaCreatures.length})</summary><div class="accordion-body"><div style="display:flex;flex-wrap:wrap;gap:0.3rem;margin:0.3rem 0">`);
      for (const c of areaCreatures) {
        const cls = c.hostile ? "npc-hostile" : "npc-friendly";
        h.push(`<div class="npc-card ${cls}"><span class="npc-name">${esc(c.name)}</span><span class="npc-detail">CR ${c.cr}, HP ${c.hp}, ${esc(c.classes)}${c.hasDialog ? " (dialog)" : ""}</span></div>`);
      }
      h.push(`</div></div></details>`);
    }

    // Per-area placeable cards accordion
    const areaPlaceables = area.objects.filter(o => o.type === "placeable");
    if (areaPlaceables.length > 0) {
      h.push(`<details class="accordion"><summary>Area Placeables (${areaPlaceables.length})</summary><div class="accordion-body"><div style="display:flex;flex-wrap:wrap;gap:0.3rem;margin:0.3rem 0">`);
      for (const p of areaPlaceables) {
        const props: string[] = [];
        props.push(p.useable ? "useable" : "not useable");
        props.push(p.hasInventory ? "has inventory" : "no inventory");
        props.push(p.static ? "static" : "dynamic");
        h.push(`<div class="npc-card" style="border-color:#00d4ff"><span class="npc-name">${esc(p.name)}</span><span class="npc-detail">${props.join(", ")}</span></div>`);
      }
      h.push(`</div></div></details>`);
    }

    h.push(`</div>`);

    scripts.push(tooltipJs(prefix));
  }

  h.push(`</div>`);
  h.push(`<script>${scripts.join("\n")}</script>`);
  h.push(`</body></html>`);

  return h.join("\n");
}

// ─── Legacy wrapper (kept for backward compat) ─────────────────────────────

/** @deprecated Use generateHtmlReportSingleArea instead */
export function generateHtmlMap(
  areaResref: string, areaName: string, width: number, height: number,
  tilesetName: string, grid: TileRenderData[][], features: FeatureLabel[],
  zones: ZoneInfo[], objects?: AreaObjectData[], _options?: HtmlMapOptions,
): string {
  return generateHtmlReportSingleArea({
    resref: areaResref, name: areaName, width, height, tilesetName,
    grid, features, zones, objects: objects ?? [],
  });
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
