import { existsSync, readFileSync } from "fs";
import { join } from "path";
import type { HarnessEvidence } from "../contracts/report";
import { normalizeEvidence, type RawCollectorEvidence } from "../evidence/evidence-normalizer";

export function collectFoundationEvidence(root: string): HarnessEvidence[] {
  const raw: RawCollectorEvidence[] = [];
  const pkgPath = join(root, "package.json");

  if (!existsSync(pkgPath)) {
    raw.push({
      category: "foundation",
      source: "package.json",
      summary: "No package.json found - cannot assess build foundation",
      path: root,
      confidence: 0.5,
    });
    return normalizeEvidence(raw);
  }

  let pkg: Record<string, any> = {};
  try {
    pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
  } catch {
    raw.push({
      category: "foundation",
      source: "package.json",
      summary: "Malformed package.json",
      path: pkgPath,
      confidence: 0.3,
    });
    return normalizeEvidence(raw);
  }

  const scripts = pkg.scripts ?? {};

  // Build
  if (scripts.build) {
    raw.push({
      category: "foundation",
      source: "package.json",
      summary: `Build script configured: ${scripts.build}`,
      path: pkgPath,
      confidence: 1.0,
    });
  } else {
    raw.push({
      category: "foundation",
      source: "package.json",
      summary: "No build script configured",
      path: pkgPath,
      confidence: 0.8,
    });
  }

  // Type checking
  if (scripts.typecheck || scripts["type-check"] || scripts["typecheck"]) {
    raw.push({
      category: "foundation",
      source: "package.json",
      summary: "Type checking script configured",
      path: pkgPath,
      confidence: 1.0,
    });
  } else {
    raw.push({
      category: "foundation",
      source: "package.json",
      summary: "No type checking script",
      path: pkgPath,
      confidence: 0.6,
    });
  }

  // Linting
  if (scripts.lint) {
    raw.push({
      category: "foundation",
      source: "package.json",
      summary: `Lint script configured: ${scripts.lint}`,
      path: pkgPath,
      confidence: 1.0,
    });
  }

  // Tests
  if (scripts.test) {
    raw.push({
      category: "foundation",
      source: "package.json",
      summary: `Test script configured: ${scripts.test}`,
      path: pkgPath,
      confidence: 1.0,
    });
  }

  // Pre-commit hooks
  if (existsSync(join(root, ".husky"))) {
    raw.push({
      category: "foundation",
      source: ".husky/",
      summary: "Pre-commit hooks via Husky",
      path: join(root, ".husky"),
      confidence: 1.0,
    });
  }

  // Deployment controls
  if (existsSync(join(root, "Dockerfile"))) {
    raw.push({
      category: "foundation",
      source: "Dockerfile",
      summary: "Docker deployment configured",
      path: join(root, "Dockerfile"),
      confidence: 1.0,
    });
  }

  // CI/CD
  if (existsSync(join(root, ".github", "workflows"))) {
    raw.push({
      category: "foundation",
      source: ".github/workflows/",
      summary: "GitHub Actions CI/CD configured",
      path: join(root, ".github", "workflows"),
      confidence: 1.0,
    });
  }

  // Coverage
  if (scripts["test:coverage"] || scripts.coverage) {
    raw.push({
      category: "foundation",
      source: "package.json",
      summary: "Test coverage configured",
      path: pkgPath,
      confidence: 1.0,
    });
  }

  return normalizeEvidence(raw);
}

export const foundationCollector = {
  name: "foundations" as const,
  collect: collectFoundationEvidence,
};
