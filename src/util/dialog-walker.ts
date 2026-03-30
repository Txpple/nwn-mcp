import { getFieldStr, getFieldLocStr, getFieldList, getFieldNum } from "../types/gff.js";
import type { GffDocument, GffObj } from "../types/gff.js";
import type { FlatDialogNode, DialogScriptRef } from "../types/dialog.js";

/**
 * Flatten a DLG document into a readable tree structure.
 */
export function flattenDialog(dlg: GffDocument, maxDepth: number = 10): FlatDialogNode[] {
  const entries = getFieldList(dlg as GffObj, "EntryList");
  const replies = getFieldList(dlg as GffObj, "ReplyList");
  const startingList = getFieldList(dlg as GffObj, "StartingList");

  const visited = new Set<string>();
  const roots: FlatDialogNode[] = [];

  for (const start of startingList) {
    const idx = getFieldNum(start, "Index");
    const active = getFieldStr(start, "Active");
    const node = walkEntry(entries, replies, idx, active, visited, 0, maxDepth);
    if (node) roots.push(node);
  }

  return roots;
}

function walkEntry(
  entries: GffObj[],
  replies: GffObj[],
  entryIdx: number,
  condition: string | undefined,
  visited: Set<string>,
  depth: number,
  maxDepth: number
): FlatDialogNode | null {
  const key = `entry:${entryIdx}`;
  if (depth > maxDepth) return null;
  if (entryIdx < 0 || entryIdx >= entries.length) return null;

  const entry = entries[entryIdx];
  const text = getFieldLocStr(entry, "Text");
  const script = getFieldStr(entry, "Script");
  const replyLinks = getFieldList(entry, "RepliesList");

  const isRecursive = visited.has(key);
  const node: FlatDialogNode = {
    type: "npc",
    index: entryIdx,
    text,
    script: script || undefined,
    condition: condition || undefined,
    children: [],
    isLeaf: replyLinks.length === 0 || isRecursive,
  };

  if (isRecursive) return node;
  visited.add(key);

  for (const link of replyLinks) {
    const replyIdx = getFieldNum(link, "Index");
    const replyActive = getFieldStr(link, "Active");
    const child = walkReply(entries, replies, replyIdx, replyActive, visited, depth + 1, maxDepth);
    if (child) node.children.push(child);
  }

  visited.delete(key); // Allow same node in different branches
  return node;
}

function walkReply(
  entries: GffObj[],
  replies: GffObj[],
  replyIdx: number,
  condition: string | undefined,
  visited: Set<string>,
  depth: number,
  maxDepth: number
): FlatDialogNode | null {
  if (depth > maxDepth) return null;
  if (replyIdx < 0 || replyIdx >= replies.length) return null;

  const reply = replies[replyIdx];
  const text = getFieldLocStr(reply, "Text");
  const script = getFieldStr(reply, "Script");
  const entryLinks = getFieldList(reply, "EntriesList");

  const node: FlatDialogNode = {
    type: "pc",
    index: replyIdx,
    text,
    script: script || undefined,
    condition: condition || undefined,
    children: [],
    isLeaf: entryLinks.length === 0,
  };

  for (const link of entryLinks) {
    const entryIdx = getFieldNum(link, "Index");
    const entryActive = getFieldStr(link, "Active");
    const child = walkEntry(entries, replies, entryIdx, entryActive, visited, depth + 1, maxDepth);
    if (child) node.children.push(child);
  }

  return node;
}

/** Render a flat dialog tree as indented text */
export function renderDialogText(nodes: FlatDialogNode[], indent: number = 0): string {
  const lines: string[] = [];
  const pad = "  ".repeat(indent);

  for (const node of nodes) {
    const prefix = node.type === "npc" ? "NPC" : "PC";
    const condStr = node.condition ? ` [if: ${node.condition}]` : "";
    const scriptStr = node.script ? ` {runs: ${node.script}}` : "";
    const leafStr = node.isLeaf && node.children.length === 0 ? " [END]" : "";

    lines.push(`${pad}[${prefix} #${node.index}]${condStr} "${node.text}"${scriptStr}${leafStr}`);

    if (node.children.length > 0) {
      lines.push(renderDialogText(node.children, indent + 1));
    }
  }

  return lines.join("\n");
}

/** Extract all script references from a DLG document */
export function extractDialogScripts(dialogResref: string, dlg: GffDocument): DialogScriptRef[] {
  const refs: DialogScriptRef[] = [];
  const entries = getFieldList(dlg as GffObj, "EntryList");
  const replies = getFieldList(dlg as GffObj, "ReplyList");
  const startingList = getFieldList(dlg as GffObj, "StartingList");

  // Starting conditions
  for (const start of startingList) {
    const active = getFieldStr(start, "Active");
    if (active) {
      const idx = getFieldNum(start, "Index");
      const text = idx < entries.length ? getFieldLocStr(entries[idx], "Text") : "";
      refs.push({ dialog: dialogResref, nodeType: "entry", nodeIndex: idx, fieldName: "Active", scriptResref: active, text });
    }
  }

  // Entry scripts and conditions
  entries.forEach((entry, i) => {
    const script = getFieldStr(entry, "Script");
    const text = getFieldLocStr(entry, "Text");
    if (script) {
      refs.push({ dialog: dialogResref, nodeType: "entry", nodeIndex: i, fieldName: "Script", scriptResref: script, text });
    }
    // Check reply link conditions
    for (const link of getFieldList(entry, "RepliesList")) {
      const active = getFieldStr(link, "Active");
      if (active) {
        const replyIdx = getFieldNum(link, "Index");
        refs.push({ dialog: dialogResref, nodeType: "reply", nodeIndex: replyIdx, fieldName: "Active", scriptResref: active, text });
      }
    }
  });

  // Reply scripts and conditions
  replies.forEach((reply, i) => {
    const script = getFieldStr(reply, "Script");
    const text = getFieldLocStr(reply, "Text");
    if (script) {
      refs.push({ dialog: dialogResref, nodeType: "reply", nodeIndex: i, fieldName: "Script", scriptResref: script, text });
    }
    for (const link of getFieldList(reply, "EntriesList")) {
      const active = getFieldStr(link, "Active");
      if (active) {
        const entryIdx = getFieldNum(link, "Index");
        refs.push({ dialog: dialogResref, nodeType: "entry", nodeIndex: entryIdx, fieldName: "Active", scriptResref: active, text });
      }
    }
  });

  return refs;
}
