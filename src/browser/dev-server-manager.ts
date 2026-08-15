export function getEnhancedPath(): string {
  const current = process.env.PATH || "";
  const nvmBin = "/home/heidi/.nvm/versions/node/v24.19.0/bin";
  const localBin = join(process.cwd(), "node_modules", ".bin");
  const dirs = [nvmBin, localBin].filter((d) => existsSync(d) && !current.includes(d));
  return dirs.length > 0 ? `${dirs.join(":")}:${current}` : current;
}

/**
 * Dev Server Manager for Autonomous Browser Subsystem
 *
 * Detects frontend packages, package managers, frameworks, script candidates,
 * starts managed dev servers, waits for port readiness, attaches to existing servers,
 * tracks process ownership, and cleans up child processes cleanly.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { createConnection, Socket } from "node:net";
import type { DevServerInfo, DevServerOptions } from "./types";

export interface ManagedDevServer {
  info: DevServerInfo;
  logs: string[];
  stop(): Promise<void>;
}

const ownedProcesses = new Map<string, { process: ChildProcess; info: DevServerInfo }>();

// Register process shutdown hooks once
let processHooksRegistered = false;
function registerShutdownHooks() {
  if (processHooksRegistered) return;
  processHooksRegistered = true;

  const cleanup = () => {
    for (const [id, entry] of ownedProcesses.entries()) {
      try {
        if (entry.process && !entry.process.killed) {
          entry.process.kill("SIGKILL");
        }
      } catch {
        /* ignore */
      }
      ownedProcesses.delete(id);
    }
  };

  process.on("exit", cleanup);
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}

export class DevServerManager {
  private projectRoot: string;

  constructor(projectRoot?: string) {
    this.projectRoot = projectRoot ? resolve(projectRoot) : process.cwd();
    registerShutdownHooks();
  }

  /**
   * Determine project configuration and return launch info without starting server.
   */
  public async discoverDevServer(options: DevServerOptions = {}): Promise<DevServerInfo> {
    const cwd = options.cwd ? resolve(options.cwd) : await this.findFrontendPackageDir();
    const pkgManager = detectPackageManager(cwd);
    const pkgJson = loadPackageJson(cwd);

    if (!pkgJson || !pkgJson.scripts) {
      throw new Error(`No package.json with scripts found in directory: ${cwd}`);
    }

    const scriptName = options.preferredScript || selectDevScript(pkgJson.scripts);
    if (!scriptName) {
      throw new Error(
        `No dev script found in ${cwd}/package.json. Available scripts: ${Object.keys(pkgJson.scripts).join(", ")}`
      );
    }

    const framework = detectFramework(pkgJson);
    const requestedPort = options.requestedPort || 3000;

    const command = pkgManager;
    const args = pkgManager === "npm" ? ["run", scriptName] : [scriptName];

    return {
      command,
      args,
      cwd,
      url: `http://localhost:${requestedPort}`,
      port: requestedPort,
      isExternallyOwned: false,
      packageManager: pkgManager,
      framework,
    };
  }

