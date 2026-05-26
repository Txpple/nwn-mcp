import path from "path";
import { describe, expect, it } from "vitest";
import { buildNasherPackArgs, buildNasherUnpackArgs, parseNasherTargets } from "./nasher-adapter.js";

describe("nasher adapter command args", () => {
  it("builds pack args with optional target and clean flag", () => {
    expect(buildNasherPackArgs("demo", true)).toEqual([
      "pack",
      "demo",
      "--clean",
      "--packUnchanged",
      "--overwritePackedFile:always",
      "--no-color",
    ]);
  });

  it("builds unpack args with cache file safety flags", () => {
    expect(buildNasherUnpackArgs("demo", "D:\\cache\\demo")).toEqual([
      "unpack",
      "demo",
      "--file:D:\\cache\\demo",
      "--removeDeleted:false",
      "--onMultipleSources:error",
      "--default",
      "--no-color",
    ]);
  });

  it("can remove deleted resources during unpack when requested", () => {
    expect(buildNasherUnpackArgs("demo", "D:\\cache\\demo", { removeDeleted: true })).toContain("--removeDeleted:true");
  });
});

describe("parseNasherTargets", () => {
  it("parses common list output shapes", () => {
    const root = path.resolve("D:\\projects\\sample");
    const targets = parseNasherTargets(
      `
Targets:
* demo: modules/demo.mod
- shared => hak/shared.hak
plain_target plain_target.mod
`,
      root,
    );

    expect(targets.map((target) => target.name)).toEqual(["demo", "shared", "plain_target"]);
    expect(targets[0].isDefault).toBe(true);
    expect(targets[0].targetFile).toBe(path.resolve(root, "modules/demo.mod"));
    expect(targets[1].targetFile).toBe(path.resolve(root, "hak/shared.hak"));
  });
});
