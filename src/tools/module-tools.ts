import { z } from "zod";
import path from "path";
import fs from "fs/promises";
import crypto from "crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadModule } from "../module-loader.js";
import { jsonToGff, erfPack } from "../nim-tools.js";
import { NWN_FOLDER_USER, TEMP_BASE } from "../config.js";
import type { GffDocument, GffObj } from "../types/gff.js";

/** Directory containing template binary files (ITP palettes, FAC factions).
 *  At runtime this resolves to dist/templates/ (compiled) or src/templates/ (tsx dev). */
const TEMPLATES_DIR = path.join(import.meta.dirname, "..", "templates");

/** Template binary files to copy into every new module */
const TEMPLATE_FILES = [
  "creaturepalcus.itp",
  "doorpalcus.itp",
  "encounterpalcus.itp",
  "itempalcus.itp",
  "placeablepalcus.itp",
  "soundpalcus.itp",
  "storepalcus.itp",
  "triggerpalcus.itp",
  "waypointpalcus.itp",
  "Repute.fac",
];

/**
 * Build a template IFO document matching TemplateNewModule settings.
 * Caller must set Mod_Name, Mod_Entry_Area, and Mod_Area_list.
 */
function buildTemplateIfo(moduleName: string, startAreaResref: string): GffDocument {
  return {
    __data_type: "IFO ",
    Expansion_Pack: { type: "word", value: 3 },
    Mod_Area_list: {
      type: "list",
      value: [
        {
          __struct_id: 6,
          Area_Name: { type: "resref", value: startAreaResref },
        },
      ],
    },
    Mod_Creator_ID: { type: "int", value: 2 },
    Mod_CustomTlk: { type: "cexostring", value: "" },
    Mod_CutSceneList: { type: "list", value: [] },
    Mod_DawnHour: { type: "byte", value: 6 },
    Mod_DefaultBic: { type: "resref", value: "" },
    Mod_Description: { type: "cexolocstring", value: {} },
    Mod_DuskHour: { type: "byte", value: 18 },
    Mod_Entry_Area: { type: "resref", value: startAreaResref },
    Mod_Entry_Dir_X: { type: "float", value: 0 },
    Mod_Entry_Dir_Y: { type: "float", value: 1 },
    Mod_Entry_X: { type: "float", value: 15 },
    Mod_Entry_Y: { type: "float", value: 15 },
    Mod_Entry_Z: { type: "float", value: 0 },
    Mod_Expan_List: { type: "list", value: [] },
    Mod_GVar_List: { type: "list", value: [] },
    Mod_HakList: { type: "list", value: [] },
    Mod_ID: {
      type: "void",
      value: crypto.randomBytes(16).toString("base64"),
    },
    Mod_IsSaveGame: { type: "byte", value: 0 },
    Mod_MinGameVer: { type: "cexostring", value: "1.89" },
    Mod_MinPerHour: { type: "byte", value: 2 },
    Mod_Name: { type: "cexolocstring", value: { "0": moduleName } },
    Mod_OnAcquirItem: { type: "resref", value: "x2_mod_def_aqu" },
    Mod_OnActvtItem: { type: "resref", value: "x2_mod_def_act" },
    Mod_OnClientEntr: { type: "resref", value: "x3_mod_def_enter" },
    Mod_OnClientLeav: { type: "resref", value: "" },
    Mod_OnCutsnAbort: { type: "resref", value: "" },
    Mod_OnHeartbeat: { type: "resref", value: "" },
    Mod_OnModLoad: { type: "resref", value: "x2_mod_def_load" },
    Mod_OnModStart: { type: "resref", value: "" },
    Mod_OnNuiEvent: { type: "resref", value: "" },
    Mod_OnPlrChat: { type: "resref", value: "" },
    Mod_OnPlrDeath: { type: "resref", value: "nw_o0_death" },
    Mod_OnPlrDying: { type: "resref", value: "nw_o0_dying" },
    Mod_OnPlrEqItm: { type: "resref", value: "x2_mod_def_equ" },
    Mod_OnPlrGuiEvt: { type: "resref", value: "" },
    Mod_OnPlrLvlUp: { type: "resref", value: "" },
    Mod_OnPlrRest: { type: "resref", value: "x2_mod_def_rest" },
    Mod_OnPlrTarget: { type: "resref", value: "" },
    Mod_OnPlrTileAct: { type: "resref", value: "" },
    Mod_OnPlrUnEqItm: { type: "resref", value: "x2_mod_def_unequ" },
    Mod_OnSpawnBtnDn: { type: "resref", value: "nw_o0_respawn" },
    Mod_OnUnAqreItem: { type: "resref", value: "x2_mod_def_unaqu" },
    Mod_OnUsrDefined: { type: "resref", value: "" },
    Mod_PartyControl: { type: "int", value: 0 },
    Mod_StartDay: { type: "byte", value: 1 },
    Mod_StartHour: { type: "byte", value: 13 },
    Mod_StartMonth: { type: "byte", value: 6 },
    Mod_StartMovie: { type: "resref", value: "" },
    Mod_StartYear: { type: "dword", value: 1372 },
    Mod_Tag: { type: "cexostring", value: "MODULE" },
    Mod_UUID: { type: "cexostring", value: "" },
    Mod_Version: { type: "dword", value: 3 },
    Mod_XPScale: { type: "byte", value: 10 },
  };
}

