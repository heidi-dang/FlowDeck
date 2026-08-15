/**
 * Design-System Indexer for Heidi UI/App Studio
 *
 * Inspects CSS variables, Tailwind configs, theme files, shadcn/UI components,
 * and existing repository components to build a ProjectDesignSystem model and
 * enforce reuse-first component discovery.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import type { ProjectDesignSystem, ComponentIndexEntry, ComponentIndex } from "./types";

export class DesignSystemIndexer {
  private projectRoot: string;

  constructor(projectRoot?: string) {
    this.projectRoot = projectRoot ? resolve(projectRoot) : process.cwd();
  }

  /**
   * Build complete ProjectDesignSystem index for the project.
   */
  public indexProject(): ProjectDesignSystem {
    const pkg = this.loadPackageJson();
    const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };

    const hasTailwind = Boolean(deps["tailwindcss"] || existsSync(join(this.projectRoot, "tailwind.config.js")) || existsSync(join(this.projectRoot, "tailwind.config.ts")));
    const hasShadcn = Boolean(deps["@radix-ui/react-dialog"] || existsSync(join(this.projectRoot, "components/ui")) || existsSync(join(this.projectRoot, "src/components/ui")));

    const framework = deps["next"] ? "next" : deps["vite"] ? "vite" : deps["react"] ? "react" : "unknown";

    const components = this.indexComponents();
    const tokens = this.extractDesignTokens();

    return {
      tokens,
      components,
      typography: tokens.typography,
      patterns: ["flex-layout", "card-grid", "modal-dialog"],
      constraints: ["use-theme-tokens", "prefer-semantic-html"],
      framework,
      hasTailwind,
      hasShadcn,
    };
  }

  /**
   * Reuse-First Discovery: Search for matching existing component before generating new code.
   */
  public searchExistingComponent(requestedName: string): ComponentIndexEntry | null {
    const ds = this.indexProject();
    const normalizedReq = requestedName.toLowerCase().replace(/[^a-z0-9]/g, "");

    for (const comp of ds.components) {
      const normalizedComp = comp.name.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (normalizedComp === normalizedReq || normalizedComp.includes(normalizedReq) || normalizedReq.includes(normalizedComp)) {
        return comp;
      }
    }

    return null;
  }

  private indexComponents(): ComponentIndex {
    const index: ComponentIndex = [];
    const searchDirs = ["src/components", "components", "src/ui", "ui", "src/app"];

    for (const subDir of searchDirs) {
      const fullDir = join(this.projectRoot, subDir);
      if (existsSync(fullDir)) {
        this.scanDirectoryForComponents(fullDir, index);
      }
    }

    return index;
  }

  private scanDirectoryForComponents(dir: string, index: ComponentIndex): void {
    try {
      const entries = readdirSync(dir);
      for (const entry of entries) {
        if (entry === "node_modules" || entry === ".git" || entry === "dist") continue;
        const full = join(dir, entry);
        const stat = statSync(full);

        if (stat.isDirectory()) {
          this.scanDirectoryForComponents(full, index);
        } else if (stat.isFile() && /\.(tsx|jsx|js|ts)$/.test(entry)) {
          const content = readFileSync(full, "utf-8");
          const exportedSymbols = this.extractExportedSymbols(content);

          if (exportedSymbols.length > 0) {
            const name = exportedSymbols[0] || entry.replace(/\.(tsx|jsx|js|ts)$/, "");
            const category = categorizeComponent(name, content);

            index.push({
              name,
              filePath: relative(this.projectRoot, full),
              category,
              exportedSymbols,
            });
          }
        }
      }
    } catch {
      /* ignore read error */
    }
  }

  private extractExportedSymbols(content: string): string[] {
    const symbols: string[] = [];
    const exportMatches = content.matchAll(/export\s+(?:default\s+)?(?:function|const|class|type|interface)\s+([A-Z][A-Za-z0-9_]+)/g);
    for (const match of exportMatches) {
      if (match[1] && !symbols.includes(match[1])) {
        symbols.push(match[1]);
      }
    }
    return symbols;
  }

  private extractDesignTokens() {
    const colors: Record<string, string> = {
      primary: "var(--primary, #3b82f6)",
      secondary: "var(--secondary, #64748b)",
      background: "var(--background, #ffffff)",
      text: "var(--text, #0f172a)",
    };

    const spacing: Record<string, string> = {
      sm: "0.5rem",
      md: "1rem",
      lg: "1.5rem",
      xl: "2rem",
    };

    const typography: Record<string, string> = {
      fontFamily: "var(--font-sans, system-ui, sans-serif)",
      heading1: "2rem",
      body: "1rem",
    };

    // Scan CSS files for --color-* or --spacing-* variables
    const cssCandidates = ["src/globals.css", "src/index.css", "styles/globals.css", "app/globals.css"];
    for (const cand of cssCandidates) {
      const full = join(this.projectRoot, cand);
      if (existsSync(full)) {
        try {
          const raw = readFileSync(full, "utf-8");
          const vars = raw.matchAll(/--([a-zA-Z0-9_-]+):\s*([^;]+);/g);
          for (const v of vars) {
            const varName = v[1];
            const varValue = v[2].trim();
            if (varName.startsWith("color") || varName.includes("primary") || varName.includes("bg")) {
              colors[varName] = varValue;
            } else if (varName.includes("space") || varName.includes("gap")) {
              spacing[varName] = varValue;
            }
          }
        } catch {
          /* ignore read error */
        }
      }
    }

    return {
      colors,
      spacing,
      typography,
      radii: { sm: "0.25rem", md: "0.375rem", lg: "0.5rem" },
      shadows: { sm: "0 1px 2px rgba(0,0,0,0.05)", md: "0 4px 6px rgba(0,0,0,0.1)" },
    };
  }

  private loadPackageJson(): { dependencies?: Record<string, string>; devDependencies?: Record<string, string> } | null {
    try {
      const full = join(this.projectRoot, "package.json");
      if (!existsSync(full)) return null;
      return JSON.parse(readFileSync(full, "utf-8"));
    } catch {
      return null;
    }
  }
}

function categorizeComponent(name: string, content: string): "primitive" | "composite" | "layout" | "form" {
  const lowerName = name.toLowerCase();
  if (lowerName.includes("button") || lowerName.includes("badge") || lowerName.includes("avatar") || lowerName.includes("icon")) {
    return "primitive";
  }
  if (lowerName.includes("input") || lowerName.includes("form") || lowerName.includes("select") || lowerName.includes("checkbox")) {
    return "form";
  }
  if (lowerName.includes("layout") || lowerName.includes("sidebar") || lowerName.includes("header") || lowerName.includes("container")) {
    return "layout";
  }
  return "composite";
}
