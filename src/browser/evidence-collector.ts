/**
 * Evidence Collector and Classifier for Autonomous Browser Subsystem
 *
 * Gathers browser observations (console logs, uncaught exceptions, failed requests,
 * DOM snapshots, React diagnostics, screenshots), filters non-actionable noise,
 * and assigns explicit classification models.
 */

import type {
  HeidiBrowserSession,
  BrowserConsoleEntry,
  BrowserPageError,
  BrowserNetworkEntry,
  BrowserSnapshot,
  BrowserFailureCategory,
  BrowserFailureClassification,
  BrowserFailureFingerprint,
  ReactTreeResult,
} from "./types";

export interface CollectedBrowserEvidence {
  sessionId: string;
  url: string;
  navigationGeneration: number;
  timestamp: string;
  failures: BrowserFailureFingerprint[];
  rawConsole: BrowserConsoleEntry[];
  rawErrors: BrowserPageError[];
  rawNetwork: BrowserNetworkEntry[];
  snapshot?: BrowserSnapshot;
  reactTree?: ReactTreeResult;
  screenshotPath?: string;
  hasActionableFailures: boolean;
}

export class EvidenceCollector {
  /**
   * Collect structured evidence from an active browser session.
   */
  public async collectEvidence(
    session: HeidiBrowserSession,
    options: { captureScreenshot?: boolean; captureReact?: boolean } = {}
  ): Promise<CollectedBrowserEvidence> {
    const rawConsole = await session.getConsole();
    const rawErrors = await session.getPageErrors();
    const rawNetwork = await session.getNetworkActivity();

    let snapshot: BrowserSnapshot | undefined;
    try {
      snapshot = await session.snapshot({ interactiveOnly: false });
    } catch {
      /* ignore */
    }

    let reactTree: ReactTreeResult | undefined;
    if (options.captureReact && session.getReactTree) {
      try {
        reactTree = await session.getReactTree();
      } catch {
        /* ignore */
      }
    }

    let screenshotPath: string | undefined;
    if (options.captureScreenshot) {
      try {
        const shot = await session.screenshot();
        screenshotPath = shot.path;
      } catch {
        /* ignore */
      }
    }

    const failures: BrowserFailureFingerprint[] = [];

    // 1. Process Page Errors (Uncaught Exceptions & Unhandled Rejections)
    for (const error of rawErrors) {
      const classification = classifyPageError(error);
      const fingerprint = generateErrorFingerprint("uncaught-exception", error.message, error.stack);

      failures.push({
        fingerprint,
        category: "uncaught-exception",
        message: error.message,
        sourceFile: extractSourceFileFromStack(error.stack),
        line: extractLineFromStack(error.stack),
        column: extractColumnFromStack(error.stack),
        stackSignature: summarizeStack(error.stack),
        firstSeenAt: error.timestamp,
        lastSeenAt: error.timestamp,
        occurrences: 1,
        navigationGeneration: session.navigationGeneration,
        classification,
      });
    }

    // 2. Process Console Errors
    for (const entry of rawConsole) {
      if (entry.type !== "error" && entry.type !== "warn") continue;

      const classification = classifyConsoleEntry(entry);
      if (classification === "development-noise" || classification === "expected") continue;

      const category: BrowserFailureCategory = entry.text.includes("React") ? "react-error" : "console-error";
      const fingerprint = generateErrorFingerprint(category, entry.text, entry.stackTrace, entry.location?.url);

      failures.push({
        fingerprint,
        category,
        message: entry.text,
        sourceFile: entry.location?.url || extractSourceFileFromStack(entry.stackTrace),
        line: entry.location?.lineNumber || extractLineFromStack(entry.stackTrace),
        column: entry.location?.columnNumber || extractColumnFromStack(entry.stackTrace),
        stackSignature: summarizeStack(entry.stackTrace),
        firstSeenAt: entry.timestamp,
        lastSeenAt: entry.timestamp,
        occurrences: 1,
        navigationGeneration: session.navigationGeneration,
        classification,
      });
    }

    // 3. Process Network Failures
    for (const net of rawNetwork) {
      if (!net.failed && net.status < 400) continue;

      const classification = classifyNetworkEntry(net);
      if (classification === "development-noise" || classification === "expected" || classification === "third-party") {
        continue;
      }

      const fingerprint = generateNetworkFingerprint(net.url, net.method, net.status);

      failures.push({
        fingerprint,
        category: "network-failure",
        message: `HTTP ${net.status} ${net.statusText || ""} on ${net.method} ${net.url}`,
        requestUrl: net.url,
        requestMethod: net.method,
        status: net.status,
        firstSeenAt: net.timestamp,
        lastSeenAt: net.timestamp,
        occurrences: 1,
        navigationGeneration: session.navigationGeneration,
        classification,
      });
    }

    const hasActionableFailures = failures.some(
      (f) => f.classification === "actionable" || f.classification === "unknown"
    );

    return {
      sessionId: session.id,
      url: session.currentUrl,
      navigationGeneration: session.navigationGeneration,
      timestamp: new Date().toISOString(),
      failures,
      rawConsole,
      rawErrors,
      rawNetwork,
      snapshot,
      reactTree,
      screenshotPath,
      hasActionableFailures,
    };
  }
}