  /**
   * Ensure a dev server is running — either by attaching to an existing listening port
   * or spawning a new managed dev server.
   */
  public async ensureDevServer(
    options: DevServerOptions & { mockMode?: boolean } = {},
    signal?: AbortSignal
  ): Promise<ManagedDevServer> {
    if (options.mockMode) {
      const port = options.requestedPort || 3000;
      return {
        info: {
          command: "mock",
          args: [],
          cwd: this.projectRoot,
          url: `http://localhost:${port}`,
          port,
          isExternallyOwned: true,
          packageManager: "bun",
        },
        logs: ["Mock dev server active"],
        stop: async () => {},
      };
    }
    const discovered = await this.discoverDevServer(options);

    // 1. Check if an external server is ALREADY listening on the requested or candidate ports
    const portsToCheck = [discovered.port, 3000, 5173, 8080, 4200, 3001];
    for (const port of portsToCheck) {
      const isListening = await checkPortListening(port);
      if (isListening) {
        const url = `http://localhost:${port}`;
        return {
          info: {
            ...discovered,
            port,
            url,
            isExternallyOwned: true,
          },
          logs: ["Attached to existing external server"],
          stop: async () => {
            // Do NOT kill external servers!
          },
        };
      }
    }

    // 2. Spawn a new managed dev server process
    const logs: string[] = [];
    const serverId = `server-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

    return new Promise((resolveServer, rejectServer) => {
      let child: ChildProcess;
      try {
        child = spawn(discovered.command, discovered.args, {
          cwd: discovered.cwd,
          env: {
            ...process.env,
            PATH: getEnhancedPath(),
            ...options.env,
            PORT: String(discovered.port),
            BROWSER: "none",
          },
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (err) {
        return rejectServer(
          new Error(`Failed to start dev server command "${discovered.command}": ${err instanceof Error ? err.message : String(err)}`)
        );
      }

      discovered.pid = child.pid;
      ownedProcesses.set(serverId, { process: child, info: discovered });

      let detectedUrl = discovered.url;
      let detectedPort = discovered.port;
      let isReady = false;
      let exitedPrematurely = false;

      const timeoutMs = options.timeoutMs || 45000;
      const readyTimer = setTimeout(() => {
        if (!isReady && !exitedPrematurely) {
          stopChildProcess(child, serverId);
          rejectServer(new Error(`Dev server failed to reach readiness within ${timeoutMs}ms. Logs:\n${logs.join("\n").slice(-1000)}`));
        }
      }, timeoutMs);

      const appendLog = (data: Buffer) => {
        const str = data.toString("utf-8");
        if (logs.length < 500) logs.push(str);

        // Detect actual URL/port printed by Next.js, Vite, Remix, etc.
        const urlMatch = str.match(/http:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d+)/i);
        if (urlMatch) {
          detectedPort = parseInt(urlMatch[1], 10);
          detectedUrl = `http://localhost:${detectedPort}`;
        }
      };

      child.stdout?.on("data", appendLog);
      child.stderr?.on("data", appendLog);

      const onAbort = () => {
        clearTimeout(readyTimer);
        stopChildProcess(child, serverId);
        rejectServer(new Error("Dev server startup aborted."));
      };

      if (signal) {
        signal.addEventListener("abort", onAbort, { once: true });
      }

      child.on("exit", (code) => {
        exitedPrematurely = true;
        ownedProcesses.delete(serverId);
        clearTimeout(readyTimer);
        if (!isReady) {
          rejectServer(
            new Error(
              `Dev server exited prematurely with code ${code}. Logs:\n${logs.slice(-20).join("")}`
            )
          );
        }
      });

      // Poll port readiness
      const pollInterval = setInterval(async () => {
        if (exitedPrematurely) {
          clearInterval(pollInterval);
          return;
        }

        const listening = await checkPortListening(detectedPort);
        if (listening) {
          isReady = true;
          clearInterval(pollInterval);
          clearTimeout(readyTimer);

          const finalInfo: DevServerInfo = {
            ...discovered,
            port: detectedPort,
            url: detectedUrl,
            pid: child.pid,
            isExternallyOwned: false,
          };

          resolveServer({
            info: finalInfo,
            logs,
            stop: async () => {
              stopChildProcess(child, serverId);
            },
          });
        }
      }, 500);
    });
  }

  /**
   * Find target frontend package directory (handles root, monorepos, and subdirectories).
   */
  private async findFrontendPackageDir(): Promise<string> {
    const rootPkg = loadPackageJson(this.projectRoot);
    if (rootPkg && rootPkg.scripts && selectDevScript(rootPkg.scripts)) {
      return this.projectRoot;
    }

    // Check common monorepo frontend paths: web, app, frontend, packages/*, apps/*
    const candidates = ["web", "app", "frontend", "client", "ui", "packages/frontend", "apps/web", "apps/app"];
    for (const cand of candidates) {
      const full = join(this.projectRoot, cand);
      if (existsSync(full)) {
        const pkg = loadPackageJson(full);
        if (pkg && pkg.scripts && selectDevScript(pkg.scripts)) {
          return full;
        }
      }
    }

    // Scan apps/ or packages/ for first package with a dev script
    for (const parent of ["apps", "packages"]) {
      const parentDir = join(this.projectRoot, parent);
      if (existsSync(parentDir)) {
        try {
          const subdirs = readdirSync(parentDir);
          for (const sub of subdirs) {
            const full = join(parentDir, sub);
            const pkg = loadPackageJson(full);
            if (pkg && pkg.scripts && selectDevScript(pkg.scripts)) {
              return full;
            }
          }
        } catch {
          /* ignore read error */
        }
      }
    }

    return this.projectRoot;
  }
}

function detectPackageManager(dir: string): "bun" | "pnpm" | "yarn" | "npm" {
  if (existsSync(join(dir, "bun.lock")) || existsSync(join(dir, "bun.lockb"))) return "bun";
  if (existsSync(join(dir, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(dir, "yarn.lock"))) return "yarn";
  return "npm";
}

function loadPackageJson(dir: string): { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> } | null {
  try {
    const filePath = join(dir, "package.json");
    if (!existsSync(filePath)) return null;
    return JSON.parse(readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

function selectDevScript(scripts: Record<string, string>): string | null {
  const priorities = ["dev", "start", "serve", "preview", "app:dev", "web:dev"];
  for (const name of priorities) {
    if (scripts[name]) return name;
  }
  for (const name of Object.keys(scripts)) {
    if (name.includes("dev") || name.includes("start") || name.includes("serve")) {
      return name;
    }
  }
  return null;
}

function detectFramework(pkgJson: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }): string {
  const deps = { ...pkgJson.dependencies, ...pkgJson.devDependencies };
  if (deps["next"]) return "next";
  if (deps["vite"]) return "vite";
  if (deps["@remix-run/react"]) return "remix";
  if (deps["@nuxt/kit"] || deps["nuxt"]) return "nuxt";
  if (deps["@astrojs/telemetry"] || deps["astro"]) return "astro";
  if (deps["@sveltejs/kit"]) return "sveltekit";
  if (deps["react-scripts"]) return "cra";
  if (deps["react"]) return "react";
  if (deps["vue"]) return "vue";
  return "unknown";
}

async function checkPortListening(port: number): Promise<boolean> {
  return new Promise((resolvePort) => {
    const socket = new Socket();
    socket.setTimeout(300);

    socket.on("connect", () => {
      socket.destroy();
      resolvePort(true);
    });

    socket.on("timeout", () => {
      socket.destroy();
      resolvePort(false);
    });

    socket.on("error", () => {
      socket.destroy();
      resolvePort(false);
    });

    socket.connect(port, "127.0.0.1");
  });
}

function stopChildProcess(child: ChildProcess, serverId: string) {
  ownedProcesses.delete(serverId);
  try {
    if (child && !child.killed) {
      child.kill("SIGTERM");
      setTimeout(() => {
        try {
          if (!child.killed) child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      }, 2000);
    }
  } catch {
    /* ignore */
  }
}
