/**
 * Shared parameter helpers for MCP tool handlers.
 *
 * MCP SDK validates JSON Schema before Zod transforms execute, so z.coerce.number()
 * and z.union([z.number(), z.string().transform()]) both fail when clients send strings.
 * All numeric tool params must use z.string() + manual parse.
 */

import { z } from "zod";

/** z.string() schema for a required numeric param */
export const numParam = (desc: string) => z.string().describe(desc);

/** z.string().optional() schema for an optional numeric param */
export const optNumParam = (desc: string) => z.string().optional().describe(desc);

/** Parse a string/number param to float, with default */
export const toF = (v: string | number | undefined, def = 0): number =>
  v === undefined ? def : parseFloat(String(v));

/** Parse a string/number param to int, with default */
export const toI = (v: string | number | undefined, def = 0): number =>
  v === undefined ? def : parseInt(String(v), 10);
