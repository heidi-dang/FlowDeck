import { z } from "zod/v4";
import { getProjectIdentity } from "../workspace/project-identity";
import { captureWorkspaceSnapshot } from "../workspace/workspace-snapshot";
import { runAllCollectors } from "../collectors/collector-runner";
import { readSessionRecords } from "../opencode/session-reader";
import { analyzeSessions } from "../opencode/session-analyzer";
import { createRepairSession } from "../opencode/repair-session";
import { executeValidation } from "../opencode/validation-executor";
import { loadRun, listRuns } from "../persistence/run-store";
import { loadReport, listReports } from "../persistence/report-store";
import { loadFindingIndex } from "../persistence/finding-store";
import { loadIgnoredFindings, saveIgnoredFinding } from "../persistence/ignored-finding-store";
import { listRepairSessions } from "../persistence/repair-session-store";
import { HarnessFindingSchema } from "../contracts/report";

const ProjectKeySchema = z.string().min(1).max(256).regex(/^[a-zA-Z0-9_\-.@/]+$/);
const _PathSchema = z.string().min(1).max(1024).refine((p) => !p.includes(".."), "Path traversal rejected");

export interface RouteHandler {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  handler: (params: Record<string, string>, body?: unknown) => RouteResponse;
}

export interface RouteResponse {
  status: number;
  body: unknown;
}

// Unused
function _projectKeyToId(key: string): string {
  return key;
}

function handleError(err: unknown): RouteResponse {
  const msg = err instanceof Error ? err.message : String(err);
  return { status: 500, body: { error: msg } };
}

function ok(body: unknown): RouteResponse {
  return { status: 200, body };
}

const _PATH_TRAVERSAL_RE = /\.\./;

