import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { requireIndex } from "../module-loader.js";
import { jsonToGff } from "../nim-tools.js";
import { numParam, optNumParam, toI } from "../util/params.js";
import { getFieldStr, getFieldNum, getFieldLocStr, getFieldList, setField } from "../types/gff.js";
import type { GffObj } from "../types/gff.js";

export function registerItemTools(server: McpServer): void {

  server.tool(
    "list_items",
    "List all item blueprints in the module.",
    {},
    { readOnlyHint: true, idempotentHint: true },
    async () => {
      const index = requireIndex();
      return { content: [{ type: "text", text: JSON.stringify(index.items, null, 2) }] };
    }
  );

  server.tool(
    "get_item_details",
    "Get full details for an item blueprint including properties.",
    {
      resref: z.string().optional().describe("Item blueprint resref"),
      tag: z.string().optional().describe("Item tag"),
    },
    { readOnlyHint: true, idempotentHint: true },
    async ({ resref, tag }) => {
      const index = requireIndex();

      // Find the item
      let itemDoc: GffObj | null = null;
      let itemKey = "";

      if (resref) {
        const key = `${resref.toLowerCase()}.uti`;
        const doc = index.parsedGff.get(key);
        if (doc) {
          itemDoc = doc as GffObj;
          itemKey = key;
        }
      } else if (tag) {
        for (const [key, doc] of index.parsedGff) {
          if (key.endsWith(".uti")) {
            const docObj = doc as GffObj;
            if (getFieldStr(docObj, "Tag") === tag) {
              itemDoc = docObj;
              itemKey = key;
              break;
            }
          }
        }
      }

      if (!itemDoc) {
        return { content: [{ type: "text", text: "Item not found" }] };
      }

      const properties = getFieldList(itemDoc, "PropertiesList").map(p => ({
        propertyName: getFieldNum(p, "PropertyName"),
        subType: getFieldNum(p, "Subtype"),
        costTable: getFieldNum(p, "CostTable"),
        costValue: getFieldNum(p, "CostValue"),
        param1: getFieldNum(p, "Param1"),
        param1Value: getFieldNum(p, "Param1Value"),
      }));

      const details = {
        resref: itemKey.replace(".uti", ""),
        tag: getFieldStr(itemDoc, "Tag"),
        name: getFieldLocStr(itemDoc, "LocalizedName") || getFieldLocStr(itemDoc, "LocName"),
        description: getFieldLocStr(itemDoc, "Description"),
        identifiedDescription: getFieldLocStr(itemDoc, "DescIdentified"),
        baseItem: getFieldNum(itemDoc, "BaseItem"),
        cost: getFieldNum(itemDoc, "Cost"),
        addCost: getFieldNum(itemDoc, "AddCost"),
        charges: getFieldNum(itemDoc, "Charges"),
        stackSize: getFieldNum(itemDoc, "StackSize"),
        identified: getFieldNum(itemDoc, "Identified"),
        plot: getFieldNum(itemDoc, "Plot"),
        stolen: getFieldNum(itemDoc, "Stolen"),
        cursed: getFieldNum(itemDoc, "Cursed"),
        properties,
      };

      return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }] };
    }
  );

  // ─── add_item_property ────────────────────────────────────────────────

  server.tool(
    "add_item_property",
    "Add a property to an item blueprint's PropertiesList. Use integer row from itempropdef.2da, or text name to search.",
    {
      resref: z.string().describe("Item blueprint resref"),
      propertyName: z.string().describe("Property ID (integer row from itempropdef.2da) or text to search Label column"),
      subType: optNumParam("Subtype value (default 0)"),
      costTable: optNumParam("Cost table index"),
      costValue: optNumParam("Cost value (default 0)"),
      param1: optNumParam("Param1 table index (default 255 = no param)"),
      param1Value: optNumParam("Param1 value (default 0)"),
    },
    { idempotentHint: true },
    async ({ resref, propertyName, subType, costTable, costValue, param1, param1Value }) => {
      const index = requireIndex();
      const key = `${resref.toLowerCase()}.uti`;
      const doc = index.parsedGff.get(key);
      if (!doc) return { content: [{ type: "text", text: `Item not found: ${resref}` }] };

      const entry = index.resources.get(key);
      if (!entry) return { content: [{ type: "text", text: `Item resource not found: ${key}` }] };

      const obj = doc as GffObj;

      // Resolve propertyName — try integer first, then search 2DA
      let propId = parseInt(propertyName, 10);
      let resolvedName = propertyName;
      if (isNaN(propId)) {
        const table = index.twodaTables.get("itempropdef");
        if (!table) return { content: [{ type: "text", text: "itempropdef.2da not loaded — use integer property ID instead." }] };

        const searchLower = propertyName.toLowerCase();
        let foundRow = -1;
        for (const [rowIdx, rowData] of table.rows) {
          const label = (rowData.Label || rowData.label || "").toLowerCase();
          if (label.includes(searchLower)) {
            foundRow = rowIdx;
            resolvedName = rowData.Label || rowData.label || propertyName;
            break;
          }
        }
        if (foundRow < 0) {
          return { content: [{ type: "text", text: `No itempropdef.2da row matching "${propertyName}". Use an integer ID.` }] };
        }
        propId = foundRow;
      }

      // Build property struct
      const costTableN = toI(costTable, 0);
      const prop: GffObj = {
        __struct_id: 0,
        PropertyName: { type: "word", value: propId },
        Subtype: { type: "word", value: toI(subType, 0) },
        CostTable: { type: "byte", value: costTableN },
        CostValue: { type: "word", value: toI(costValue, 0) },
        Param1: { type: "byte", value: toI(param1, 255) },
        Param1Value: { type: "byte", value: toI(param1Value, 0) },
        ChanceAppear: { type: "byte", value: 100 },
      };

      // Get or create PropertiesList
      let propList = getFieldList(obj, "PropertiesList");
      if (!obj.PropertiesList) {
        obj.PropertiesList = { type: "list", value: [] };
        propList = (obj.PropertiesList as { value: GffObj[] }).value;
      }
      propList.push(prop);

      await jsonToGff(doc, entry.filePath);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            resref,
            property: { id: propId, name: resolvedName, subType: toI(subType, 0), costTable: costTableN, costValue: toI(costValue, 0) },
            totalProperties: propList.length,
          }, null, 2),
        }],
      };
    },
  );

  // ─── remove_item_property ─────────────────────────────────────────────

  server.tool(
    "remove_item_property",
    "Remove a property from an item blueprint by index in PropertiesList.",
    {
      resref: z.string().describe("Item blueprint resref"),
      index: numParam("0-based index in PropertiesList"),
    },
    { destructiveHint: true },
    async ({ resref, index: indexStr }) => {
      const removeIdx = toI(indexStr);
      const moduleIndex = requireIndex();
      const key = `${resref.toLowerCase()}.uti`;
      const doc = moduleIndex.parsedGff.get(key);
      if (!doc) return { content: [{ type: "text", text: `Item not found: ${resref}` }] };

      const entry = moduleIndex.resources.get(key);
      if (!entry) return { content: [{ type: "text", text: `Item resource not found: ${key}` }] };

      const obj = doc as GffObj;
      const propList = getFieldList(obj, "PropertiesList");

      if (removeIdx < 0 || removeIdx >= propList.length) {
        return { content: [{ type: "text", text: `Index ${removeIdx} out of range (${propList.length} properties)` }] };
      }

      const removed = propList[removeIdx];
      propList.splice(removeIdx, 1);

      await jsonToGff(doc, entry.filePath);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            resref,
            removedIndex: removeIdx,
            removedProperty: getFieldNum(removed, "PropertyName"),
            remainingProperties: propList.length,
          }, null, 2),
        }],
      };
    },
  );

  // ─── clear_item_properties ────────────────────────────────────────────

  server.tool(
    "clear_item_properties",
    "Remove all properties from an item blueprint.",
    {
      resref: z.string().describe("Item blueprint resref"),
    },
    { destructiveHint: true },
    async ({ resref }) => {
      const index = requireIndex();
      const key = `${resref.toLowerCase()}.uti`;
      const doc = index.parsedGff.get(key);
      if (!doc) return { content: [{ type: "text", text: `Item not found: ${resref}` }] };

      const entry = index.resources.get(key);
      if (!entry) return { content: [{ type: "text", text: `Item resource not found: ${key}` }] };

      const obj = doc as GffObj;
      const prevCount = getFieldList(obj, "PropertiesList").length;
      setField(obj, "PropertiesList", "list", []);

      await jsonToGff(doc, entry.filePath);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({ success: true, resref, propertiesRemoved: prevCount }, null, 2),
        }],
      };
    },
  );
}
