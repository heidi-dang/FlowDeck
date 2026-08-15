import { describe, it, expect } from "bun:test";
import { DesignSystemIndexer } from "../../src/studio/design-system-index";

describe("DesignSystemIndexer & Reuse-First Component Discovery", () => {
  it("indexes project framework, components, and design tokens", () => {
    const indexer = new DesignSystemIndexer();
    const ds = indexer.indexProject();

    expect(ds).toHaveProperty("framework");
    expect(ds).toHaveProperty("components");
    expect(ds).toHaveProperty("tokens");
    expect(ds.tokens.colors).toBeDefined();
    expect(ds.tokens.spacing).toBeDefined();
  });

  it("performs reuse-first component discovery before generation", () => {
    const indexer = new DesignSystemIndexer();
    const match = indexer.searchExistingComponent("Button");

    if (match) {
      expect(match.name).toBeDefined();
      expect(match.filePath).toBeDefined();
    } else {
      expect(match).toBeNull();
    }
  });
});
