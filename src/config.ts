import path from "path";
import os from "os";

/** Path where user-facing reports are saved. When unset, reports go to the module's temp directory. */
export const MCP_FOLDER_USERREPORTS = process.env.MCP_FOLDER_USERREPORTS || "";

/** Path to neverwinter.nim tool binaries (required) */
export const NIM_FOLDER_NWTOOLS = process.env.NIM_FOLDER_NWTOOLS || "";

/** Path to the NWN game install directory — enables base game 2DA/TLK loading */
export const NWN_FOLDER_DATA = process.env.NWN_FOLDER_DATA || "";

/** Path to the NWN user documents directory — enables custom TLK, HAK, override/, development/ */
export const NWN_FOLDER_USER = process.env.NWN_FOLDER_USER || "";

/** Optional Nasher executable. Defaults to PATH resolution. */
export const NASHER_BIN = process.env.NASHER_BIN || "nasher";

/** Optional NWNT executable for diagnostics. Defaults to PATH resolution. */
export const NWNT_BIN = process.env.NWNT_BIN || "nwn_nwnt";

export const TEMP_BASE = process.env.MCP_FOLDER_TEMP || path.join(os.tmpdir(), "nwn-mcp");

export function nimtool(name: string): string {
  return path.join(NIM_FOLDER_NWTOOLS, `${name}.exe`);
}

// GFF file extensions that we can parse to JSON
export const GFF_EXTENSIONS = new Set([
  "are", "git", "gic", "ifo", "uti", "utc", "utp", "utd",
  "utt", "utm", "ute", "utw", "uts", "dlg", "fac", "itp",
  "bic", "jrl", "gui",
]);

// GIT list __struct_id values for placed objects
export const GIT_STRUCT_ID = {
  TRIGGER: 1,
  CREATURE: 4,
  WAYPOINT: 5,
  SOUND: 6,
  ENCOUNTER: 7,
  DOOR: 8,
  PLACEABLE: 9,
  STORE: 11,
} as const;

// Script event field names found in GFF files
export const SCRIPT_FIELDS = new Set([
  "OnHeartbeat", "ScriptHeartbeat", "OnPerception", "ScriptOnNotice",
  "OnSpellCastAt", "ScriptSpellAt", "OnPhysicalAttacked", "ScriptAttacked",
  "OnDamaged", "ScriptDamaged", "OnDeath", "ScriptDeath",
  "OnDisturbed", "ScriptDisturbed", "OnEndRound", "ScriptEndRound",
  "OnConversation", "ScriptDialogue", "OnSpawn", "ScriptSpawn",
  "OnRested", "ScriptRested", "OnUserDefined", "ScriptUserDefine",
  "OnClick", "OnOpen", "OnClose", "OnLock", "OnUnlock",
  "OnUsed", "OnFailToOpen", "OnTrapTriggered", "OnDisarm",
  "OnEnter", "OnExit", "OnExhausted", "OnActivateItem",
  "OnAcquireItem", "OnUnaquireItem", "OnPlayerDeath", "OnPlayerDying",
  "OnPlayerLevelUp", "OnPlayerRest", "OnCutsceneAbort",
  "OnClientEntr", "OnClientLeav", "OnModLoad", "OnModStart",
  "Mod_OnAcquirItem", "Mod_OnActvtItem", "Mod_OnClientEntr",
  "Mod_OnClientLeav", "Mod_OnCutworAbort", "Mod_OnHeartbeat",
  "Mod_OnModLoad", "Mod_OnModStart", "Mod_OnPlrDeath",
  "Mod_OnPlrDying", "Mod_OnPlrEqItm", "Mod_OnPlrLvlUp",
  "Mod_OnPlrRest", "Mod_OnPlrUnEqItm", "Mod_OnSpawnBtnDn",
  "Mod_OnUnAqreItem", "Mod_OnUsrDefined",
  "Script", "Active", "EndConverAbort", "EndConversation",
]);
