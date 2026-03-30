/**
 * Equipment slot constants shared between blueprint creation and creature equipment tools.
 */

/** Equipment slot name → __struct_id bitmask */
export const EQUIP_SLOT_MAP: Record<string, number> = {
  head: 1, chest: 2, boots: 4, arms: 8,
  righthand: 16, lefthand: 32, cloak: 64,
  leftring: 128, rightring: 256, neck: 512,
  belt: 1024, arrows: 2048, bullets: 4096, bolts: 8192,
};

/** __struct_id bitmask → slot name (reverse map) */
export const EQUIP_SLOT_NAMES: Record<number, string> = Object.fromEntries(
  Object.entries(EQUIP_SLOT_MAP).map(([name, id]) => [id, name]),
);
