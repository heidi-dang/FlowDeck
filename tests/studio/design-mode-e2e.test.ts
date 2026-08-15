import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { HeidiDesignMode } from "../../src/studio/design-mode";
import { writeFileSync, unlinkSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

describe("Heidi Design Mode E2E", () => {
  const tempCompPath = join(process.cwd(), "src", "temp-design-mode-target.tsx");

  beforeEach(() => {
    const code = `
import React from 'react';

export function MCPSettingsButton() {
  return (
    <button className="p-2 space-y-2 shadow-sm button.settings-trigger">
      Settings
    </button>
  );
}
`;
    writeFileSync(tempCompPath, code, "utf-8");
  });

  afterEach(() => {
    try {
      if (existsSync(tempCompPath)) unlinkSync(tempCompPath);
    } catch {
      /* ignore */
    }
  });

  it("correlates DOM element selection to React component and source file", async () => {
    const designMode = new HeidiDesignMode();
    const correlation = await designMode.correlateElement("button.settings-trigger", {
      reactComponentName: "MCPSettingsButton",
      sourceFile: "src/temp-design-mode-target.tsx",
    });

    expect(correlation.domSelector).toBe("button.settings-trigger");
    expect(correlation.reactComponentName).toBe("MCPSettingsButton");
    expect(correlation.sourceFile).toBe("src/temp-design-mode-target.tsx");
    expect(correlation.modificationScope).toBeDefined();
  });

  it("applies natural language design edit persistently to source file and preserves changes on reload", async () => {
    const designMode = new HeidiDesignMode();
    const result = await designMode.applyDesignEdit({
      selector: "button.settings-trigger",
      reactComponentName: "MCPSettingsButton",
      sourceFile: "src/temp-design-mode-target.tsx",
      naturalLanguageInstruction: "Make this card less dense",
    });

    expect(result.success).toBe(true);
    expect(result.modifiedFiles).toContain("src/temp-design-mode-target.tsx");

    // Read file on disk to prove persistent code change!
    const updated = readFileSync(tempCompPath, "utf-8");
    expect(updated).toContain("space-y-6");
    expect(updated).toContain("p-6");
  });
});