export function classifyPageError(error: BrowserPageError): BrowserFailureClassification {
  const msg = error.message.toLowerCase();
  if (msg.includes("resizeobserver loop limit exceeded") || msg.includes("resizeobserver loop completed with undelivered notifications")) {
    return "development-noise";
  }
  if (msg.includes("chrome-extension://") || msg.includes("moz-extension://")) {
    return "third-party";
  }
  return "actionable";
}

export function classifyConsoleEntry(entry: BrowserConsoleEntry): BrowserFailureClassification {
  const text = entry.text.toLowerCase();
  if (entry.type === "warn" && !text.includes("warning: react") && !text.includes("deprecated")) {
    return "development-noise";
  }
  if (text.includes("[fast refresh]") || text.includes("[hmr]") || text.includes("hot module replacement") || text.includes("webpack")) {
    return "development-noise";
  }
  if (text.includes("download the react devtools") || text.includes("react-devtools")) {
    return "development-noise";
  }
  if (text.includes("favicon.ico") && entry.text.includes("404")) {
    return "development-noise";
  }
  if (entry.location?.url?.includes("google-analytics.com") || entry.location?.url?.includes("segment.io")) {
    return "third-party";
  }
  return "actionable";
}

export function classifyNetworkEntry(net: BrowserNetworkEntry): BrowserFailureClassification {
  const url = net.url.toLowerCase();
  if (url.includes("favicon.ico")) {
    return "development-noise";
  }
  if (url.includes("google-analytics.com") || url.includes("analytics") || url.includes("sentry.io") || url.includes("hotjar.com")) {
    return "third-party";
  }
  if (url.includes("/_next/webpack-hmr") || url.includes("/__vite_ping")) {
    return "development-noise";
  }
  if (net.status === 404 && (url.endsWith(".map") || url.endsWith(".png") || url.endsWith(".jpg"))) {
    return "expected";
  }
  return "actionable";
}

export function generateErrorFingerprint(
  category: string,
  message: string,
  stack?: string,
  url?: string
): string {
  const normalizedMsg = message.replace(/0x[0-9a-fA-F]+/g, "0xHASH").replace(/\d+/g, "#");
  const topStackLine = extractTopStackLine(stack) || url || "";
  const key = `${category}:${normalizedMsg}:${topStackLine}`;
  return simpleHash(key);
}

export function generateNetworkFingerprint(url: string, method: string, status: number): string {
  const cleanUrl = url.split("?")[0].replace(/\d+/g, ":id");
  const key = `network:${method}:${cleanUrl}:${status}`;
  return simpleHash(key);
}

function extractTopStackLine(stack?: string): string {
  if (!stack) return "";
  const lines = stack.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("at "));
  return lines[0] || "";
}

function extractSourceFileFromStack(stack?: string): string | undefined {
  if (!stack) return undefined;
  const match = stack.match(/(?:at\s+.*\(|at\s+)?(https?:\/\/[^\s:]+|file:\/\/[^\s:]+|\/[^\s:]+):(\d+):(\d+)/);
  return match ? match[1] : undefined;
}

function extractLineFromStack(stack?: string): number | undefined {
  if (!stack) return undefined;
  const match = stack.match(/(?:at\s+.*\(|at\s+)?(https?:\/\/[^\s:]+|file:\/\/[^\s:]+|\/[^\s:]+):(\d+):(\d+)/);
  return match ? parseInt(match[2], 10) : undefined;
}

function extractColumnFromStack(stack?: string): number | undefined {
  if (!stack) return undefined;
  const match = stack.match(/(?:at\s+.*\(|at\s+)?(https?:\/\/[^\s:]+|file:\/\/[^\s:]+|\/[^\s:]+):(\d+):(\d+)/);
  return match ? parseInt(match[3], 10) : undefined;
}

function summarizeStack(stack?: string): string | undefined {
  if (!stack) return undefined;
  const lines = stack
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("at "))
    .slice(0, 3);
  return lines.join(" > ");
}

function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0;
  }
  return `fp-${Math.abs(hash).toString(36)}`;
}
