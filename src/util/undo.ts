/**
 * Undo stack for GIT mutations.
 *
 * Stores deep-cloned snapshots of GIT documents before mutations.
 * Max 50 entries; oldest dropped on overflow.
 */

import type { GffDocument } from "../types/gff.js";

export interface UndoEntry {
  toolName: string;
  areaResref: string;
  timestamp: number;
  description: string;
  snapshot: string; // JSON.stringify of the GIT document
}

const MAX_UNDO = 50;
const undoStack: UndoEntry[] = [];

/** Snapshot the current GIT document before a mutation. */
export function snapshotGitForUndo(
  gitDoc: GffDocument,
  areaResref: string,
  toolName: string,
  description: string,
): void {
  const entry: UndoEntry = {
    toolName,
    areaResref,
    timestamp: Date.now(),
    description,
    snapshot: JSON.stringify(gitDoc),
  };
  undoStack.push(entry);
  if (undoStack.length > MAX_UNDO) {
    undoStack.shift();
  }
}

/** Pop the most recent undo entry, or undefined if empty. */
export function popUndo(): UndoEntry | undefined {
  return undoStack.pop();
}

/** Peek at the most recent undo entry without removing it. */
export function peekUndo(): UndoEntry | undefined {
  return undoStack.length > 0 ? undoStack[undoStack.length - 1] : undefined;
}

/** Get the undo stack metadata (without heavy snapshot data). */
export function getUndoStack(): ReadonlyArray<Omit<UndoEntry, "snapshot">> {
  return undoStack.map(({ toolName, areaResref, timestamp, description }) => ({
    toolName,
    areaResref,
    timestamp,
    description,
  }));
}

/** Clear the entire undo stack. Called on module load. */
export function clearUndoStack(): void {
  undoStack.length = 0;
}
