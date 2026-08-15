/**
 * Browser Runtime Adapter for agent-browser / Chrome / CDP
 *
 * Implements HeidiBrowserSession with safe subprocess execution, argument arrays,
 * bounded output buffers, timeout/cancellation, JSON parsing, credential redaction,
 * and error handling.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import type {
  HeidiBrowserSession,
  BrowserSnapshot,
  BrowserScreenshotOptions,
  BrowserScreenshotResult,
  BrowserConsoleEntry,
  BrowserPageError,
  BrowserNetworkEntry,
  BrowserTarget,
  BrowserWaitOptions,
  ReactTreeResult,
  ReactComponentInspection,
  BrowserTraceResult,
  AccessibilityNode,
  InteractiveElement,
} from "./types";

export interface AgentBrowserSessionOptions {
  binaryPath?: string;
  sessionId?: string;
  taskId?: string;
  projectId?: string;
  headless?: boolean;
  timeoutMs?: number;
  artifactDir?: string;
  signal?: AbortSignal;
  mockMode?: boolean;
}

export class AgentBrowserSession implements HeidiBrowserSession {
  public readonly id: string;
  public readonly taskId?: string;
  public readonly projectId?: string;
  public readonly startedAt: string;
  public currentUrl: string = "about:blank";
  public navigationGeneration: number = 0;

  private binaryPath: string;
  private headless: boolean;
  private timeoutMs: number;
  private artifactDir: string;
  private signal?: AbortSignal;
  private mockMode: boolean;
  private isClosed: boolean = false;
  private isTracing: boolean = false;
  private traceStartTime?: number;

  private consoleEntries: BrowserConsoleEntry[] = [];
  private pageErrors: BrowserPageError[] = [];
  private networkEntries: BrowserNetworkEntry[] = [];

  constructor(options: AgentBrowserSessionOptions = {}) {
    this.id = options.sessionId || `session-${randomUUID().slice(0, 8)}`;
    this.taskId = options.taskId;
    this.projectId = options.projectId;
    this.startedAt = new Date().toISOString();

    this.binaryPath = options.binaryPath || "agent-browser";
    this.headless = options.headless ?? true;
    this.timeoutMs = options.timeoutMs ?? 30000;
    this.mockMode = options.mockMode ?? false;
    this.signal = options.signal;

    this.artifactDir =
      options.artifactDir || join(process.cwd(), ".fd-plan", "browser-artifacts", this.id);

    try {
      mkdirSync(this.artifactDir, { recursive: true });
    } catch {
      /* ignore */
    }

    if (this.signal) {
      this.signal.addEventListener("abort", () => {
        this.close().catch(() => {});
      });
    }
  }

  public async open(url: string): Promise<void> {
    return this.navigate(url);
  }

  public async navigate(url: string): Promise<void> {
    this.checkClosed();
    const sanitizedUrl = redactSensitiveUrl(url);
    this.navigationGeneration++;
    this.currentUrl = sanitizedUrl;

    if (this.mockMode) {
      return;
    }

    const args = ["open", sanitizedUrl, "--session", this.id, "--json"];
    if (this.headless) args.push("--headless");

    const res = await this.runSubprocess(args);
    this.parseSubprocessObservations(res);
  }

  public async reload(): Promise<void> {
    this.checkClosed();
    this.navigationGeneration++;

    if (this.mockMode) {
      return;
    }

    const args = ["reload", "--session", this.id, "--json"];
    const res = await this.runSubprocess(args);
    this.parseSubprocessObservations(res);
  }

  public async snapshot(options?: { interactiveOnly?: boolean }): Promise<BrowserSnapshot> {
    this.checkClosed();

    if (this.mockMode) {
      return {
        url: this.currentUrl,
        title: "Mock App Page",
        domSummary: "<main><h1>Mock App</h1></main>",
        accessibilityTree: [
          { role: "heading", name: "Mock App", selector: "h1" },
          { role: "button", name: "Submit", selector: "button.submit" },
        ],
        interactiveElements: [
          { role: "button", name: "Submit", selector: "button.submit" },
        ],
      };
    }

    const args = ["snapshot", "--session", this.id, "--json"];
    if (options?.interactiveOnly) args.push("--interactive-only");

    const raw = await this.runSubprocess(args);
    const parsed = safeJsonParse(raw.stdout);

    if (parsed && typeof parsed === "object") {
      return {
        url: typeof parsed.url === "string" ? parsed.url : this.currentUrl,
        title: typeof parsed.title === "string" ? parsed.title : "Application View",
        domSummary: typeof parsed.domSummary === "string" ? parsed.domSummary : raw.stdout.slice(0, 2000),
        accessibilityTree: Array.isArray(parsed.accessibilityTree) ? (parsed.accessibilityTree as AccessibilityNode[]) : [],
        interactiveElements: Array.isArray(parsed.interactiveElements)
          ? (parsed.interactiveElements as InteractiveElement[])
          : [],
      };
    }

    return {
      url: this.currentUrl,
      title: "Page View",
      domSummary: raw.stdout.slice(0, 2000),
      accessibilityTree: [],
      interactiveElements: [],
    };
  }

  public async screenshot(options?: BrowserScreenshotOptions): Promise<BrowserScreenshotResult> {
    this.checkClosed();
    const outputPath = options?.path || join(this.artifactDir, `screenshot-${Date.now()}.png`);

    if (this.mockMode) {
      return {
        path: outputPath,
        width: 1280,
        height: 720,
        mimeType: "image/png",
      };
    }

    const args = ["screenshot", "--session", this.id, "--path", outputPath, "--json"];
    if (options?.fullPage) args.push("--full-page");

    await this.runSubprocess(args);

    return {
      path: outputPath,
      width: 1280,
      height: 720,
      mimeType: "image/png",
    };
  }

  public async getConsole(): Promise<BrowserConsoleEntry[]> {
    this.checkClosed();
    return [...this.consoleEntries];
  }

  public async getPageErrors(): Promise<BrowserPageError[]> {
    this.checkClosed();
    return [...this.pageErrors];
  }

  public async getNetworkActivity(): Promise<BrowserNetworkEntry[]> {
    this.checkClosed();
    return [...this.networkEntries];
  }

  public async click(target: BrowserTarget): Promise<void> {
    this.checkClosed();
    const targetString = formatTarget(target);

    if (this.mockMode) {
      return;
    }

    const args = ["click", targetString, "--session", this.id, "--json"];
    const res = await this.runSubprocess(args);
    this.parseSubprocessObservations(res);
  }

  public async fill(target: BrowserTarget, value: string): Promise<void> {
    this.checkClosed();
    const targetString = formatTarget(target);
    const sanitizedValue = redactSensitiveValue(value);

    if (this.mockMode) {
      return;
    }

    const args = ["fill", targetString, sanitizedValue, "--session", this.id, "--json"];
    const res = await this.runSubprocess(args);
    this.parseSubprocessObservations(res);
  }

  public async waitForReady(options?: BrowserWaitOptions): Promise<void> {
    this.checkClosed();

    if (this.mockMode) {
      return;
    }

    const args = ["wait", "--session", this.id, "--json"];
    if (options?.waitUntil) args.push("--until", options.waitUntil);
    if (options?.selector) args.push("--selector", options.selector);
    if (options?.timeoutMs) args.push("--timeout", String(options.timeoutMs));

    await this.runSubprocess(args);
  }

  public async getReactTree(): Promise<ReactTreeResult> {
    this.checkClosed();
    if (this.mockMode) {
      return {
        rootComponent: "App",
        components: [
          { id: "comp-1", name: "App", propsKeys: ["title"] },
          { id: "comp-2", name: "Header", propsKeys: ["user"] },
        ],
      };
    }

    const args = ["react", "tree", "--session", this.id, "--json"];
    try {
      const res = await this.runSubprocess(args);
      const parsed = safeJsonParse(res.stdout);
      if (parsed && typeof parsed === "object") {
        return {
          rootComponent: typeof parsed.rootComponent === "string" ? parsed.rootComponent : "App",
          components: Array.isArray(parsed.components) ? parsed.components : [],
        };
      }
    } catch {
      /* capability-gated fallback */
    }

    return { components: [] };
  }

  public async inspectReactComponent(id: string): Promise<ReactComponentInspection> {
    this.checkClosed();
    if (this.mockMode) {
      return {
        id,
        name: "MockComponent",
        props: { title: "Mock" },
      };
    }

    const args = ["react", "inspect", id, "--session", this.id, "--json"];
    try {
      const res = await this.runSubprocess(args);
      const parsed = safeJsonParse(res.stdout);
      if (parsed && typeof parsed === "object") {
        return {
          id: typeof parsed.id === "string" ? parsed.id : id,
          name: typeof parsed.name === "string" ? parsed.name : "Component",
          props: typeof parsed.props === "object" && parsed.props ? (parsed.props as Record<string, unknown>) : {},
          state: typeof parsed.state === "object" && parsed.state ? (parsed.state as Record<string, unknown>) : undefined,
          sourceLocation: parsed.sourceLocation as any,
        };
      }
    } catch {
      /* ignore */
    }

    return { id, name: "Component", props: {} };
  }

  public async startTrace(): Promise<void> {
    this.checkClosed();
    this.isTracing = true;
    this.traceStartTime = Date.now();

    if (this.mockMode) return;

    const args = ["trace", "start", "--session", this.id, "--json"];
    await this.runSubprocess(args);
  }

  public async stopTrace(): Promise<BrowserTraceResult> {
    this.checkClosed();
    const outputPath = join(this.artifactDir, `trace-${Date.now()}.json`);
    const durationMs = this.traceStartTime ? Date.now() - this.traceStartTime : 0;
    this.isTracing = false;

    if (this.mockMode) {
      return { path: outputPath, durationMs };
    }

    const args = ["trace", "stop", "--session", this.id, "--path", outputPath, "--json"];
    try {
      await this.runSubprocess(args);
    } catch {
      /* ignore trace stop errors */
    }

    return { path: outputPath, durationMs };
  }

  public addConsoleEntry(entry: BrowserConsoleEntry): void {
    this.consoleEntries.push({
      ...entry,
      text: redactCredentials(entry.text),
    });
  }

  public addPageError(error: BrowserPageError): void {
    this.pageErrors.push({
      ...error,
      message: redactCredentials(error.message),
    });
  }

  public addNetworkEntry(entry: BrowserNetworkEntry): void {
    this.networkEntries.push({
      ...entry,
      url: redactSensitiveUrl(entry.url),
      requestHeaders: entry.requestHeaders ? redactHeaders(entry.requestHeaders) : undefined,
      responseHeaders: entry.responseHeaders ? redactHeaders(entry.responseHeaders) : undefined,
    });
  }

  public async close(): Promise<void> {
    if (this.isClosed) return;
    this.isClosed = true;

    if (!this.mockMode) {
      try {
        await this.runSubprocess(["close", "--session", this.id, "--json"], 5000);
      } catch {
        /* best effort process termination */
      }
    }
  }

  private checkClosed(): void {
    if (this.isClosed) {
      throw new Error(`Browser session "${this.id}" has been closed.`);
    }
  }

  private async runSubprocess(
    args: string[],
    overrideTimeoutMs?: number
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    if (this.signal?.aborted) {
      throw new Error(`Subprocess aborted: Task cancellation requested.`);
    }

    const timeout = overrideTimeoutMs ?? this.timeoutMs;

    return new Promise((resolve, reject) => {
      let child: ReturnType<typeof spawn>;
      try {
        const chromePath = process.env.CHROME_PATH || "/home/heidi/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome";
        const env = {
          ...process.env,
          TMPDIR: process.env.TMPDIR || "/tmp",
          XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || "/tmp",
          ...(existsSync(chromePath) ? { CHROME_PATH: chromePath } : {}),
        };
        child = spawn(this.binaryPath, args, {
          env,
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (err) {
        return reject(
          new Error(`Failed to spawn browser process "${this.binaryPath}": ${err instanceof Error ? err.message : String(err)}`)
        );
      }

      let stdout = "";
      let stderr = "";
      let killedDueToTimeout = false;

      const maxBufferLen = 1_048_576; // 1 MB bounded capture

      const timer = setTimeout(() => {
        killedDueToTimeout = true;
        try {
          child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      }, timeout);

      child.stdout?.on("data", (chunk: Buffer) => {
        if (stdout.length < maxBufferLen) {
          stdout += chunk.toString("utf-8");
        }
      });

      child.stderr?.on("data", (chunk: Buffer) => {
        if (stderr.length < maxBufferLen) {
          stderr += chunk.toString("utf-8");
        }
      });

      const onAbort = () => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      };

      if (this.signal) {
        this.signal.addEventListener("abort", onAbort, { once: true });
      }

      child.on("error", (err) => {
        clearTimeout(timer);
        if (this.signal) this.signal.removeEventListener("abort", onAbort);
        reject(new Error(`Browser process error: ${err.message}`));
      });

      child.on("close", (code) => {
        clearTimeout(timer);
        if (this.signal) this.signal.removeEventListener("abort", onAbort);

        if (killedDueToTimeout) {
          return reject(new Error(`Browser command "${args[0]}" timed out after ${timeout}ms.`));
        }

        resolve({
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          exitCode: code ?? 0,
        });
      });
    });
  }

  private parseSubprocessObservations(res: { stdout: string; stderr: string }): void {
    if (!res.stdout) return;
    const parsed = safeJsonParse(res.stdout);
    if (!parsed || typeof parsed !== "object") return;

    if (Array.isArray(parsed.console)) {
      for (const item of parsed.console) {
        if (item && typeof item === "object") {
          this.addConsoleEntry({
            type: item.type || "error",
            text: String(item.text || item.message || ""),
            timestamp: item.timestamp || new Date().toISOString(),
            location: item.location,
            stackTrace: item.stackTrace,
          });
        }
      }
    }

    if (Array.isArray(parsed.errors)) {
      for (const err of parsed.errors) {
        if (err && typeof err === "object") {
          this.addPageError({
            message: String(err.message || ""),
            name: err.name,
            stack: err.stack,
            timestamp: err.timestamp || new Date().toISOString(),
            url: err.url || this.currentUrl,
          });
        }
      }
    }

    if (Array.isArray(parsed.network)) {
      for (const net of parsed.network) {
        if (net && typeof net === "object") {
          this.addNetworkEntry({
            url: String(net.url || ""),
            method: String(net.method || "GET"),
            status: Number(net.status || 0),
            statusText: net.statusText,
            failed: Boolean(net.failed || net.status >= 400),
            failureReason: net.failureReason,
            timestamp: net.timestamp || new Date().toISOString(),
          });
        }
      }
    }
  }
}

function formatTarget(target: BrowserTarget): string {
  if ("selector" in target) return target.selector;
  if ("text" in target) return `text="${target.text}"`;
  if ("role" in target) return target.name ? `role=${target.role}[name="${target.name}"]` : `role=${target.role}`;
  if ("semanticId" in target) return `#${target.semanticId}`;
  return "*";
}

function safeJsonParse(input: string): any {
  try {
    return JSON.parse(input);
  } catch {
    // Try to extract JSON blob if stdout contains logs before JSON
    const match = input.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch {
        return null;
      }
    }
    return null;
  }
}

function redactSensitiveUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.searchParams.has("token")) parsed.searchParams.set("token", "[REDACTED]");
    if (parsed.searchParams.has("apiKey")) parsed.searchParams.set("apiKey", "[REDACTED]");
    if (parsed.searchParams.has("key")) parsed.searchParams.set("key", "[REDACTED]");
    if (parsed.searchParams.has("password")) parsed.searchParams.set("password", "[REDACTED]");
    if (parsed.password) parsed.password = "[REDACTED]";
    return parsed.toString();
  } catch {
    return url;
  }
}

function redactSensitiveValue(val: string): string {
  if (val.length > 500) return `${val.slice(0, 500)}...[REDACTED_HUGE_INPUT]`;
  return val;
}

function redactCredentials(text: string): string {
  return text
    .replace(/(bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, "$1[REDACTED]")
    .replace(/(api[_-]?key\s*[:=]\s*)[A-Za-z0-9._-]+/gi, "$1[REDACTED]")
    .replace(/(password\s*[:=]\s*)[^\s&]+/gi, "$1[REDACTED]");
}

function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (lower === "authorization" || lower === "cookie" || lower === "set-cookie" || lower.includes("secret")) {
      result[key] = "[REDACTED]";
    } else {
      result[key] = value;
    }
  }
  return result;
}
