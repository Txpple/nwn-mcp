import { z } from "zod";
import path from "path";
import fsPromises from "fs/promises";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { requireIndex, buildResmanOptions } from "../module-loader.js";
import { readTextFile, disassembleNcs, compileScript } from "../nim-tools.js";
import type { VariableRef } from "../types/script.js";

export function registerScriptTools(server: McpServer): void {

  server.tool(
    "read_script_source",
    "Read the NWScript (.nss) source code for a script.",
    { resref: z.string().describe("Script resref without extension") },
    { readOnlyHint: true, idempotentHint: true },
    async ({ resref }) => {
      const index = requireIndex();
      const key = `${resref.toLowerCase()}.nss`;
      const entry = index.resources.get(key);
      if (!entry) return { content: [{ type: "text", text: `Script source not found: ${resref}.nss` }] };

      const text = await readTextFile(entry.filePath);
      return { content: [{ type: "text", text }] };
    }
  );

  server.tool(
    "disassemble_script",
    "Disassemble compiled NWScript (.ncs) bytecode.",
    { resref: z.string().describe("Script resref without extension") },
    { readOnlyHint: true, idempotentHint: true },
    async ({ resref }) => {
      const index = requireIndex();
      const key = `${resref.toLowerCase()}.ncs`;
      const entry = index.resources.get(key);
      if (!entry) return { content: [{ type: "text", text: `Compiled script not found: ${resref}.ncs` }] };

      try {
        const text = await disassembleNcs(entry.filePath);
        return { content: [{ type: "text", text }] };
      } catch (e) {
        return { content: [{ type: "text", text: `Disassembly failed: ${e}` }] };
      }
    }
  );

  server.tool(
    "compile_script",
    "Compile a NWScript (.nss) source file to bytecode (.ncs).",
    {
      resref: z.string().describe("Script resref without extension"),
      includePaths: z.array(z.string()).optional().describe("Additional include paths for nwscript.nss etc."),
    },
    { idempotentHint: true },
    async ({ resref, includePaths }) => {
      const index = requireIndex();
      const nssKey = `${resref.toLowerCase()}.nss`;
      const entry = index.resources.get(nssKey);
      if (!entry) return { content: [{ type: "text", text: `Script source not found: ${resref}.nss` }] };

      const ncsPath = entry.filePath.replace(/\.nss$/i, ".ncs");
      const resman = await buildResmanOptions(index);
      const result = await compileScript(entry.filePath, ncsPath, {
        includePaths,
        resman,
      });

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: result.success,
            output: result.output,
            sourceFile: entry.filePath,
            outputFile: result.success ? ncsPath : undefined,
          }, null, 2),
        }],
      };
    }
  );

  server.tool(
    "find_variable_usage",
    "Find all scripts that use Get/SetLocal* functions with a given variable name.",
    { variableName: z.string().describe("Variable name to search for") },
    { readOnlyHint: true, idempotentHint: true },
    async ({ variableName }) => {
      const index = requireIndex();
      const results: VariableRef[] = [];

      // Search all .nss source files
      for (const [_key, entry] of index.resources) {
        if (entry.extension !== "nss") continue;

        try {
          const source = await readTextFile(entry.filePath);
          const lines = source.split("\n");

          for (let i = 0; i < lines.length; i++) {
            const line = lines[i];

            // Match GetLocal*/SetLocal*/DeleteLocal* calls
            const patterns = [
              { regex: /GetLocal(Int|String|Float|Object|Location)\s*\([^,]+,\s*"([^"]+)"/g, op: "get" as const },
              { regex: /SetLocal(Int|String|Float|Object|Location)\s*\([^,]+,\s*"([^"]+)"/g, op: "set" as const },
              { regex: /DeleteLocal(Int|String|Float|Object|Location)\s*\([^,]+,\s*"([^"]+)"/g, op: "delete" as const },
            ];

            for (const { regex, op } of patterns) {
              let match: RegExpExecArray | null = null;
              while ((match = regex.exec(line)) !== null) {
                if (match[2] === variableName || match[2].toLowerCase().includes(variableName.toLowerCase())) {
                  results.push({
                    name: match[2],
                    operation: op,
                    type: match[1].toLowerCase() as VariableRef["type"],
                    scriptResref: entry.resref,
                    line: i + 1,
                    context: line.trim(),
                  });
                }
              }
            }
          }
        } catch {
          // Skip unreadable files
        }
      }

      return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
    }
  );

  server.tool(
    "search_scripts",
    "Search across all NWScript (.nss) source files for a text pattern.",
    {
      pattern: z.string().describe("Text or pattern to search for"),
      caseSensitive: z.boolean().optional().describe("Case-sensitive search (default: false)"),
    },
    { readOnlyHint: true, idempotentHint: true },
    async ({ pattern, caseSensitive }) => {
      const index = requireIndex();
      const results: Array<{ resref: string; line: number; context: string }> = [];

      for (const [, entry] of index.resources) {
        if (entry.extension !== "nss") continue;
        try {
          const source = await readTextFile(entry.filePath);
          const lines = source.split("\n");
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const matches = caseSensitive
              ? line.includes(pattern)
              : line.toLowerCase().includes(pattern.toLowerCase());
            if (matches) {
              results.push({
                resref: entry.resref,
                line: i + 1,
                context: line.trim(),
              });
            }
          }
        } catch { /* skip unreadable */ }
      }

      return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
    }
  );

  server.tool(
    "list_script_references",
    "Show where scripts are referenced from in GFF files (event handlers, dialog actions, etc.).",
    { resref: z.string().optional().describe("Specific script resref, or omit to list all") },
    { readOnlyHint: true, idempotentHint: true },
    async ({ resref }) => {
      const index = requireIndex();

      if (resref) {
        const usages = index.scripts.get(resref.toLowerCase()) || [];
        return { content: [{ type: "text", text: JSON.stringify(usages, null, 2) }] };
      }

      // Return all script references grouped by script
      const grouped: Record<string, Array<{ resourceFile: string; gffPath: string; usageType: string }>> = {};
      for (const [scriptName, usages] of index.scripts) {
        grouped[scriptName] = usages.map(u => ({
          resourceFile: u.resourceFile,
          gffPath: u.gffPath,
          usageType: u.usageType,
        }));
      }

      return { content: [{ type: "text", text: JSON.stringify(grouped, null, 2) }] };
    }
  );

  // ─── write_script ─────────────────────────────────────────────────────

  server.tool(
    "write_script",
    "Write NWScript (.nss) source code to the module and optionally compile it. Creates or overwrites the .nss file. Use for creating new scripts or editing existing ones.",
    {
      resref: z.string().describe("Script resref without extension"),
      source: z.string().describe("The NWScript source code to write"),
      compile: z.boolean().optional().describe("Compile after writing (default true)"),
    },
    { idempotentHint: true },
    async ({ resref, source, compile: doCompile }) => {
      const index = requireIndex();
      const resrefLower = resref.toLowerCase();
      const nssKey = `${resrefLower}.nss`;
      const ncsKey = `${resrefLower}.ncs`;

      // Write .nss file
      const nssPath = path.join(index.tempDir, `${resrefLower}.nss`);
      await fsPromises.writeFile(nssPath, source, "utf-8");

      // Register in index
      const nssStat = await fsPromises.stat(nssPath);
      index.resources.set(nssKey, {
        resref: resrefLower,
        extension: "nss",
        filePath: nssPath,
        sizeBytes: nssStat.size,
      });

      const result: Record<string, unknown> = {
        success: true,
        written: nssKey,
        sizeBytes: nssStat.size,
      };

      // Compile if requested (default true)
      if (doCompile !== false) {
        const ncsPath = nssPath.replace(/\.nss$/i, ".ncs");
        const resman = await buildResmanOptions(index);
        const compResult = await compileScript(nssPath, ncsPath, { resman });

        result.compiled = compResult.success;
        result.compilerOutput = compResult.output;

        if (compResult.success) {
          const ncsStat = await fsPromises.stat(ncsPath);
          index.resources.set(ncsKey, {
            resref: resrefLower,
            extension: "ncs",
            filePath: ncsPath,
            sizeBytes: ncsStat.size,
          });
          result.compiledFile = ncsKey;
          result.compiledSize = ncsStat.size;
        }
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2),
        }],
      };
    }
  );
}
