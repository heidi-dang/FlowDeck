import { EventBus } from "./event-bus";
import { isRunCancelled, clearCancellation } from "./run-cancellation";
import { runAllCollectors } from "../collectors/collector-runner";
import { analyzeTaskUnderstanding } from "../analyzers/task-understanding";
import { analyzeControlledExecution } from "../analyzers/controlled-execution";
import { analyzeChangeValidation } from "../analyzers/change-validation";
import { analyzeReliableDelivery } from "../analyzers/reliable-delivery";
import { analyzeLearningCapture } from "../analyzers/learning-capture";
import { synthesizeFindings } from "../analyzers/finding-synthesizer";
import { scoreDimension } from "../scoring/dimension-scoring";
import { calculateOverallScore } from "../scoring/overall-scoring";
import { SCORING_VERSION } from "../scoring/scoring-version";
import { captureWorkspaceSnapshot } from "../workspace/workspace-snapshot";
import { getProjectIdentity } from "../workspace/project-identity";
import { saveRun, type StoredRun } from "../persistence/run-store";
import type { HarnessReport } from "../contracts/report";
import { saveReport } from "../persistence/report-store";
import { saveFindingIndex } from "../persistence/finding-store";
import { readSessionRecords } from "../opencode/session-reader";
import { analyzeSessions } from "../opencode/session-analyzer";
import type { HarnessRunStatus } from "../contracts/common";

export interface RunConfig {
  projectRoot: string;
  timeoutMs?: number;
}

export interface RunState {
  runId: string;
  status: HarnessRunStatus;
  progressPercent: number;
  stage: string;
  errorMessage?: string;
}

export class RunCoordinator {
  private eventBus = new EventBus();
  private activeRun: RunState | null = null;

  getEventBus(): EventBus {
    return this.eventBus;
  }

  isActive(): boolean {
    return this.activeRun !== null && (this.activeRun.status === "queued" || this.activeRun.status === "running");
  }

  async startRun(config: RunConfig): Promise<RunState> {
    if (this.isActive()) {
      throw new Error("A run is already in progress for this coordinator");
    }

    const runId = `run_${Date.now()}`;
    const projectRoot = config.projectRoot;
    const _timeoutMs = config.timeoutMs ?? 120_000;

    this.activeRun = {
      runId,
      status: "queued",
      progressPercent: 0,
      stage: "initializing",
    };

    this.eventBus.emit("run.queued", { runId });

    const _projectIdentity = getProjectIdentity(projectRoot);
    const snapshot = captureWorkspaceSnapshot(projectRoot);

    // Save initial run record
    const runRecord: StoredRun = {
      runId,
      projectId: snapshot.projectId,
      status: "running",
      startedAt: new Date().toISOString(),
      stage: "collecting",
      progressPercent: 5,
    };
    saveRun(snapshot.projectId, runRecord);

    const _startTime = Date.now();

    try {
      // Phase 1: Collect evidence
      this.activeRun.status = "running";
      this.activeRun.stage = "collecting";
      this.eventBus.emit("run.started", { runId });
      this.eventBus.emit("collector.started", { runId });

      const { evidence, collectorResults: _collectorResults } = await runAllCollectors(projectRoot);

      this.activeRun.progressPercent = 30;
      this.eventBus.emit("collector.completed", { runId, evidenceCount: evidence.length });

      // Check cancellation
      if (isRunCancelled(runId)) {
        return this.failRun(runId, snapshot.projectId, "Run cancelled during collection");
      }

      // Phase 2: Analyze
      this.activeRun.stage = "analyzing";
      this.eventBus.emit("analysis.started", { runId });

      const dimensionResults = [
        analyzeTaskUnderstanding(evidence),
        analyzeControlledExecution(evidence),
        analyzeChangeValidation(evidence),
        analyzeReliableDelivery(evidence, projectRoot),
        analyzeLearningCapture(evidence),
      ];

      this.activeRun.progressPercent = 55;

      // Synthesize findings
      const findings = synthesizeFindings(dimensionResults.map((r) => ({
        dimension: r.dimension,
        findings: r.findings,
      })));

      // Score dimensions
      const dimensionScores = dimensionResults.map((dr) =>
        scoreDimension({
          dimension: dr.dimension,
          findings,
          evidenceCoverage: evidence.length > 0 ? Math.min(100, Math.round((evidence.length / 20) * 100)) : 0,
        }),
      );

      this.activeRun.progressPercent = 75;
      this.eventBus.emit("finding.created", { runId, findingCount: findings.length });

      // Phase 3: Score
      this.activeRun.stage = "scoring";
      const { overallScore, evidenceCoverage } = calculateOverallScore(dimensionScores);

      // Read session data
      const sessionRecords = readSessionRecords(projectRoot);
      const sessionAnalysis = analyzeSessions(sessionRecords);

      // Build report
      const now = new Date().toISOString();
      const report: HarnessReport = {
        schemaVersion: 1,
        engineVersion: "1.0.0",
        scoringVersion: SCORING_VERSION,
        generatedAt: now,
        sourceRevision: snapshot.revision || undefined,
        project: {
          name: snapshot.projectId,
          directory: projectRoot,
        },
        overallScore,
        evidenceCoverage,
        dimensions: dimensionScores,
        findings,
        sessions: {
          analyzed: sessionAnalysis.totalSessions,
          longSessions: sessionAnalysis.longSessions,
          failedSessions: sessionAnalysis.failedSessions,
          repeatedFailures: sessionAnalysis.repeatedFailures,
          compactions: sessionAnalysis.compactions,
          permissionInterruptions: sessionAnalysis.permissionInterruptions,
        },
        assets: {
          agents: evidence.filter((e) => e.source.includes("agents")).length,
          skills: evidence.filter((e) => e.source.includes("skills")).length,
          commands: evidence.filter((e) => e.source.includes("commands")).length,
          rules: evidence.filter((e) => e.source.includes("rules")).length,
          hooks: evidence.filter((e) => e.source.includes("hooks")).length,
          scripts: evidence.filter((e) => e.source.includes("scripts")).length,
          workflows: evidence.filter((e) => e.source.includes("workflows")).length,
          tests: evidence.filter((e) => e.summary.includes("Test script")).length,
          lessons: evidence.filter((e) => e.summary.includes("lessons") || e.summary.includes("Lessons")).length,
          memoryNodes: 0,
        },
      };

      saveReport(snapshot.projectId, report);

      // Save finding history
      
      saveFindingIndex(snapshot.projectId, findings);

      // Complete run
      this.activeRun.progressPercent = 100;
      this.activeRun.status = "completed";
      this.activeRun.stage = "completed";
      this.eventBus.emit("report.completed", { runId, report });

      const completedRecord: StoredRun = {
        ...runRecord,
        status: "completed",
        completedAt: new Date().toISOString(),
        progressPercent: 100,
      };
      saveRun(snapshot.projectId, completedRecord);

      return { ...this.activeRun };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return this.failRun(runId, snapshot.projectId, msg);
    } finally {
      clearCancellation(runId);
    }
  }

  private failRun(runId: string, projectId: string, errorMessage: string): RunState {
    const status: RunState = {
      runId,
      status: "failed",
      progressPercent: this.activeRun?.progressPercent ?? 0,
      stage: this.activeRun?.stage ?? "unknown",
      errorMessage,
    };
    this.activeRun = status;
    this.eventBus.emit("run.failed", { runId, errorMessage });

    saveRun(projectId, {
      runId,
      projectId,
      status: "failed",
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      errorMessage,
      stage: status.stage,
    });

    return status;
  }

  getActiveRun(): RunState | null {
    return this.activeRun;
  }
}


