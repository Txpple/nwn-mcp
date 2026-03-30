import { describe, it, expect } from "vitest";
import { flattenDialog, renderDialogText, extractDialogScripts } from "./dialog-walker.js";
import type { GffDocument } from "../types/gff.js";

/**
 * Build a minimal DLG document for testing.
 *
 * Structure:
 *   StartingList → Entry 0 ("Hello traveler")
 *     → Reply 0 ("Who are you?")
 *       → Entry 1 ("I am the innkeeper.")
 *     → Reply 1 ("Goodbye") [END]
 */
function makeSimpleDlg(): GffDocument {
  return {
    __data_type: "DLG ",
    EntryList: {
      type: "list",
      value: [
        {
          __struct_id: 0,
          Text: { type: "cexolocstring", value: { "0": "Hello traveler" } },
          Script: { type: "resref", value: "" },
          RepliesList: {
            type: "list",
            value: [
              { __struct_id: 0, Index: { type: "dword", value: 0 }, Active: { type: "resref", value: "" } },
              { __struct_id: 0, Index: { type: "dword", value: 1 }, Active: { type: "resref", value: "" } },
            ],
          },
        },
        {
          __struct_id: 1,
          Text: { type: "cexolocstring", value: { "0": "I am the innkeeper." } },
          Script: { type: "resref", value: "sc_innkeeper" },
          RepliesList: { type: "list", value: [] },
        },
      ],
    },
    ReplyList: {
      type: "list",
      value: [
        {
          __struct_id: 0,
          Text: { type: "cexolocstring", value: { "0": "Who are you?" } },
          Script: { type: "resref", value: "" },
          EntriesList: {
            type: "list",
            value: [
              { __struct_id: 0, Index: { type: "dword", value: 1 }, Active: { type: "resref", value: "" } },
            ],
          },
        },
        {
          __struct_id: 1,
          Text: { type: "cexolocstring", value: { "0": "Goodbye" } },
          Script: { type: "resref", value: "" },
          EntriesList: { type: "list", value: [] },
        },
      ],
    },
    StartingList: {
      type: "list",
      value: [
        { __struct_id: 0, Index: { type: "dword", value: 0 }, Active: { type: "resref", value: "" } },
      ],
    },
  } as unknown as GffDocument;
}

/**
 * DLG with scripts and conditions for extractDialogScripts testing.
 *
 * StartingList → Entry 0 (condition: "sc_check_quest")
 *   → Reply 0 (condition: "sc_has_item")
 *     → Entry 1 (action: "sc_give_reward")
 */
function makeScriptedDlg(): GffDocument {
  return {
    __data_type: "DLG ",
    EntryList: {
      type: "list",
      value: [
        {
          __struct_id: 0,
          Text: { type: "cexolocstring", value: { "0": "You have returned." } },
          Script: { type: "resref", value: "" },
          RepliesList: {
            type: "list",
            value: [
              { __struct_id: 0, Index: { type: "dword", value: 0 }, Active: { type: "resref", value: "sc_has_item" } },
            ],
          },
        },
        {
          __struct_id: 1,
          Text: { type: "cexolocstring", value: { "0": "Well done!" } },
          Script: { type: "resref", value: "sc_give_reward" },
          RepliesList: { type: "list", value: [] },
        },
      ],
    },
    ReplyList: {
      type: "list",
      value: [
        {
          __struct_id: 0,
          Text: { type: "cexolocstring", value: { "0": "Here is the item." } },
          Script: { type: "resref", value: "" },
          EntriesList: {
            type: "list",
            value: [
              { __struct_id: 0, Index: { type: "dword", value: 1 }, Active: { type: "resref", value: "" } },
            ],
          },
        },
      ],
    },
    StartingList: {
      type: "list",
      value: [
        { __struct_id: 0, Index: { type: "dword", value: 0 }, Active: { type: "resref", value: "sc_check_quest" } },
      ],
    },
  } as unknown as GffDocument;
}

