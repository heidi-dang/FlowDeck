import { z } from "zod/v4";
import { createRepairSession } from "../opencode/repair-session";
import { loadRun, listRuns } from "../persistence/run-store";
import { listReports } from "../persistence/report-store";
import { loadFindingIndex } from "../persistence/finding-store";
import { saveIgnoredFinding } from "../persistence/ignored-finding-store";
import { StartRunRequestSchema, BatchPlanFixRequestSchema, BatchIgnoreRequestSchema, BatchVerifyRequestSchema } from "../contracts/requests";
import type { SseManager } from "./sse";

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

export function validateProjectKey(key: string, resolveProjectPath: ((serverKey: string, projectKey: string) => string | null) | undefined, serverKey: string): { valid: true; path: string } | { valid: false; status: number; body: unknown } {
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

export async function routeRequest(
  method: string,
  urlPath: string,
  body: unknown,
  resolveProjectPath?: (serverKey: string, projectKey: string) => string | null,
  sseManager?: SseManager,
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
        const check = validateProjectKey(projectKey, resolveProjectPath, serverKey);
        if (!check.valid) return { status: check.status, body: check.body };
        return ok({ available: true, serverKey, projectKey });
      }
    }

    // --- Report ---
    {
      const m = matchRoute("/api/v1/servers/:serverKey/projects/:projectKey/better-harness/report", urlPath);
      if (m && method === "GET") {
        const { serverKey, projectKey } = m.params;
        const check = validateProjectKey(projectKey, resolveProjectPath, serverKey);
        if (!check.valid) return { status: check.status, body: check.body };
        const index = loadFindingIndex(check.path);
        return ok({ project: { name: projectKey }, findings: index?.findings ?? [], updatedAt: index?.updatedAt ?? null });
      }
    }

    // --- History ---
    {
      const m = matchRoute("/api/v1/servers/:serverKey/projects/:projectKey/better-harness/history", urlPath);
      if (m && method === "GET") {
        const { serverKey, projectKey } = m.params;
        const check = validateProjectKey(projectKey, resolveProjectPath, serverKey);
        if (!check.valid) return { status: check.status, body: check.body };
        const runIds = listRuns(check.path);
        const reports = listReports(check.path);
        return ok({ runs: runIds, reports });
      }
    }

    // --- Current run ---
    {
      const m = matchRoute("/api/v1/servers/:serverKey/projects/:projectKey/better-harness/runs/current", urlPath);
      if (m && method === "GET") {
        const { serverKey, projectKey } = m.params;
        const check = validateProjectKey(projectKey, resolveProjectPath, serverKey);
        if (!check.valid) return { status: check.status, body: check.body };
        const runIds = listRuns(check.path);
        if (runIds.length === 0) return ok(null);
        const lastRun = loadRun(check.path, runIds[runIds.length - 1]);
        return ok(lastRun);
      }
    }

    // --- Start run ---
    {
      const m = matchRoute("/api/v1/servers/:serverKey/projects/:projectKey/better-harness/runs", urlPath);
      if (m && method === "POST") {
        const { serverKey, projectKey } = m.params;
        const check = validateProjectKey(projectKey, resolveProjectPath, serverKey);
        if (!check.valid) return { status: check.status, body: check.body };
        const parsed = StartRunRequestSchema.safeParse(body);
        if (!parsed.success) {
          return { status: 400, body: { error: "Invalid request body", details: parsed.error } };
        }
        return created({ accepted: true, runId: "run_" + Date.now() });
      }
    }

    // --- Cancel run ---
    {
      const m = matchRoute("/api/v1/servers/:serverKey/projects/:projectKey/better-harness/runs/:runId/cancel", urlPath);
      if (m && method === "POST") {
        const { serverKey, projectKey, runId } = m.params;
        const check = validateProjectKey(projectKey, resolveProjectPath, serverKey);
        if (!check.valid) return { status: check.status, body: check.body };
        return ok({ accepted: true, runId });
      }
    }

    // --- Plan fix (batch) ---
    {
      const m = matchRoute("/api/v1/servers/:serverKey/projects/:projectKey/better-harness/findings/plan-fix", urlPath);
      if (m && method === "POST") {
        const { serverKey, projectKey } = m.params;
        const check = validateProjectKey(projectKey, resolveProjectPath, serverKey);
        if (!check.valid) return { status: check.status, body: check.body };
        const parsed = BatchPlanFixRequestSchema.safeParse(body);
        if (!parsed.success) {
          return { status: 400, body: { error: "Invalid request body", details: parsed.error } };
        }
        const findings = loadFindingIndex(check.path);
        const results = parsed.data.findingIds.map((fid: string) => {
          const finding = findings?.findings.find((f) => f.id === fid);
          if (!finding) {
            return { findingId: fid, accepted: false, error: "Finding not found" };
          }
          const session = createRepairSession({ finding, projectPath: check.path });
          return { findingId: fid, accepted: true, repairSessionId: session.repairSessionId };
        });
        return ok({ accepted: true, results });
      }
    }

    // --- Ignore findings (batch) ---
    {
      const m = matchRoute("/api/v1/servers/:serverKey/projects/:projectKey/better-harness/findings/ignore", urlPath);
      if (m && method === "POST") {
        const { serverKey, projectKey } = m.params;
        const check = validateProjectKey(projectKey, resolveProjectPath, serverKey);
        if (!check.valid) return { status: check.status, body: check.body };
        const parsed = BatchIgnoreRequestSchema.safeParse(body);
        if (!parsed.success) {
          return { status: 400, body: { error: "Invalid request body", details: parsed.error } };
        }
        const results = parsed.data.findingIds.map((fid: string) => {
          try {
            saveIgnoredFinding(check.path, { findingId: fid, reason: parsed.data.reason, actor: "system", timestamp: new Date().toISOString() });
            return { findingId: fid, accepted: true };
          } catch {
            return { findingId: fid, accepted: false, error: "Failed to ignore finding" };
          }
        });
        return ok({ accepted: true, results });
      }
    }

    // --- Verify findings (batch) ---
    {
      const m = matchRoute("/api/v1/servers/:serverKey/projects/:projectKey/better-harness/findings/verify", urlPath);
      if (m && method === "POST") {
        const { serverKey, projectKey } = m.params;
        const check = validateProjectKey(projectKey, resolveProjectPath, serverKey);
        if (!check.valid) return { status: check.status, body: check.body };
        const parsed = BatchVerifyRequestSchema.safeParse(body);
        if (!parsed.success) {
          return { status: 400, body: { error: "Invalid request body", details: parsed.error } };
        }
        const results = parsed.data.findingIds.map((fid: string) => ({
          findingId: fid,
          accepted: true,
        }));
        return ok({ accepted: true, results });
      }
    }

    // --- SSE events stream ---
    {
      const m = matchRoute("/api/v1/servers/:serverKey/projects/:projectKey/better-harness/runs/:runId/events", urlPath);
      if (m && method === "GET") {
        if (!sseManager) {
          return { status: 501, body: { error: "SSE not available" } };
        }
        return { status: 101, body: { sse: true, sseManager } };
      }
    }

    // --- Get repair session ---
    {
      const m = matchRoute("/api/v1/servers/:serverKey/projects/:projectKey/better-harness/repair-sessions/:sessionId", urlPath);
      if (m && method === "GET") {
        const { serverKey, projectKey, sessionId } = m.params;
        const check = validateProjectKey(projectKey, resolveProjectPath, serverKey);
        if (!check.valid) return { status: check.status, body: check.body };
        return ok({ repairSessionId: sessionId, status: "pending" });
      }
    }

    return { status: 404, body: { error: "Route not found: " + method + " " + urlPath } };
  } catch (err) {
    return handleError(err);
  }
}