/** Build a minimal 3x3 MicroSet starter area so the module has a valid entry point. */
function buildStarterArea(): { are: GffDocument; git: GffDocument; gic: GffDocument } {
  const width = 3;
  const height = 3;
  const tileList: GffObj[] = [];
  for (let i = 0; i < width * height; i++) {
    tileList.push({
      __struct_id: i,
      Tile_ID: { type: "int", value: 0 },
      Tile_Orientation: { type: "int", value: 0 },
      Tile_Height: { type: "int", value: 0 },
      Tile_MainLight1: { type: "byte", value: 0 },
      Tile_MainLight2: { type: "byte", value: 0 },
      Tile_SrcLight1: { type: "byte", value: 0 },
      Tile_SrcLight2: { type: "byte", value: 0 },
      Tile_AnimLoop1: { type: "byte", value: 1 },
      Tile_AnimLoop2: { type: "byte", value: 1 },
      Tile_AnimLoop3: { type: "byte", value: 1 },
    });
  }

  const are: GffDocument = {
    __data_type: "ARE ",
    Name: { type: "cexolocstring", value: { "0": "Start" } },
    Tag: { type: "cexostring", value: "_start" },
    ResRef: { type: "resref", value: "_start" },
    Width: { type: "int", value: width },
    Height: { type: "int", value: height },
    Tileset: { type: "resref", value: "tms01" },
    Tile_List: { type: "list", value: tileList },
    Flags: { type: "dword", value: 0 },
    DynAmbientColor: { type: "dword", value: 6316128 },
    IsNight: { type: "byte", value: 0 },
    LightingScheme: { type: "byte", value: 0 },
    SunAmbientColor: { type: "dword", value: 6316128 },
    SunDiffuseColor: { type: "dword", value: 16777215 },
    SunFogColor: { type: "dword", value: 8421504 },
    SunFogAmount: { type: "byte", value: 0 },
    SunShadows: { type: "byte", value: 1 },
    MoonAmbientColor: { type: "dword", value: 2105440 },
    MoonDiffuseColor: { type: "dword", value: 4210816 },
    MoonFogColor: { type: "dword", value: 4210816 },
    MoonFogAmount: { type: "byte", value: 0 },
    MoonShadows: { type: "byte", value: 1 },
    FogClipDist: { type: "float", value: 45.0 },
    SkyBox: { type: "byte", value: 1 },
    WindPower: { type: "int", value: 0 },
    DayNightCycle: { type: "byte", value: 1 },
    ChanceLightning: { type: "int", value: 0 },
    ChanceRain: { type: "int", value: 0 },
    ChanceSnow: { type: "int", value: 0 },
    NoRest: { type: "byte", value: 0 },
    PlayerVsPlayer: { type: "byte", value: 0 },
    OnEnter: { type: "resref", value: "" },
    OnExit: { type: "resref", value: "" },
    OnHeartbeat: { type: "resref", value: "" },
    OnUserDefined: { type: "resref", value: "" },
    Version: { type: "dword", value: 4 },
  };

  const git: GffDocument = {
    __data_type: "GIT ",
    "Creature List": { type: "list", value: [] },
    "Door List": { type: "list", value: [] },
    "Encounter List": { type: "list", value: [] },
    "Placeable List": { type: "list", value: [] },
    SoundList: { type: "list", value: [] },
    StoreList: { type: "list", value: [] },
    "TriggerList": { type: "list", value: [] },
    WaypointList: { type: "list", value: [] },
    List: { type: "list", value: [] },
    AreaProperties: {
      type: "struct",
      value: {
        __struct_id: 0,
        AmbientSndDay: { type: "int", value: 0 },
        AmbientSndDayVol: { type: "int", value: 0 },
        AmbientSndNight: { type: "int", value: 0 },
        AmbientSndNitVol: { type: "int", value: 0 },
        MusicBattle: { type: "int", value: 0 },
        MusicDay: { type: "int", value: 0 },
        MusicDelay: { type: "int", value: 0 },
        MusicNight: { type: "int", value: 0 },
      },
    },
  };

  const gic: GffDocument = {
    __data_type: "GIC ",
    "Creature List": { type: "list", value: [] },
    "Door List": { type: "list", value: [] },
    "Encounter List": { type: "list", value: [] },
    "Placeable List": { type: "list", value: [] },
    SoundList: { type: "list", value: [] },
    StoreList: { type: "list", value: [] },
    "TriggerList": { type: "list", value: [] },
    WaypointList: { type: "list", value: [] },
  };

  return { are, git, gic };
}