/** DLG where entry 0 links to reply 0 which links back to entry 0 (cycle). */
function makeCyclicDlg(): GffDocument {
  return {
    __data_type: "DLG ",
    EntryList: {
      type: "list",
      value: [
        {
          __struct_id: 0,
          Text: { type: "cexolocstring", value: { "0": "Loop start" } },
          Script: { type: "resref", value: "" },
          RepliesList: {
            type: "list",
            value: [
              { __struct_id: 0, Index: { type: "dword", value: 0 }, Active: { type: "resref", value: "" } },
            ],
          },
        },
      ],
    },
    ReplyList: {
      type: "list",
      value: [
        {
          __struct_id: 0,
          Text: { type: "cexolocstring", value: { "0": "Go again" } },
          Script: { type: "resref", value: "" },
          EntriesList: {
            type: "list",
            value: [
              { __struct_id: 0, Index: { type: "dword", value: 0 }, Active: { type: "resref", value: "" } },
            ],
          },
        },
      ],
    },
    StartingList: {
      type: "list",
      value: [
        { __struct_id: 0, Index: { type: "dword", value: 0 }, Active: { type: "resref", value: "" } },
      ],
    },
  } as unknown as GffDocument;
}

describe("flattenDialog", () => {
  it("returns root NPC entry with children", () => {
    const nodes = flattenDialog(makeSimpleDlg());
    expect(nodes).toHaveLength(1);
    expect(nodes[0].type).toBe("npc");
    expect(nodes[0].index).toBe(0);
    expect(nodes[0].text).toBe("Hello traveler");
  });

  it("has correct PC reply children", () => {
    const nodes = flattenDialog(makeSimpleDlg());
    const root = nodes[0];
    expect(root.children).toHaveLength(2);
    expect(root.children[0].type).toBe("pc");
    expect(root.children[0].text).toBe("Who are you?");
    expect(root.children[1].type).toBe("pc");
    expect(root.children[1].text).toBe("Goodbye");
  });

  it("marks leaf nodes correctly", () => {
    const nodes = flattenDialog(makeSimpleDlg());
    const root = nodes[0];
    // "Goodbye" reply has no entries — leaf
    expect(root.children[1].isLeaf).toBe(true);
    // "Who are you?" reply has an entry — not leaf
    expect(root.children[0].isLeaf).toBe(false);
  });

  it("follows reply → entry chain", () => {
    const nodes = flattenDialog(makeSimpleDlg());
    const whoReply = nodes[0].children[0];
    expect(whoReply.children).toHaveLength(1);
    expect(whoReply.children[0].type).toBe("npc");
    expect(whoReply.children[0].text).toBe("I am the innkeeper.");
    expect(whoReply.children[0].script).toBe("sc_innkeeper");
  });

  it("handles cyclic dialogs without infinite recursion", () => {
    const nodes = flattenDialog(makeCyclicDlg());
    expect(nodes).toHaveLength(1);
    // The cycle should be detected — entry 0 appears again and is marked as leaf
    const reply = nodes[0].children[0];
    const loopedEntry = reply.children[0];
    expect(loopedEntry.text).toBe("Loop start");
    expect(loopedEntry.isLeaf).toBe(true);
  });

  it("respects maxDepth", () => {
    const nodes = flattenDialog(makeSimpleDlg(), 0);
    // maxDepth 0 means entry 0 is built but walkEntry won't recurse into replies
    expect(nodes).toHaveLength(1);
    // depth check: walkEntry is called at depth 0 (ok), but walkReply would be at depth 1 (> maxDepth 0)
    // Actually, entry is at depth 0 which is <= maxDepth. Replies are depth+1 = 1.
    // walkReply checks depth > maxDepth: 1 > 0 = true, so returns null.
    expect(nodes[0].children).toHaveLength(0);
  });

  it("returns empty array for dialog with empty starting list", () => {
    const dlg = {
      __data_type: "DLG ",
      EntryList: { type: "list", value: [] },
      ReplyList: { type: "list", value: [] },
      StartingList: { type: "list", value: [] },
    } as unknown as GffDocument;
    expect(flattenDialog(dlg)).toEqual([]);
  });
});

