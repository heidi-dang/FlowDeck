import { z } from "zod/v4";
import { createRepairSession } from "../opencode/repair-session";
import { loadRun, listRuns } from "../persistence/run-store";
import { loadReport, listReports } from "../persistence/report-store";
import { loadFindingIndex } from "../persistence/finding-store";
import { saveIgnoredFinding } from "../persistence/ignored-finding-store";
import {
  StartRunRequestSchema,
  BatchPlanFixRequestSchema,
  BatchIgnoreRequestSchema,
  BatchVerifyRequestSchema,
  BatchVerifyResponseSchema,
  BatchPlanFixResponseSchema,
  BatchIgnoreResponseSchema,
  StartRunResponseSchema,
  CancelRunResponseSchema,
  AvailabilityResponseSchema,
} from "../contracts/requests";
import { HarnessReportSchema } from "../contracts/report";
import type { HarnessReport } from "../contracts/report";
import { verifyFinding } from "../verification/finding-verifier";
import { saveFindingIndex } from "../persistence/finding-store";
import { HarnessRunProgressSchema } from "../contracts/progress";
import type { RouterContext } from "../runtime/router-context";

const ProjectKeySchema = z.string().min(1).max(256).regex(/^[a-zA-Z0-9_\-.@/]+$/);
const PATH_TRAVERSAL_RE = /\.\.|\//;

export interface RouteHandler {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  handler: (params: Record<string, string>, body?: unknown) => RouteResponse;
}

interface RouteMatch {
  params: Record<string, string>;
}

function matchRoute(pattern: string, urlPath: string): RouteMatch | null {
  const patternParts = pattern.split("/").filter(Boolean);
  const urlParts = urlPath.split("/").filter(Boolean);
  if (patternParts.length !== urlParts.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i].startsWith(":")) {
      const paramName = patternParts[i].slice(1);
      params[paramName] = urlParts[i];
    } else if (patternParts[i] !== urlParts[i]) {
      return null;
    }
  }
  return { params };
}

function validateProjectKey(key: string, resolveProjectPath: ((serverKey: string, projectKey: string) => string | null) | undefined, serverKey: string): { valid: true; path: string } | { valid: false; status: number; body: unknown } {
  const parsed = ProjectKeySchema.safeParse(key);
  if (!parsed.success) {
    return { valid: false, status: 400, body: { error: "Invalid project key", details: parsed.error } };
  }
  if (PATH_TRAVERSAL_RE.test(key)) {
    return { valid: false, status: 400, body: { error: "Invalid project key: path traversal detected" } };
  }
  if (resolveProjectPath) {
    const resolved = resolveProjectPath(serverKey, key);
    if (resolved === null) {
      return { valid: false, status: 404, body: { error: "Project not found" } };
    }
    return { valid: true, path: resolved };
  }
  return { valid: true, path: key };
}

export interface RouteResponse {
  status: number;
  body: unknown;
}

function handleError(err: unknown): RouteResponse {
  const msg = err instanceof Error ? err.message : String(err);
  return { status: 500, body: { error: msg } };
}

function ok(body: unknown): RouteResponse {
  return { status: 200, body };
}

function created(body: unknown): RouteResponse {
  return { status: 201, body };
}

function badRequest(error: string): RouteResponse {
  return { status: 400, body: { error } };
}

export async function routeRequest(
  method: string,
  urlPath: string,
  body: unknown,
  _resolveProjectPath?: (serverKey: string, projectKey: string) => string | null,
  _sseManager?: unknown,
): Promise<RouteResponse> {
  return routeRequestContext({} as RouterContext, method, urlPath, body);
}