export function registerModuleTools(server: McpServer): void {

  server.tool(
    "create_module",
    "Create a new empty module (.mod) from the standard template. Includes default event scripts, factions, and palette files. Creates a small starter area for the entry point. Saves to NWN_FOLDER_USER/modules/ and loads the module.",
    {
      name: z.string().describe("Module display name (e.g., 'The Lost Tomb')"),
      filename: z.string().describe("Module filename without .mod extension (e.g., 'the-lost-tomb')"),
    },
    async ({ name, filename }) => {
      if (!NWN_FOLDER_USER) {
        return { content: [{ type: "text", text: "NWN_FOLDER_USER environment variable is not set. Cannot determine modules directory." }] };
      }

      const safeName = filename.replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase();
      const modPath = path.join(NWN_FOLDER_USER, "modules", `${safeName}.mod`);

      // Check if module already exists
      try {
        await fs.access(modPath);
        return { content: [{ type: "text", text: `Module already exists: ${modPath}` }] };
      } catch { /* good — doesn't exist */ }

      // Create a temp assembly directory
      const assemblyDir = path.join(TEMP_BASE, `_create_${safeName}_${Date.now()}`);
      await fs.mkdir(assemblyDir, { recursive: true });

      try {
        // 1. Copy template binary files (ITP palettes + FAC factions)
        for (const file of TEMPLATE_FILES) {
          const src = path.join(TEMPLATES_DIR, file);
          const dest = path.join(assemblyDir, file);
          await fs.copyFile(src, dest);
        }

        // 2. Build and write IFO
        const startAreaResref = "_start";
        const ifoDoc = buildTemplateIfo(name, startAreaResref);
        await jsonToGff(ifoDoc, path.join(assemblyDir, "module.ifo"));

        // 3. Build and write starter area
        const { are, git, gic } = buildStarterArea();
        await jsonToGff(are, path.join(assemblyDir, `${startAreaResref}.are`));
        await jsonToGff(git, path.join(assemblyDir, `${startAreaResref}.git`));
        await jsonToGff(gic, path.join(assemblyDir, `${startAreaResref}.gic`));

        // 4. Pack into .mod
        await erfPack(assemblyDir, modPath);

        // 5. Load the new module
        const index = await loadModule(modPath);

        const stat = await fs.stat(modPath);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              moduleName: name,
              filename: `${safeName}.mod`,
              modPath,
              sizeBytes: stat.size,
              resourceCount: index.resources.size,
              areas: [...index.areas.keys()],
              startArea: startAreaResref,
              entryPosition: { x: 15, y: 15, z: 0 },
            }, null, 2),
          }],
        };
      } finally {
        // Clean up assembly dir
        await fs.rm(assemblyDir, { recursive: true, force: true }).catch(() => {});
      }
    }
  );
}
