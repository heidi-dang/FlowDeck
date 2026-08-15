/**
 * Native UI Generator for Heidi UI/App Studio
 *
 * Generates stack-aware, clean React/TypeScript components respecting existing
 * design system tokens, project components, and concept directions.
 */

import type { UIArchitecture, ProjectDesignSystem, ComponentIndexEntry } from "./types";

export interface GenerateComponentOptions {
  componentName: string;
  architecture?: UIArchitecture;
  designSystem: ProjectDesignSystem;
  conceptDirection?: "minimal" | "professional" | "expressive" | "dense";
  reusedComponents?: ComponentIndexEntry[];
  customPrompt?: string;
}

export interface GeneratedComponentResult {
  componentName: string;
  code: string;
  reusedComponentImports: string[];
  conceptDirection: string;
}

export class NativeUiGenerator {
  /**
   * Generate clean TypeScript/React component code.
   */
  public generateComponent(options: GenerateComponentOptions): GeneratedComponentResult {
    const name = options.componentName;
    const direction = options.conceptDirection || options.architecture?.designDirection.theme || "professional";
    const ds = options.designSystem;
    const reused = options.reusedComponents || [];

    const reusedImports: string[] = [];
    const importStatements: string[] = ["import React from 'react';"];

    for (const comp of reused) {
      if (comp.filePath) {
        importStatements.push(`import { ${comp.name} } from '${this.formatImportPath(comp.filePath)}';`);
        reusedImports.push(comp.name);
      }
    }

    const paddingClass = direction === "dense" ? "p-2 space-y-2" : direction === "expressive" ? "p-6 space-y-6 shadow-lg" : "p-4 space-y-4 shadow-sm";
    const containerBg = ds.hasTailwind ? "bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl" : "border rounded-lg p-4";

    const buttonElement = reusedImports.includes("Button")
      ? `<Button variant="primary">Action</Button>`
      : `<button className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors">Action</button>`;

    const cardElement = reusedImports.includes("Card")
      ? `<Card className="${paddingClass}"><h3 className="font-semibold text-lg">${name} Content</h3>${buttonElement}</Card>`
      : `<div className="${containerBg} ${paddingClass}"><h3 className="font-semibold text-lg">${name} Content</h3><p className="text-sm text-gray-500">Generated component using ${direction} design tokens.</p>${buttonElement}</div>`;

    const code = `
${importStatements.join("\n")}

export interface ${name}Props {
  title?: string;
  className?: string;
  children?: React.ReactNode;
}

export function ${name}({ title = '${name}', className = '', children }: ${name}Props) {
  return (
    <div className={\`w-full \${className}\`}>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-bold tracking-tight text-gray-900 dark:text-gray-100">{title}</h2>
      </div>
      ${cardElement}
      {children}
    </div>
  );
}

export default ${name};
`.trim();

    return {
      componentName: name,
      code,
      reusedComponentImports: reusedImports,
      conceptDirection: direction,
    };
  }

  private formatImportPath(filePath: string): string {
    const clean = filePath.replace(/\.(tsx|jsx|js|ts)$/, "");
    if (clean.startsWith("src/")) return `@/${clean.slice(4)}`;
    return `./${clean}`;
  }
}
