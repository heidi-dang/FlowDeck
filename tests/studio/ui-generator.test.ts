import { describe, it, expect } from "bun:test";
import { NativeUiGenerator } from "../../src/studio/ui-generator";
import { DesignSystemIndexer } from "../../src/studio/design-system-index";

describe("NativeUiGenerator Subsystem", () => {
  it("generates clean React component reusing existing project components", () => {
    const indexer = new DesignSystemIndexer();
    const ds = indexer.indexProject();
    const generator = new NativeUiGenerator();

    const res = generator.generateComponent({
      componentName: "AnalyticsView",
      designSystem: ds,
      conceptDirection: "expressive",
      reusedComponents: [
        { name: "Button", filePath: "src/components/Button.tsx", category: "primitive", exportedSymbols: ["Button"] },
      ],
    });

    expect(res.componentName).toBe("AnalyticsView");
    expect(res.code).toContain("import React from 'react';");
    expect(res.code).toContain("import { Button } from '@/components/Button';");
    expect(res.code).toContain("<Button variant=\"primary\">Action</Button>");
    expect(res.reusedComponentImports).toContain("Button");
    expect(res.conceptDirection).toBe("expressive");
  });
});