export async function routeRequest(
  method: string,
  urlPath: string,
  body?: unknown,
): Promise<RouteResponse> {
  try {
    // Parse path and extract params
    const parts = urlPath.split("/").filter(Boolean);

    // Health
    if (method === "GET" && urlPath === "/health") {
      return ok({ status: "ok", timestamp: new Date().toISOString() });
    }

    // Project identity
    if (method === "GET" && parts[0] === "projects" && parts[2] === "identity" && parts.length === 3) {
      const projectKey = parts[1];
      const validated = ProjectKeySchema.safeParse(projectKey);
      if (!validated.success) return { status: 400, body: { error: "Invalid project key" } };
      const identity = getProjectIdentity(projectKey);
      return ok(identity);
    }

    // Workspace snapshot
    if (method === "GET" && parts[0] === "projects" && parts[2] === "snapshot" && parts.length === 3) {
      const projectKey = parts[1];
      const validated = ProjectKeySchema.safeParse(projectKey);
      if (!validated.success) return { status: 400, body: { error: "Invalid project key" } };
      const snapshot = captureWorkspaceSnapshot(projectKey);
      return ok(snapshot);
    }

    // Run collectors
    if (method === "POST" && parts[0] === "projects" && parts[2] === "collect" && parts.length === 3) {
      const projectKey = parts[1];
      const validated = ProjectKeySchema.safeParse(projectKey);
      if (!validated.success) return { status: 400, body: { error: "Invalid project key" } };
      const result = await runAllCollectors(projectKey);
      return ok(result);
    }

    // Sessions
    if (method === "GET" && parts[0] === "projects" && parts[2] === "sessions" && parts.length === 3) {
      const projectKey = parts[1];
      const validated = ProjectKeySchema.safeParse(projectKey);
      if (!validated.success) return { status: 400, body: { error: "Invalid project key" } };
      const records = readSessionRecords(projectKey);
      const analysis = analyzeSessions(records);
      return ok({ records, analysis });
    }

    // Runs
    if (method === "GET" && urlPath === "/projects/{projectKey}/runs") {
      const projectKey = parts[1];
      const validated = ProjectKeySchema.safeParse(projectKey);
      if (!validated.success) return { status: 400, body: { error: "Invalid project key" } };
      return ok(listRuns(projectKey));
    }

    if (method === "GET" && parts[0] === "projects" && parts[2] === "runs" && parts.length === 4) {
      const projectKey = parts[1];
      const runId = parts[3];
      const validated = ProjectKeySchema.safeParse(projectKey);
      if (!validated.success) return { status: 400, body: { error: "Invalid project key" } };
      const run = loadRun(projectKey, runId);
      if (!run) return { status: 404, body: { error: "Run not found" } };
      return ok(run);
    }

    // Reports
    if (method === "GET" && urlPath === "/projects/{projectKey}/reports") {
      const projectKey = parts[1];
      const validated = ProjectKeySchema.safeParse(projectKey);
      if (!validated.success) return { status: 400, body: { error: "Invalid project key" } };
      return ok(listReports(projectKey));
    }

    if (method === "GET" && parts[0] === "projects" && parts[2] === "reports" && parts.length === 4) {
      const projectKey = parts[1];
      const reportId = parts[3];
      const validated = ProjectKeySchema.safeParse(projectKey);
      if (!validated.success) return { status: 400, body: { error: "Invalid project key" } };
      const report = loadReport(projectKey, reportId);
      if (!report) return { status: 404, body: { error: "Report not found" } };
      return ok(report);
    }

    // Findings
    if (method === "GET" && urlPath === "/projects/{projectKey}/findings") {
      const projectKey = parts[1];
      const validated = ProjectKeySchema.safeParse(projectKey);
      if (!validated.success) return { status: 400, body: { error: "Invalid project key" } };
      const index = loadFindingIndex(projectKey);
      return ok(index?.findings ?? []);
    }

    // Ignored findings
    if (method === "GET" && urlPath === "/projects/{projectKey}/findings/ignored") {
      const projectKey = parts[1];
      const validated = ProjectKeySchema.safeParse(projectKey);
      if (!validated.success) return { status: 400, body: { error: "Invalid project key" } };
      return ok(loadIgnoredFindings(projectKey));
    }

    if (method === "POST" && urlPath === "/projects/{projectKey}/findings/ignored") {
      const projectKey = parts[1];
      const validated = ProjectKeySchema.safeParse(projectKey);
      if (!validated.success) return { status: 400, body: { error: "Invalid project key" } };
      const entry = body as any;
      saveIgnoredFinding(projectKey, entry);
      return ok({ success: true });
    }

    // Repair session
    if (method === "POST" && parts[0] === "projects" && parts[2] === "repair" && parts.length === 3) {
      const projectKey = parts[1];
      const validated = ProjectKeySchema.safeParse(projectKey);
      if (!validated.success) return { status: 400, body: { error: "Invalid project key" } };
      const finding = HarnessFindingSchema.safeParse(body);
      if (!finding.success) return { status: 400, body: { error: "Invalid finding", details: finding.error } };
      const result = createRepairSession({ finding: finding.data, projectPath: projectKey });
      return ok(result);
    }

    // Repair sessions list
    if (method === "GET" && urlPath === "/projects/{projectKey}/repair-sessions") {
      const projectKey = parts[1];
      const validated = ProjectKeySchema.safeParse(projectKey);
      if (!validated.success) return { status: 400, body: { error: "Invalid project key" } };
      return ok(listRepairSessions(projectKey));
    }

    // Validation
    if (method === "POST" && parts[0] === "projects" && parts[2] === "validate" && parts.length === 3) {
      const projectKey = parts[1];
      const validated = ProjectKeySchema.safeParse(projectKey);
      if (!validated.success) return { status: 400, body: { error: "Invalid project key" } };
      const { command } = body as { command: string };
      if (!command) return { status: 400, body: { error: "Command is required" } };
      const result = executeValidation(command, projectKey);
      return ok(result);
    }

    return { status: 404, body: { error: `Route not found: ${method} ${urlPath}` } };
  } catch (err) {
    return handleError(err);
  }
}
