/**
 * SQLite database MCP tools.
 *
 * NWN:EE modules can optionally use SQLite databases located in
 * NWN_FOLDER_USER/database/. These are accessed at runtime via NWScript
 * (SqlPrepareQueryCampaign, etc.) and may ship pre-populated with data.
 *
 * Tools:
 * - list_databases: List .sqlite3 files in the user's database folder
 * - query_database: Run SQL against a named database (SELECT, INSERT, UPDATE, DELETE)
 * - read_database_object: Deserialize a compressed GFF blob from a campaign database
 * - write_database_object: Serialize a GFF document into a compressed blob in a campaign database
 */

import { z } from "zod";
import path from "path";
import fs from "fs/promises";
import fsSync from "fs";
import { decompress } from "fzstd";
import initSqlJs, { type Database } from "sql.js";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { NWN_FOLDER_USER, TEMP_BASE } from "../config.js";
import { numParam, toI } from "../util/params.js";
import { gffToJson } from "../nim-tools.js";

// ─── sql.js singleton ──────────────────────────────────────────────────────
let SQL: Awaited<ReturnType<typeof initSqlJs>> | null = null;

async function getSql(): Promise<NonNullable<typeof SQL>> {
  if (!SQL) {
    SQL = await initSqlJs();
  }
  return SQL!;
}

// ─── CPDB Format ────────────────────────────────────────────────────────────
// NWN:EE stores serialized objects as zstd-compressed GFF blobs in SQLite.
// Header: "CPDB"(4) + version(4) + ?(4) + uncompressed_size(4) + ?(4) + ?(4) + zstd data
const CPDB_HEADER_SIZE = 24;