describe("renderDialogText", () => {
  it("renders simple dialog as indented text", () => {
    const nodes = flattenDialog(makeSimpleDlg());
    const text = renderDialogText(nodes);
    expect(text).toContain('[NPC #0] "Hello traveler"');
    expect(text).toContain('[PC #0] "Who are you?"');
    expect(text).toContain('[PC #1] "Goodbye" [END]');
  });

  it("includes script annotations", () => {
    const nodes = flattenDialog(makeSimpleDlg());
    const text = renderDialogText(nodes);
    expect(text).toContain("{runs: sc_innkeeper}");
  });

  it("includes condition annotations", () => {
    const nodes = flattenDialog(makeScriptedDlg());
    const text = renderDialogText(nodes);
    expect(text).toContain("[if: sc_check_quest]");
    expect(text).toContain("[if: sc_has_item]");
  });

  it("indents nested levels", () => {
    const nodes = flattenDialog(makeSimpleDlg());
    const text = renderDialogText(nodes);
    const lines = text.split("\n");
    // Root NPC line should have no indent
    expect(lines[0]).toMatch(/^\[NPC/);
    // PC replies should be indented one level
    const pcLine = lines.find(l => l.includes("[PC #0]"));
    expect(pcLine).toMatch(/^  \[PC/);
  });
});

describe("extractDialogScripts", () => {
  it("finds starting list condition scripts", () => {
    const refs = extractDialogScripts("test_dlg", makeScriptedDlg());
    const startCondition = refs.find(r => r.scriptResref === "sc_check_quest");
    expect(startCondition).toBeDefined();
    expect(startCondition!.fieldName).toBe("Active");
    expect(startCondition!.nodeType).toBe("entry");
    expect(startCondition!.nodeIndex).toBe(0);
  });

  it("finds entry action scripts", () => {
    const refs = extractDialogScripts("test_dlg", makeScriptedDlg());
    const action = refs.find(r => r.scriptResref === "sc_give_reward");
    expect(action).toBeDefined();
    expect(action!.fieldName).toBe("Script");
    expect(action!.nodeType).toBe("entry");
    expect(action!.nodeIndex).toBe(1);
  });

  it("finds reply link condition scripts", () => {
    const refs = extractDialogScripts("test_dlg", makeScriptedDlg());
    const replyCondition = refs.find(r => r.scriptResref === "sc_has_item");
    expect(replyCondition).toBeDefined();
    expect(replyCondition!.fieldName).toBe("Active");
  });

  it("returns empty array for dialog with no scripts", () => {
    const dlg = {
      __data_type: "DLG ",
      EntryList: {
        type: "list",
        value: [{
          __struct_id: 0,
          Text: { type: "cexolocstring", value: { "0": "Hi" } },
          Script: { type: "resref", value: "" },
          RepliesList: { type: "list", value: [] },
        }],
      },
      ReplyList: { type: "list", value: [] },
      StartingList: {
        type: "list",
        value: [
          { __struct_id: 0, Index: { type: "dword", value: 0 }, Active: { type: "resref", value: "" } },
        ],
      },
    } as unknown as GffDocument;
    expect(extractDialogScripts("empty_dlg", dlg)).toEqual([]);
  });

  it("includes dialog resref in all refs", () => {
    const refs = extractDialogScripts("my_dialog", makeScriptedDlg());
    for (const ref of refs) {
      expect(ref.dialog).toBe("my_dialog");
    }
  });

  it("includes text context in refs", () => {
    const refs = extractDialogScripts("test_dlg", makeScriptedDlg());
    const action = refs.find(r => r.scriptResref === "sc_give_reward");
    expect(action!.text).toBe("Well done!");
  });
});
