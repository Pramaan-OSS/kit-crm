import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

type Journey = { id: string; status: string; capability?: string };
const manifest = JSON.parse(readFileSync("pramaan.kit.json", "utf8"));

describe("kit manifest and tree", () => {
  it("claims only journeys and capabilities that have code behind them", () => {
    expect(manifest.capabilities).toEqual(["accounts", "server_data", "roles", "email"]);
    const ids = manifest.journeys.map((j: Journey) => j.id);
    expect(ids).not.toContain("file-attachments");
    expect(ids).not.toContain("scheduled-notices");
    for (const j of manifest.journeys.filter((j: Journey) => j.status === "needs-capability"))
      expect(manifest.capabilities).toContain(j.capability);
  });
  it("lists the workspace manager, which any signed-up account can become", () => {
    expect(manifest.roles.manager?.source).toBe("public-sign-up");
  });
  it("ships no lane notes and no role guard that ignores the workspace", () => {
    for (const file of [
      "DONE.md",
      "GAPS.md",
      "lib/roles/guard.ts",
      "lib/roles/runtime.ts",
      "lib/roles/members.ts",
      "lib/roles/database.ts",
      "app/parts/no-access.tsx",
    ])
      expect(existsSync(file), file).toBe(false);
  });
  it("describes each entry point in a full sentence", () => {
    for (const entry of manifest.entryPoints)
      expect(entry.summary.split(" ").length, entry.route).toBeGreaterThanOrEqual(8);
  });
});
