/**
 * Autonomous Browser Debugging Subsystem Types for Heidi / FlowDeck v2.0.0
 */

export type BrowserCapabilityStatus =
  | { available: true; version: string; binaryPath: string; provider: "agent-browser" | "playwright" | "cdp" }
  | {
      available: false;
      reason:
        | "agent-browser-missing"
        | "browser-missing"
        | "unsupported-platform"
        | "runtime-error";
      remediation?: string;
    };

export interface AccessibilityNode {
  role: string;
  name?: string;
  selector?: string;
  children?: AccessibilityNode[];
}

export interface InteractiveElement {
  id?: string;
  role: string;
  name: string;
  selector: string;
  isDestructive?: boolean;
}

export interface BrowserSnapshot {
  url: string;
  title: string;
  domSummary?: string;
  accessibilityTree?: AccessibilityNode[];
  interactiveElements?: InteractiveElement[];
}

export interface BrowserScreenshotOptions {
  path?: string;
  fullPage?: boolean;
}

export interface BrowserScreenshotResult {
  path: string;
  width?: number;
  height?: number;
  mimeType?: string;
}

export interface BrowserConsoleEntry {
  type: "log" | "info" | "warn" | "error" | "debug";
  text: string;
  timestamp: string;
  location?: {
    url: string;
    lineNumber?: number;
    columnNumber?: number;
  };
  stackTrace?: string;
}

export interface BrowserPageError {
  message: string;
  name?: string;
  stack?: string;
  timestamp: string;
  url?: string;
}

export interface BrowserNetworkEntry {
  url: string;
  method: string;
  status: number;
  statusText?: string;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  failed: boolean;
  failureReason?: string;
  timestamp: string;
  durationMs?: number;
}

export type BrowserTarget =
  | { selector: string }
  | { text: string }
  | { role: string; name?: string }
  | { semanticId: string };

export interface BrowserWaitOptions {
  timeoutMs?: number;
  waitUntil?: "load" | "domcontentloaded" | "networkidle";
  selector?: string;
}

export interface ReactTreeResult {
  rootComponent?: string;
  components: Array<{
    id: string;
    name: string;
    propsKeys?: string[];
    hooksCount?: number;
  }>;
}

export interface ReactComponentInspection {
  id: string;
  name: string;
  props: Record<string, unknown>;
  state?: Record<string, unknown>;
  hooks?: Array<{ name: string; value: unknown }>;
  sourceLocation?: {
    file: string;
    line?: number;
    column?: number;
  };
}

export interface BrowserTraceResult {
  path: string;
  durationMs?: number;
}

export interface HeidiBrowserSession {
  id: string;
  taskId?: string;
  projectId?: string;
  startedAt: string;
  currentUrl: string;
  navigationGeneration: number;

  open(url: string): Promise<void>;
  navigate(url: string): Promise<void>;
  reload(): Promise<void>;

  snapshot(options?: { interactiveOnly?: boolean }): Promise<BrowserSnapshot>;
  screenshot(options?: BrowserScreenshotOptions): Promise<BrowserScreenshotResult>;

  getConsole(): Promise<BrowserConsoleEntry[]>;
  getPageErrors(): Promise<BrowserPageError[]>;
  getNetworkActivity(): Promise<BrowserNetworkEntry[]>;

  click(target: BrowserTarget): Promise<void>;
  fill(target: BrowserTarget, value: string): Promise<void>;

  waitForReady(options?: BrowserWaitOptions): Promise<void>;

  getReactTree?(): Promise<ReactTreeResult>;
  inspectReactComponent?(id: string): Promise<ReactComponentInspection>;

  startTrace?(): Promise<void>;
  stopTrace?(): Promise<BrowserTraceResult>;

  close(): Promise<void>;
}

export type BrowserFailureCategory =
  | "uncaught-exception"
  | "console-error"
  | "network-failure"
  | "react-error";

export type BrowserFailureClassification =
  | "actionable"
  | "expected"
  | "third-party"
  | "development-noise"
  | "duplicate"
  | "unknown";

export interface BrowserFailureFingerprint {
  fingerprint: string;
  category: BrowserFailureCategory;
  message: string;
  sourceFile?: string;
  line?: number;
  column?: number;
  stackSignature?: string;
  requestUrl?: string;
  requestMethod?: string;
  status?: number;
  firstSeenAt: string;
  lastSeenAt: string;
  occurrences: number;
  navigationGeneration: number;
  classification: BrowserFailureClassification;
}

export interface CorrelatedSourceLocation {
  file: string;
  line?: number;
  column?: number;
  symbolName?: string;
  enclosingFunction?: string;
  sourceSnippet?: string;
  fdxCorrelated: boolean;
}

export interface DevServerOptions {
  cwd?: string;
  requestedPort?: number;
  preferredScript?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

export interface DevServerInfo {
  command: string;
  args: string[];
  cwd: string;
  url: string;
  port: number;
  pid?: number;
  isExternallyOwned: boolean;
  packageManager: "npm" | "bun" | "pnpm" | "yarn";
  framework?: string;
}

export interface BrowserRepairReport {
  sessionId: string;
  taskId: string;
  routesVisited: string[];
  actionableDefectsFound: number;
  defectsRepaired: number;
  uncaughtExceptions: number;
  actionableConsoleErrors: number;
  unexpectedNetworkFailures: number;
  regressionTests: "pass" | "fail" | "skipped";
  typecheck: "pass" | "fail" | "skipped";
  lint: "pass" | "fail" | "skipped";
  build: "pass" | "fail" | "skipped";
  nonActionableWarnings: string[];
  repairCycles: number;
  freshVerificationPassed: boolean;
  summary: string;
}