export async function routeRequestContext(
  ctx: RouterContext,
  method: string,
  urlPath: string,
  body: unknown,
): Promise<RouteResponse> {
  try {
    // Health
    if (method === "GET" && urlPath === "/health") {
      return ok({ status: "ok", timestamp: new Date().toISOString() });
    }

    // --- Availability ---
    {
      const m = matchRoute("/api/v1/servers/:serverKey/projects/:projectKey/better-harness/availability", urlPath);
      if (m && method === "GET") {
        const { serverKey, projectKey } = m.params;
        const check = validateProjectKey(projectKey, ctx.resolveProjectPath, serverKey);
        if (!check.valid) return { status: check.status, body: check.body };
        const result = AvailabilityResponseSchema.parse({ available: true });
        return ok(result);
      }
    }

    // --- Report ---
    {
      const m = matchRoute("/api/v1/servers/:serverKey/projects/:projectKey/better-harness/report", urlPath);
      if (m && method === "GET") {
        const { serverKey, projectKey } = m.params;
        const check = validateProjectKey(projectKey, ctx.resolveProjectPath, serverKey);
        if (!check.valid) return { status: check.status, body: check.body };
        const reports = listReports(check.path, ctx.stateDir);
        if (reports.length === 0) return { status: 404, body: { error: "No report found" } };
        // Load the latest report
        const latestReportId = reports[reports.length - 1];
        const report = loadReport(check.path, latestReportId, ctx.stateDir);
        if (!report) return { status: 404, body: { error: "Report not found" } };
        const validated = HarnessReportSchema.parse(report);
        return ok(validated);
      }
    }

    // --- History ---
    {
      const m = matchRoute("/api/v1/servers/:serverKey/projects/:projectKey/better-harness/history", urlPath);
      if (m && method === "GET") {
        const { serverKey, projectKey } = m.params;
        const check = validateProjectKey(projectKey, ctx.resolveProjectPath, serverKey);
        if (!check.valid) return { status: check.status, body: check.body };
        const reportIds = listReports(check.path, ctx.stateDir);
        const reports: HarnessReport[] = [];
        for (const id of reportIds) {
          const report = loadReport(check.path, id, ctx.stateDir);
          if (report) reports.push(report);
        }
        return ok(reports);
      }
    }

    // --- Current run ---
    {
      const m = matchRoute("/api/v1/servers/:serverKey/projects/:projectKey/better-harness/runs/current", urlPath);
      if (m && method === "GET") {
        const { serverKey, projectKey } = m.params;
        const check = validateProjectKey(projectKey, ctx.resolveProjectPath, serverKey);
        if (!check.valid) return { status: check.status, body: check.body };
        const activeRun = ctx.coordinator.getActiveRun();
        if (!activeRun) {
          // Fall back to persisted runs
          const runIds = listRuns(check.path, ctx.stateDir);
          if (runIds.length === 0) return ok(null);
          const lastRun = loadRun(check.path, runIds[runIds.length - 1], ctx.stateDir);
          if (!lastRun) return ok(null);
          const progress = HarnessRunProgressSchema.parse({
            runId: lastRun.runId,
            status: lastRun.status,
            stage: lastRun.stage ?? "unknown",
            progressPercent: lastRun.progressPercent ?? 0,
            startedAt: lastRun.startedAt,
          });
          return ok(progress);
        }
        const progress = HarnessRunProgressSchema.parse({
          runId: activeRun.runId,
          status: activeRun.status,
          stage: activeRun.stage,
          progressPercent: activeRun.progressPercent,
        });
        return ok(progress);
      }
    }

    // --- Start run (calls REAL runtime) ---
    {
      const m = matchRoute("/api/v1/servers/:serverKey/projects/:projectKey/better-harness/runs", urlPath);
      if (m && method === "POST") {
        const { serverKey, projectKey } = m.params;
        const check = validateProjectKey(projectKey, ctx.resolveProjectPath, serverKey);
        if (!check.valid) return { status: check.status, body: check.body };
        const parsed = StartRunRequestSchema.safeParse(body);
        if (!parsed.success) {
          return badRequest("Invalid request body");
        }
        try {
          const result = await ctx.runtime.enqueueRun({
            mode: parsed.data.mode,
            sourceRevision: parsed.data.sourceRevision,
            collectors: parsed.data.collectors,
          });
          const resp = StartRunResponseSchema.parse({ accepted: true, runId: result.runId });
          return created(resp);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const resp = StartRunResponseSchema.parse({ accepted: false, error: msg });
          return { status: 500, body: resp };
        }
      }
    }

    // --- Cancel run (calls REAL runtime) ---
    {
      const m = matchRoute("/api/v1/servers/:serverKey/projects/:projectKey/better-harness/runs/:runId/cancel", urlPath);
      if (m && method === "POST") {
        const { serverKey, projectKey, runId } = m.params;
        const check = validateProjectKey(projectKey, ctx.resolveProjectPath, serverKey);
        if (!check.valid) return { status: check.status, body: check.body };
        const accepted = ctx.runtime.cancelRun(runId);
        const resp = CancelRunResponseSchema.parse({ accepted });
        return ok(resp);
      }
    }

    // --- Get specific run ---
    {
      const m = matchRoute("/api/v1/servers/:serverKey/projects/:projectKey/better-harness/runs/:runId", urlPath);
      if (m && method === "GET") {
        const { serverKey, projectKey, runId } = m.params;
        const check = validateProjectKey(projectKey, ctx.resolveProjectPath, serverKey);
        if (!check.valid) return { status: check.status, body: check.body };
        const run = loadRun(check.path, runId, ctx.stateDir);
        if (!run) return { status: 404, body: { error: "Run not found" } };
        return ok(run);
      }
    }

    // --- Plan fix (batch) with REAL OpenCode sessions ---
    {
      const m = matchRoute("/api/v1/servers/:serverKey/projects/:projectKey/better-harness/findings/plan-fix", urlPath);
      if (m && method === "POST") {
        const { serverKey, projectKey } = m.params;
        const check = validateProjectKey(projectKey, ctx.resolveProjectPath, serverKey);
        if (!check.valid) return { status: check.status, body: check.body };
        const parsed = BatchPlanFixRequestSchema.safeParse(body);
        if (!parsed.success) {
          return badRequest("Invalid request body");
        }
        const findings = loadFindingIndex(check.path, ctx.stateDir);
        const results = [];
        for (const fid of parsed.data.findingIds) {
          const finding = findings?.findings.find((f) => f.id === fid);
          if (!finding) {
            results.push({ findingId: fid, accepted: false, error: "Finding not found" });
            continue;
          }
          try {
            const session = await createRepairSession(
              { finding, projectPath: check.path },
              ctx.opencodeClient,
            );
            if (session.opencodeSessionId) {
              results.push({
                findingId: fid,
                accepted: true,
                repairSessionId: session.opencodeSessionId,
                opencodeSessionId: session.opencodeSessionId,
                repairOperationId: session.repairOperationId || session.opencodeSessionId,
              });
            } else {
              results.push({ findingId: fid, accepted: false, error: session.error ?? "Failed to create session" });
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            results.push({ findingId: fid, accepted: false, error: msg });
          }
        }
        const resp = BatchPlanFixResponseSchema.parse({ accepted: results.some((r) => r.accepted), results });
        return ok(resp);
      }
    }

    // --- Ignore findings (batch) ---
    {
      const m = matchRoute("/api/v1/servers/:serverKey/projects/:projectKey/better-harness/findings/ignore", urlPath);
      if (m && method === "POST") {
        const { serverKey, projectKey } = m.params;
        const check = validateProjectKey(projectKey, ctx.resolveProjectPath, serverKey);
        if (!check.valid) return { status: check.status, body: check.body };
        const parsed = BatchIgnoreRequestSchema.safeParse(body);
        if (!parsed.success) {
          return badRequest("Invalid request body");
        }
        const results = parsed.data.findingIds.map((fid: string) => {
          try {
            saveIgnoredFinding(check.path, { findingId: fid, reason: parsed.data.reason, actor: "system", timestamp: new Date().toISOString() }, ctx.stateDir);
            return { findingId: fid, accepted: true };
          } catch {
            return { findingId: fid, accepted: false, error: "Failed to ignore finding" };
          }
        });
        const resp = BatchIgnoreResponseSchema.parse({ accepted: true, results });
        return ok(resp);
      }
    }

    // --- Verify findings (REAL verification) ---
    {
      const m = matchRoute("/api/v1/servers/:serverKey/projects/:projectKey/better-harness/findings/verify", urlPath);
      if (m && method === "POST") {
        const { serverKey, projectKey } = m.params;
        const check = validateProjectKey(projectKey, ctx.resolveProjectPath, serverKey);
        if (!check.valid) return { status: check.status, body: check.body };
        const parsed = BatchVerifyRequestSchema.safeParse(body);
        if (!parsed.success) {
          return badRequest("Invalid request body");
        }
        const findingIndex = loadFindingIndex(check.path, ctx.stateDir);
        const results = [];
        for (const fid of parsed.data.findingIds) {
          const finding = findingIndex?.findings.find((f) => f.id === fid);
          if (!finding) {
            results.push({ findingId: fid, accepted: false, error: "Finding not found" });
            continue;
          }
          try {
            // Run real verification checks
            const { execSync } = require("child_process");
            let changedFiles: Array<{ filePath: string; status: "added" | "modified" | "deleted" }> = [];
            try {
              const diffOutput = execSync("git diff --name-status", { cwd: check.path, encoding: "utf-8", timeout: 10_000 });
              changedFiles = diffOutput.split("\n").filter(Boolean).map((line: string) => {
                const parts = line.split("\t");
                const statusMap: Record<string, "added" | "modified" | "deleted"> = {
                  A: "added", M: "modified", D: "deleted",
                };
                return { filePath: parts[1] ?? parts[0], status: statusMap[parts[0]] ?? "modified" };
              });
            } catch { /* no git diff available */ }

            const verification = verifyFinding(finding, changedFiles, check.path);

            // Update finding status in index
            if (findingIndex) {
              const updatedFindings = findingIndex.findings.map((f) => {
                if (f.id === fid) {
                  return { ...f, status: verification.status === "fixed" ? ("fixed" as const) : ("pending" as const) };
                }
                return f;
              });
              saveFindingIndex(check.path, updatedFindings, ctx.stateDir);
            }

            results.push({
              findingId: fid,
              accepted: true,
              status: verification.status,
              diffAllowed: verification.diffResult.allowed,
              requirementsPassed: verification.requirementResults.every((r) => r.passed),
            });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            results.push({ findingId: fid, accepted: false, error: msg });
          }
        }
        const resp = BatchVerifyResponseSchema.parse({ accepted: results.some((r) => r.accepted), results });
        return ok(resp);
      }
    }

    // --- SSE events stream (handled by http-server directly) ---
    {
      const m = matchRoute("/api/v1/servers/:serverKey/projects/:projectKey/better-harness/runs/:runId/events", urlPath);
      if (m && method === "GET") {
        if (!ctx.sseManager) {
          return { status: 501, body: { error: "SSE not available" } };
        }
        return { status: 101, body: { sse: true } };
      }
    }

    // --- Get repair session ---
    {
      const m = matchRoute("/api/v1/servers/:serverKey/projects/:projectKey/better-harness/repair-sessions/:sessionId", urlPath);
      if (m && method === "GET") {
        const { serverKey, projectKey, sessionId } = m.params;
        const check = validateProjectKey(projectKey, ctx.resolveProjectPath, serverKey);
        if (!check.valid) return { status: check.status, body: check.body };
        const { loadRepairSession } = require("../persistence/repair-session-store");
        const session = loadRepairSession(check.path, sessionId, ctx.stateDir);
        if (!session) return { status: 404, body: { error: "Repair session not found" } };
        return ok(session);
      }
    }

    return { status: 404, body: { error: "Route not found: " + method + " " + urlPath } };
  } catch (err) {
    return handleError(err);
  }
}
