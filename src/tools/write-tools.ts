import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import fs from "fs/promises";
import path from "path";
import { z } from "zod";
import { buildResmanOptions, requireIndex } from "../module-loader.js";
import { erfPack, gffToJson, jsonToGff } from "../nim-tools.js";
import type { GffDocument, GffObj } from "../types/gff.js";
import { setField } from "../types/gff.js";
import { setGffByPath } from "../util/gff-path.js";
import { resolveBlueprint } from "../util/git-helpers.js";
import { optNumParam, toI } from "../util/params.js";

export function registerWriteTools(server: McpServer): void {
  server.tool(
    "modify_gff_field",
    "Modify a field in a GFF resource by dot-path. Example path: 'Creature List.0.ChallengeRating'",
    {
      resource: z.string().describe("Resource resref (e.g., 'innkey')"),
      type: z.string().describe("Resource extension (e.g., 'uti')"),
      path: z.string().describe("Dot-separated path to the field"),
      value: z.unknown().describe("New value to set"),
      gffType: z.string().optional().describe("GFF type if creating a new field (e.g., 'dword', 'cexostring')"),
    },
    { idempotentHint: true },
    async ({ resource, type, path: fieldPath, value, gffType }) => {
      const index = requireIndex();
      const key = `${resource.toLowerCase()}.${type.toLowerCase()}`;

      // Get cached or parse fresh
      let doc = index.parsedGff.get(key);
      const entry = index.resources.get(key);
      if (!entry) return { content: [{ type: "text", text: `Resource not found: ${key}` }] };

      if (!doc) {
        doc = await gffToJson(entry.filePath);
        index.parsedGff.set(key, doc);
      }

      const result = setGffByPath(doc, fieldPath, value, gffType);

      if ("error" in result) {
        return { content: [{ type: "text", text: `Error: ${result.error}` }] };
      }

      // Write back to binary
      await jsonToGff(doc, entry.filePath);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                success: true,
                resource: key,
                path: fieldPath,
                previousValue: result.previousValue,
                newValue: value,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.tool(
    "repack_module",
    "Repack the extracted module files into a .mod file.",
    {
      outputPath: z.string().optional().describe("Output path for the .mod file. Defaults to original location."),
    },
    { idempotentHint: true },
    async ({ outputPath }) => {
      const index = requireIndex();
      const outPath = outputPath ? path.resolve(outputPath) : index.modPath;

      await erfPack(index.tempDir, outPath);

      const stat = await fs.stat(outPath);
      const warnings =
        index.sourceContext?.type === "nasher"
          ? [
              `Loaded module is backed by Nasher cache. Supported write tools auto-sync to ${index.sourceContext.workspaceRoot}; repack_module only writes the packed module file.`,
            ]
          : [];
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                success: true,
                outputPath: outPath,
                sizeBytes: stat.size,
                warningCount: warnings.length,
                warnings,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.tool(
    "create_item_blueprint",
    "Create a new item blueprint (.uti) in the module. Optionally clone from a base game or module item and apply overrides.",
    {
      resref: z.string().describe("New item resref (filename without extension)"),
      tag: z.string().describe("Item tag"),
      name: z.string().describe("Item display name"),
      baseItem: z.string().describe("Base item type ID (e.g., 4 for sword, 40 for key)"),
      sourceResref: z.string().optional().describe("Base item to clone from (e.g. 'nw_wswls001', 'nw_it_mpotion001')"),
      cost: optNumParam("Item cost in gold"),
      description: z.string().optional().describe("Item description"),
      plot: z.boolean().optional().describe("Whether item is a plot item"),
      stackSize: optNumParam("Stack size (default 1)"),
      charges: optNumParam("Number of charges (default 0)"),
      addCost: optNumParam("Additional cost modifier"),
      properties: z
        .string()
        .optional()
        .describe(
          "JSON array of item properties. Each: {propertyName, subType, costTable, costValue, param1?, param1Value?}. PropertyName from itempropdef.2da. Common: 56=Enhancement Bonus (costValue=bonus 1-20), 16=Damage Bonus (subType=damage type, costTable=2, costValue=amount), 0=Ability Bonus (subType=ability 0-5, costValue=bonus)",
        ),
    },
    async ({
      resref,
      tag,
      name,
      baseItem,
      sourceResref,
      cost,
      description,
      plot,
      stackSize,
      charges,
      addCost,
      properties,
    }) => {
      const index = requireIndex();
      const resrefLower = resref.toLowerCase();
      const key = `${resrefLower}.uti`;

      if (index.resources.has(key)) {
        return { content: [{ type: "text", text: `Resource already exists: ${key}` }] };
      }

      const needsResman = !!sourceResref;
      const resmanOpts = needsResman ? await buildResmanOptions(index) : undefined;

      let doc: GffDocument;

      if (sourceResref) {
        // Clone from source
        const source = await resolveBlueprint(index, sourceResref, "uti", resmanOpts!);
        if (!source) {
          return { content: [{ type: "text", text: `Source blueprint not found: ${sourceResref}.uti` }] };
        }
        doc = source;
      } else {
        // Build minimal UTI from scratch
        doc = {
          __data_type: "UTI ",
          AddCost: { type: "dword", value: 0 },
          BaseItem: { type: "int", value: toI(baseItem) },
          Charges: { type: "byte", value: 0 },
          Cost: { type: "dword", value: 0 },
          Cursed: { type: "byte", value: 0 },
          Description: { type: "cexolocstring", value: {} },
          DescIdentified: { type: "cexolocstring", value: {} },
          Identified: { type: "byte", value: 1 },
          LocalizedName: { type: "cexolocstring", value: { "0": name } },
          ModelPart1: { type: "byte", value: 1 },
          Plot: { type: "byte", value: 0 },
          PropertiesList: { type: "list", value: [] },
          StackSize: { type: "word", value: 1 },
          Stolen: { type: "byte", value: 0 },
          Tag: { type: "cexostring", value: tag },
          TemplateResRef: { type: "resref", value: resrefLower },
        };
      }

      const obj = doc as GffObj;

      // Apply overrides (always set tag, resref, name)
      setField(obj, "Tag", "cexostring", tag);
      setField(obj, "TemplateResRef", "resref", resrefLower);
      obj.LocalizedName = { type: "cexolocstring", value: { "0": name } };

      if (baseItem !== undefined) setField(obj, "BaseItem", "int", toI(baseItem));
      if (cost !== undefined) setField(obj, "Cost", "dword", toI(cost));
      if (addCost !== undefined) setField(obj, "AddCost", "dword", toI(addCost));
      if (description !== undefined) {
        obj.Description = { type: "cexolocstring", value: { "0": description } };
        obj.DescIdentified = { type: "cexolocstring", value: { "0": description } };
      }
      if (plot !== undefined) setField(obj, "Plot", "byte", plot ? 1 : 0);
      if (stackSize !== undefined) setField(obj, "StackSize", "word", toI(stackSize));
      if (charges !== undefined) setField(obj, "Charges", "byte", toI(charges));

      // Item properties — replaces PropertiesList
      if (properties) {
        const parsed: Array<{
          propertyName: number;
          subType: number;
          costTable: number;
          costValue: number;
          param1?: number;
          param1Value?: number;
        }> = JSON.parse(properties);

        obj.PropertiesList = {
          type: "list",
          value: parsed.map((p) => ({
            __struct_id: 0,
            PropertyName: { type: "word", value: p.propertyName },
            Subtype: { type: "word", value: p.subType },
            CostTable: { type: "byte", value: p.costTable },
            CostValue: { type: "word", value: p.costValue },
            Param1: { type: "byte", value: p.param1 ?? 255 },
            Param1Value: { type: "byte", value: p.param1Value ?? 0 },
            ChanceAppear: { type: "byte", value: 100 },
          })),
        };
      }

      // Write to disk
      const filePath = path.join(index.tempDir, `${resrefLower}.uti`);
      await jsonToGff(doc, filePath);

      // Add to index
      const stat = await fs.stat(filePath);
      index.resources.set(key, {
        resref: resrefLower,
        extension: "uti",
        filePath,
        sizeBytes: stat.size,
      });
      index.parsedGff.set(key, doc);

      const result: Record<string, unknown> = {
        success: true,
        created: key,
        tag,
        name,
        source: sourceResref || "scratch",
        baseItem: toI(baseItem),
        sizeBytes: stat.size,
      };

      if (properties) {
        const parsed = JSON.parse(properties);
        result.propertiesCount = parsed.length;
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    },
  );

  server.tool(
    "clone_resource",
    "Clone an existing resource with a new resref.",
    {
      sourceResref: z.string().describe("Source resource resref"),
      sourceType: z.string().describe("Source resource extension"),
      newResref: z.string().describe("New resref for the clone"),
    },
    async ({ sourceResref, sourceType, newResref }) => {
      const index = requireIndex();
      const sourceKey = `${sourceResref.toLowerCase()}.${sourceType.toLowerCase()}`;
      const newKey = `${newResref.toLowerCase()}.${sourceType.toLowerCase()}`;

      if (index.resources.has(newKey)) {
        return { content: [{ type: "text", text: `Resource already exists: ${newKey}` }] };
      }

      const sourceEntry = index.resources.get(sourceKey);
      if (!sourceEntry) {
        return { content: [{ type: "text", text: `Source not found: ${sourceKey}` }] };
      }

      const newFilePath = path.join(index.tempDir, `${newResref.toLowerCase()}.${sourceType.toLowerCase()}`);

      // For GFF files, parse, update TemplateResRef, and write back
      if (index.parsedGff.has(sourceKey)) {
        const doc = JSON.parse(JSON.stringify(index.parsedGff.get(sourceKey))) as GffDocument;
        // Update internal resref
        const obj = doc as GffObj;
        const templateField = obj.TemplateResRef as { type: string; value: string } | undefined;
        if (templateField) {
          templateField.value = newResref.toLowerCase();
        }
        await jsonToGff(doc, newFilePath);
        index.parsedGff.set(newKey, doc);
      } else {
        // Binary copy
        await fs.copyFile(sourceEntry.filePath, newFilePath);
      }

      const stat = await fs.stat(newFilePath);
      index.resources.set(newKey, {
        resref: newResref.toLowerCase(),
        extension: sourceType.toLowerCase(),
        filePath: newFilePath,
        sizeBytes: stat.size,
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                success: true,
                source: sourceKey,
                created: newKey,
                sizeBytes: stat.size,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.tool(
    "export_resource",
    "Extract a single resource file from the module to a specified path on disk.",
    {
      resref: z.string().describe("Resource name without extension"),
      type: z.string().describe("Resource extension (e.g., 'uti', 'nss', 'dlg')"),
      outputPath: z.string().describe("Absolute path to write the file to"),
    },
    { idempotentHint: true },
    async ({ resref, type: resType, outputPath }) => {
      const index = requireIndex();
      const key = `${resref.toLowerCase()}.${resType.toLowerCase()}`;
      const entry = index.resources.get(key);
      if (!entry) {
        return { content: [{ type: "text", text: `Resource not found: ${key}` }] };
      }

      const absOutput = path.resolve(outputPath);
      const outDir = path.dirname(absOutput);
      await fs.mkdir(outDir, { recursive: true });
      await fs.copyFile(entry.filePath, absOutput);
      const stat = await fs.stat(absOutput);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                success: true,
                resource: key,
                outputPath: absOutput,
                sizeBytes: stat.size,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );
}
