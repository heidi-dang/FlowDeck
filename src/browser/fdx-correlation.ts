/**
 * FDX Source Correlation Engine for Autonomous Browser Subsystem
 *
 * Correlates browser runtime evidence (JS stack traces, React component names,
 * failed network endpoints) to local repository source files, line numbers,
 * enclosing symbols, and call sites using FDX or native TypeScript fallback.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve, isAbsolute, relative } from "node:path";
import type { BrowserFailureFingerprint, CorrelatedSourceLocation } from "./types";
import { checkFdxAvailability, runFdx } from "../tools/fdx-shared";

export class FdxSourceCorrelator {
  private projectRoot: string;

  constructor(projectRoot?: string) {
    this.projectRoot = projectRoot ? resolve(projectRoot) : process.cwd();
  }

  /**
   * Correlate a browser failure fingerprint to a concrete source location.
   */
  public async correlateFailure(
    failure: BrowserFailureFingerprint
  ): Promise<CorrelatedSourceLocation | null> {
    // 1. If stack contains explicit source file & line
    if (failure.sourceFile) {
      const localFile = this.resolveLocalFilePath(failure.sourceFile);
      if (localFile && existsSync(localFile)) {
        const snippet = this.extractSnippet(localFile, failure.line);
        const symbol = this.extractEnclosingSymbol(localFile, failure.line);

        return {
          file: relative(this.projectRoot, localFile),
          line: failure.line,
          column: failure.column,
          symbolName: symbol,
          sourceSnippet: snippet,
          fdxCorrelated: false,
        };
      }
    }

    // 2. FDX Search by React component or error message token
    const fdxActive = checkFdxAvailability();
    const token = extractSearchToken(failure.message);

    if (token) {
      if (fdxActive) {
        try {
          const searchRes = runFdx(["search", token, "--limit", "5"]);
          if (searchRes && typeof searchRes === "string" && searchRes.includes("File:")) {
            const parsed = parseFdxSearchResult(searchRes);
            if (parsed) {
              return {
                ...parsed,
                fdxCorrelated: true,
              };
            }
          }
        } catch {
          /* fallback to TS search below */
        }
      }

      // Native TypeScript search fallback
      const fallbackMatch = await this.fallbackSearchToken(token);
      if (fallbackMatch) {
        return fallbackMatch;
      }
    }

    // 3. Network API failure correlation (find fetch/axios/api call site)
    if (failure.category === "network-failure" && failure.requestUrl) {
      const endpointPath = extractEndpointPath(failure.requestUrl);
      if (endpointPath) {
        const match = await this.fallbackSearchToken(endpointPath);
        if (match) {
          return {
            ...match,
            symbolName: `API client site (${endpointPath})`,
          };
        }
      }
    }

    return null;
  }

  private resolveLocalFilePath(sourceUrl: string): string | null {
    if (isAbsolute(sourceUrl) && existsSync(sourceUrl)) {
      return sourceUrl;
    }

    // Extract path component from URL like http://localhost:3000/src/components/UserList.tsx?t=123
    let cleanPath = sourceUrl.replace(/^https?:\/\/[^/]+/, "").split("?")[0].split("#")[0];
    if (cleanPath.startsWith("/")) cleanPath = cleanPath.slice(1);

    const candidate1 = join(this.projectRoot, cleanPath);
    if (existsSync(candidate1)) return candidate1;

    // Check src/ prefix
    const candidate2 = join(this.projectRoot, "src", cleanPath);
    if (existsSync(candidate2)) return candidate2;

    return null;
  }

  private extractSnippet(filePath: string, line?: number): string | undefined {
    if (!line || line <= 0) return undefined;
    try {
      const content = readFileSync(filePath, "utf-8");
      const lines = content.split("\n");
      const start = Math.max(0, line - 3);
      const end = Math.min(lines.length, line + 2);
      return lines.slice(start, end).join("\n");
    } catch {
      return undefined;
    }
  }

  private extractEnclosingSymbol(filePath: string, line?: number): string | undefined {
    if (!line || line <= 0) return undefined;
    try {
      const content = readFileSync(filePath, "utf-8");
      const lines = content.split("\n");
      for (let i = line - 1; i >= 0; i--) {
        const match = lines[i].match(/(?:function|const|class|interface|type)\s+([A-Za-z0-9_$]+)/);
        if (match) return match[1];
      }
    } catch {
      /* ignore */
    }
    return undefined;
  }

  private async fallbackSearchToken(token: string): Promise<CorrelatedSourceLocation | null> {
    const candidates = ["src", "pages", "app", "components"];
    for (const dir of candidates) {
      const dirPath = join(this.projectRoot, dir);
      if (existsSync(dirPath)) {
        const found = searchDirectoryForToken(dirPath, token);
        if (found) {
          return {
            file: relative(this.projectRoot, found.filePath),
            line: found.line,
            sourceSnippet: found.snippet,
            fdxCorrelated: false,
          };
        }
      }
    }
    return null;
  }
}

function extractSearchToken(message: string): string | null {
  const compMatch = message.match(/(?:in|at)\s+<([A-Z][A-Za-z0-9_]+)/);
  if (compMatch) return compMatch[1];

  const errMatch = message.match(/(?:TypeError|ReferenceError|Uncaught Error):\s*([A-Za-z0-9_$]+)/);
  if (errMatch) return errMatch[1];

  return null;
}

function extractEndpointPath(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.pathname;
  } catch {
    const pathOnly = url.split("?")[0];
    if (pathOnly.startsWith("/")) return pathOnly;
    return null;
  }
}

function parseFdxSearchResult(result: string): CorrelatedSourceLocation | null {
  const fileMatch = result.match(/File:\s*([^\n]+)/);
  const lineMatch = result.match(/Line:\s*(\d+)/);

  if (fileMatch) {
    return {
      file: fileMatch[1].trim(),
      line: lineMatch ? parseInt(lineMatch[1], 10) : undefined,
      fdxCorrelated: true,
    };
  }
  return null;
}

function searchDirectoryForToken(dir: string, token: string): { filePath: string; line: number; snippet: string } | null {
  const { readdirSync, statSync, readFileSync } = require("node:fs");
  const { join } = require("node:path");

  try {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      if (entry === "node_modules" || entry === ".git" || entry === "dist") continue;
      const full = join(dir, entry);
      const stat = statSync(full);

      if (stat.isDirectory()) {
        const sub = searchDirectoryForToken(full, token);
        if (sub) return sub;
      } else if (stat.isFile() && /\.(ts|tsx|js|jsx)$/.test(entry)) {
        const text = readFileSync(full, "utf-8");
        if (text.includes(token)) {
          const lines = text.split("\n");
          for (let i = 0; i < lines.length; i++) {
            if (lines[i].includes(token)) {
              return {
                filePath: full,
                line: i + 1,
                snippet: lines.slice(Math.max(0, i - 2), Math.min(lines.length, i + 3)).join("\n"),
              };
            }
          }
        }
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}