function decompressCpdb(payload: Buffer): Buffer {
  if (payload.length < CPDB_HEADER_SIZE) {
    throw new Error(`CPDB payload too small (${payload.length} bytes)`);
  }
  const magic = payload.subarray(0, 4).toString("ascii");
  if (magic !== "CPDB") {
    throw new Error(`Invalid CPDB magic: expected "CPDB", got "${magic}"`);
  }
  const compressed = payload.subarray(CPDB_HEADER_SIZE);
  const decompressed = decompress(new Uint8Array(compressed));
  return Buffer.from(decompressed);
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function getDatabaseDir(): string {
  if (!NWN_FOLDER_USER) {
    throw new Error("NWN_FOLDER_USER is not set. Cannot locate database directory.");
  }
  return path.join(NWN_FOLDER_USER, "database");
}

/** Validate database name to prevent path traversal. */
function sanitizeDbName(name: string): string {
  const base = path.basename(name);
  if (base !== name || name.includes("..") || name.includes("/") || name.includes("\\")) {
    throw new Error(`Invalid database name: "${name}". Must be a plain filename.`);
  }
  // Ensure .sqlite3 extension
  if (!base.endsWith(".sqlite3")) {
    return `${base}.sqlite3`;
  }
  return base;
}

const MAX_DB_SIZE = 100 * 1024 * 1024; // 100MB — sql.js loads entire file into memory

async function openDb(name: string): Promise<Database> {
  const SqlJs = await getSql();
  const dbDir = getDatabaseDir();
  const safeName = sanitizeDbName(name);
  const dbPath = path.join(dbDir, safeName);
  const stat = fsSync.statSync(dbPath);
  if (stat.size > MAX_DB_SIZE) {
    throw new Error(`Database too large (${(stat.size / 1024 / 1024).toFixed(1)}MB). sql.js loads the entire file into memory; max supported size is ${MAX_DB_SIZE / 1024 / 1024}MB.`);
  }
  const fileBuffer = fsSync.readFileSync(dbPath);
  return new SqlJs.Database(new Uint8Array(fileBuffer));
}

function saveDb(db: Database, name: string): void {
  const dbDir = getDatabaseDir();
  const safeName = sanitizeDbName(name);
  const dbPath = path.join(dbDir, safeName);
  const data = db.export();
  fsSync.writeFileSync(dbPath, Buffer.from(data));
}

/** Convert sql.js exec result to array-of-objects format. */
function rowsToObjects(result: { columns: string[]; values: any[][] }): Record<string, any>[] {
  return result.values.map((row) => {
    const obj: Record<string, any> = {};
    for (let i = 0; i < result.columns.length; i++) {
      obj[result.columns[i]] = row[i];
    }
    return obj;
  });
}

// ─── Registration ───────────────────────────────────────────────────────────

export function registerDatabaseTools(server: McpServer): void {
  // ── list_databases ──────────────────────────────────────────────────────
  server.tool(
    "list_databases",
    "List SQLite database files in the NWN user database folder, with size and table count. " +
      "Database naming: mod_<module>.sqlite3 for module-level, _<charname>.sqlite3 for local characters, " +
      "<serverid>_<charname>.sqlite3 for server characters, with _hench_tagid_NNN suffixes for henchmen.",
    {},
    { readOnlyHint: true, idempotentHint: true },
    async () => {
      const dbDir = getDatabaseDir();

      let files: string[];
      try {
        files = (await fs.readdir(dbDir)).filter((f) => f.endsWith(".sqlite3"));
      } catch (e: any) {
        if (e.code === "ENOENT") {
          return { content: [{ type: "text" as const, text: `Database directory does not exist: ${dbDir}` }] };
        }
        throw e;
      }

      if (files.length === 0) {
        return { content: [{ type: "text" as const, text: "No .sqlite3 databases found." }] };
      }

      const SqlJs = await getSql();
      const results = [];
      for (const file of files) {
        const filePath = path.join(dbDir, file);
        const stat = await fs.stat(filePath);
        let tableCount = 0;
        try {
          const fileBuffer = fsSync.readFileSync(filePath);
          const db = new SqlJs.Database(new Uint8Array(fileBuffer));
          const res = db.exec("SELECT count(*) as n FROM sqlite_master WHERE type='table'");
          tableCount = res.length > 0 ? (res[0].values[0][0] as number) : 0;
          db.close();
        } catch {
          // Can't open — report what we can
        }
        results.push({
          name: file,
          sizeBytes: stat.size,
          tables: tableCount,
        });
      }

      return { content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }] };
    },
  );

  // ── query_database ──────────────────────────────────────────────────────
  server.tool(
    "query_database",
    "Run a SQL statement against a NWN SQLite database. Returns rows for SELECT/PRAGMA, or change summary for INSERT/UPDATE/DELETE. " +
      "Database name can omit the .sqlite3 extension. " +
      "The main table is 'db' with columns: varname (varchar), playerid (varchar), vartype (tinyint), payload (blob), compressed (bool). " +
      "vartype codes (ASCII char): 70='F' float, 73='I' int, 74='J' json (SetCampaignJson), " +
      "76='L' location (areaId@x:y;z!facing), 79='O' object (StoreCampaignObject, GFF JSON), " +
      "83='S' string, 86='V' vector. " +
      "F/I/L/V are uncompressed ASCII. J/O/S are CPDB/zstd compressed. " +
      "Compressed rows use CPDB/zstd format — use read_database_object to deserialize blobs.",
    {
      database: z.string().describe("Database filename (e.g. 'mymodule' or 'mymodule.sqlite3')"),
      sql: z.string().describe("SQL statement to execute. Use PRAGMA table_info(tablename) to inspect schema."),
      params: z.string().optional().describe("JSON array of bind parameters (e.g. '[\"value1\", 42]')"),
      limit: numParam("Max rows to return for SELECT queries (default 500)").optional(),
    },
    async ({ database, sql, params, limit }) => {
      const maxRows = toI(limit, 500);
      const bindParams = params ? JSON.parse(params) : [];

      // Detect if this is a read or write statement
      const trimmed = sql.trimStart().toUpperCase();
      const isRead = trimmed.startsWith("SELECT") || trimmed.startsWith("PRAGMA") || trimmed.startsWith("EXPLAIN");

      const db = await openDb(database);
      try {
        if (isRead) {
          const stmt = db.prepare(sql);
          if (bindParams.length > 0) stmt.bind(bindParams);
          const rows: Record<string, any>[] = [];
          while (stmt.step()) {
            rows.push(stmt.getAsObject());
          }
          stmt.free();
          const truncated = rows.length > maxRows;
          const result = {
            rows: truncated ? rows.slice(0, maxRows) : rows,
            rowCount: rows.length,
            truncated,
          };
          return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
        }

        // Write operation
        db.run(sql, bindParams);
        const changes = db.getRowsModified();
        saveDb(db, database);
        const result = {
          changes,
        };
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } finally {
        db.close();
      }
    },
  );

  // ── read_database_object ─────────────────────────────────────────────────
  server.tool(
    "read_database_object",
    "Deserialize a compressed GFF blob (creature, item, etc.) from a campaign database. Returns the object as parsed GFF JSON.",
    {
      database: z.string().describe("Database filename (e.g. 'mymodule' or 'mymodule.sqlite3')"),
      varname: z.string().describe("Variable name in the db table (e.g. 'HENCH_TAGID_001')"),
      playerid: z.string().optional().describe("Player ID filter (default: empty string)"),
    },
    { readOnlyHint: true, idempotentHint: true },
    async ({ database, varname, playerid }) => {
      const pid = playerid ?? "";
      const db = await openDb(database);
      let row: { payload: Uint8Array; compressed: number } | undefined;
      try {
        const stmt = db.prepare("SELECT payload, compressed FROM db WHERE varname = ? AND playerid = ?");
        stmt.bind([varname, pid]);
        if (stmt.step()) {
          const obj = stmt.getAsObject();
          row = { payload: obj.payload as Uint8Array, compressed: obj.compressed as number };
        }
        stmt.free();
      } finally {
        db.close();
      }

      if (!row) {
        return { content: [{ type: "text" as const, text: `No row found for varname="${varname}", playerid="${pid}"` }] };
      }

      // Decompress if needed
      let raw: Buffer;
      if (row.compressed) {
        raw = decompressCpdb(Buffer.from(row.payload));
      } else {
        raw = Buffer.from(row.payload);
      }

      // NWN:EE stores GFF as JSON text inside CPDB blobs — check if it's JSON or binary GFF
      const firstByte = raw[0];
      if (firstByte === 0x7b) {
        // JSON text (starts with '{')
        const doc = JSON.parse(raw.toString("utf-8"));
        return { content: [{ type: "text" as const, text: JSON.stringify(doc, null, 2) }] };
      }

      // Binary GFF — pipe through nwn_gff
      const tempGff = path.join(TEMP_BASE, `dbobj_${Date.now()}.gff`);
      await fs.mkdir(TEMP_BASE, { recursive: true });
      await fs.writeFile(tempGff, raw);
      try {
        const doc = await gffToJson(tempGff);
        return { content: [{ type: "text" as const, text: JSON.stringify(doc, null, 2) }] };
      } finally {
        await fs.unlink(tempGff).catch(() => {});
      }
    },
  );

  // ── write_database_object ────────────────────────────────────────────────
  server.tool(
    "write_database_object",
    "Serialize a GFF JSON document into a compressed blob and store it in a campaign database. Use for persisting creatures, items, or other objects.",
    {
      database: z.string().describe("Database filename (e.g. 'mymodule' or 'mymodule.sqlite3')"),
      varname: z.string().describe("Variable name for the db table row"),
      playerid: z.string().optional().describe("Player ID (default: empty string)"),
      data: z.string().describe("GFF document as JSON string"),
    },
    { idempotentHint: true },
    async ({ database, varname, playerid, data }) => {
      const pid = playerid ?? "";
      const doc = JSON.parse(data);

      // Store as uncompressed JSON text (NWN reads both compressed and uncompressed)
      const jsonBytes = Buffer.from(JSON.stringify(doc), "utf-8");

      const db = await openDb(database);
      try {
        // Upsert into db table (vartype 74 = serialized object)
        db.run(
          `INSERT INTO db (varname, playerid, vartype, payload, compressed)
           VALUES (?, ?, 74, ?, 0)
           ON CONFLICT(varname, playerid) DO UPDATE SET
             vartype = 74, payload = excluded.payload, compressed = 0`,
          [varname, pid, jsonBytes],
        );
        saveDb(db, database);
      } finally {
        db.close();
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            database,
            varname,
            playerid: pid,
            compressed: false,
            payloadSize: jsonBytes.length,
          }, null, 2),
        }],
      };
    },
  );
}
