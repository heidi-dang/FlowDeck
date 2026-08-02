import { describe, it, expect, beforeEach } from "bun:test";
import { CancellationService } from "../../../src/orchestration/recovery/cancellation-service";
import type {
  CheckpointRepositoryPort,
  OwnershipPort,
  CancellationPhaseRepositoryPort,
} from "../../../src/orchestration/recovery/cancellation-service";
import { MAX_RECOVERY_ATTEMPTS } from "../../../src/orchestration/recovery/recovery-state";
import type { Checkpoint, SerializedCheckpoint } from "../../../src/orchestration/recovery/recovery-state";

const makeCheckpoint = (runId = "run-1"): Checkpoint => ({
  id: "cp-1",
  runId,
  stateSnapshot: {
    phase: "planning",
    progress: 0.5,
    assignments: ["a"],
    verifications: [],
    completedTools: [],
    pendingTools: ["t1"],
    metadata: { k: "v" },
  },
  createdAt: new Date("2026-01-01T00:00:00Z"),
  hash: "abc123",
});

const makeSerializedCheckpoint = (runId = "run-1"): SerializedCheckpoint => ({
  id: "cp-1",
  runId,
  stateSnapshot: {
    phase: "planning",
    progress: 0.5,
    assignments: ["a"],
    verifications: [],
    completedTools: [],
    pendingTools: ["t1"],
    metadata: { k: "v" },
  },
  createdAt: "2026-01-01T00:00:00Z",
  hash: "abc123",
});

describe("CancellationService", () => {
  let service: CancellationService;

  beforeEach(() => {
    service = new CancellationService();
  });

  describe("token creation", () => {
    it("should create a root token and initialize phase to active", () => {
      const token = service.createRootToken("run-1");
      expect(token.id).toBe("token:root:run-1");
      expect(token.isRoot).toBe(true);
      expect(token.isCancelled).toBe(false);
      expect(token.children.size).toBe(0);
      expect(service.getToken(token.id)).toBe(token);
    });

    it("should create a child token linked to its parent", () => {
      const root = service.createRootToken("run-1");
      const child = service.createChildToken(root.id, "child-1");
      expect(child.id).toBe("token:child:child-1");
      expect(child.isRoot).toBe(false);
      expect(child.parentId).toBe(root.id);
      expect(service.getToken(root.id)?.children.has(child.id)).toBe(true);
    });

    it("should return existing child token when same parent creates it again", () => {
      const root = service.createRootToken("run-1");
      const child1 = service.createChildToken(root.id, "child-1");
      const child2 = service.createChildToken(root.id, "child-1");
      expect(child2).toBe(child1);
    });

    it("should throw when creating child under a missing parent", () => {
      expect(() => service.createChildToken("token:root:nope", "c")).toThrow(
        "CANCELLATION_TOKEN_NOT_FOUND",
      );
    });

    it("should throw when child id exists with a different parent", () => {
      const root1 = service.createRootToken("run-1");
      const root2 = service.createRootToken("run-2");
      service.createChildToken(root1.id, "shared");
      expect(() => service.createChildToken(root2.id, "shared")).toThrow(
        "CANCELLATION_TOKEN_EXISTS",
      );
    });
  });

  describe("cancel", () => {
    it("should cancel a token and record reason and timestamp", async () => {
      const root = service.createRootToken("run-1");
      const result = await service.cancel(root.id, { reason: "user request" });
      expect(result).toBe(true);
      const token = service.getToken(root.id);
      expect(token?.isCancelled).toBe(true);
      expect(token?.reason).toBe("user request");
      expect(token?.cancelledAt).toBeInstanceOf(Date);
    });

    it("should return false for idempotent cancel without force", async () => {
      const root = service.createRootToken("run-1");
      await service.cancel(root.id);
      const result = await service.cancel(root.id);
      expect(result).toBe(false);
    });

    it("should throw when cancelling an unknown token", async () => {
      await expect(service.cancel("token:root:missing")).rejects.toThrow(
        "CANCELLATION_TOKEN_NOT_FOUND",
      );
    });

    it("should transition root phase to graceful_requested on graceful cancel", async () => {
      const root = service.createRootToken("run-1");
      await service.cancel(root.id, { reason: "graceful" });
      expect(await service.getCancelPhase("run-1")).toBe("graceful_requested");
    });

    it("should transition root phase to force_requested then completed on force cancel", async () => {
      const root = service.createRootToken("run-1");
      await service.cancel(root.id, { force: true, reason: "now" });
      expect(await service.getCancelPhase("run-1")).toBe("completed");
    });

    it("should not transition phase for child tokens", async () => {
      const root = service.createRootToken("run-1");
      const child = service.createChildToken(root.id, "c1");
      await service.cancel(child.id, { reason: "child cancel" });
      expect(await service.getCancelPhase("run-1")).toBe("active");
    });

    it("should propagate cancellation to children", async () => {
      const root = service.createRootToken("run-1");
      const child = service.createChildToken(root.id, "c1");
      const grandchild = service.createChildToken(child.id, "gc1");
      await service.cancel(root.id, { reason: "parent" });
      expect(service.getToken(child.id)?.isCancelled).toBe(true);
      expect(service.getToken(grandchild.id)?.isCancelled).toBe(true);
    });

    it("should emit a token.cancelled event with children list", async () => {
      const events: string[] = [];
      service.onEvent((e) => {
        if (e.type === "token.cancelled") events.push(e.tokenId);
      });
      const root = service.createRootToken("run-1");
      const child = service.createChildToken(root.id, "c1");
      await service.cancel(root.id);
      expect(events).toContain(root.id);
      expect(events).toContain(child.id);
    });

    it("should release owned tools and model calls on cancel", async () => {
      const releasedTools: string[] = [];
      const releasedModels: string[] = [];
      const ownershipPort: OwnershipPort = {
        releaseTool: async (t) => { releasedTools.push(t); },
        releaseModelCall: async (m) => { releasedModels.push(m); },
        getOwnedTools: async () => [],
        getOwnedModelCalls: async () => [],
      };
      service.setOwnershipPort(ownershipPort);
      const root = service.createRootToken("run-1");
      service.acquireToolOwnership("tool-1", root.id);
      service.acquireModelCallOwnership("model-1", root.id);
      await service.cancel(root.id, { force: true });
      expect(releasedTools).toContain("tool-1");
      expect(releasedModels).toContain("model-1");
    });
  });

  describe("phase tracking with repository", () => {
    it("should persist phases to the phase repository when configured", async () => {
      const saved: Array<{ runId: string; phase: string }> = [];
      const phaseRepo: CancellationPhaseRepositoryPort = {
        savePhase: async (runId, phase) => { saved.push({ runId, phase }); },
        loadPhase: async () => null,
        deletePhase: async () => {},
      };
      service.setPhaseRepository(phaseRepo);
      const root = service.createRootToken("run-1");
      await service.cancel(root.id, { reason: "g" });
      expect(saved).toContainEqual({ runId: "run-1", phase: "graceful_requested" });
    });

    it("should load phase from repository when configured", async () => {
      const phaseRepo: CancellationPhaseRepositoryPort = {
        savePhase: async () => {},
        loadPhase: async () => ({ runId: "run-1", phase: "force_requested", updatedAt: new Date() }),
        deletePhase: async () => {},
      };
      service.setPhaseRepository(phaseRepo);
      expect(await service.getCancelPhase("run-1")).toBe("force_requested");
    });

    it("should fall back to in-memory phase when repository returns null", async () => {
      const phaseRepo: CancellationPhaseRepositoryPort = {
        savePhase: async () => {},
        loadPhase: async () => null,
        deletePhase: async () => {},
      };
      service.setPhaseRepository(phaseRepo);
      service.createRootToken("run-1");
      expect(await service.getCancelPhase("run-1")).toBe("active");
    });
  });

  describe("cancelTool and cancelModel", () => {
    it("should return false when tool is not owned", async () => {
      expect(await service.cancelTool("tool-x")).toBe(false);
    });

    it("should release and emit event for an owned tool", async () => {
      const events: string[] = [];
      service.onEvent((e) => {
        if (e.type === "tool.cancelled") events.push(e.tokenId);
      });
      const root = service.createRootToken("run-1");
      service.acquireToolOwnership("tool-1", root.id);
      const result = await service.cancelTool("tool-1");
      expect(result).toBe(true);
      expect(events).toContain(root.id);
    });

    it("should return false when model is not owned", async () => {
      expect(await service.cancelModel("model-x")).toBe(false);
    });

    it("should release and emit event for an owned model call", async () => {
      const events: string[] = [];
      service.onEvent((e) => {
        if (e.type === "model.cancelled") events.push(e.tokenId);
      });
      const root = service.createRootToken("run-1");
      service.acquireModelCallOwnership("model-1", root.id);
      const result = await service.cancelModel("model-1");
      expect(result).toBe(true);
      expect(events).toContain(root.id);
    });
  });

  describe("ownership", () => {
    it("should allow acquiring ownership with an active token", () => {
      const root = service.createRootToken("run-1");
      expect(() => service.acquireToolOwnership("t", root.id)).not.toThrow();
      expect(() => service.acquireModelCallOwnership("m", root.id)).not.toThrow();
    });

    it("should throw when acquiring ownership with an unknown token", () => {
      expect(() => service.acquireToolOwnership("t", "token:root:nope")).toThrow(
        "CANCELLATION_TOKEN_INVALID",
      );
      expect(() => service.acquireModelCallOwnership("m", "token:root:nope")).toThrow(
        "CANCELLATION_TOKEN_INVALID",
      );
    });

    it("should throw when acquiring ownership with a cancelled token", async () => {
      const root = service.createRootToken("run-1");
      await service.cancel(root.id);
      expect(() => service.acquireToolOwnership("t", root.id)).toThrow(
        "CANCELLATION_TOKEN_INVALID",
      );
    });
  });

  describe("checkpoints", () => {
    it("should throw when saving without a checkpoint repository", async () => {
      await expect(service.saveCheckpoint(makeCheckpoint())).rejects.toThrow(
        "CHECKPOINT_REPOSITORY_NOT_CONFIGURED",
      );
    });

    it("should save and load a checkpoint through the repository", async () => {
      const saved: SerializedCheckpoint[] = [];
      const repo: CheckpointRepositoryPort = {
        saveCheckpoint: async (c) => { saved.push(c); },
        getLatestCheckpoint: async (runId) => saved.find((c) => c.runId === runId) ?? null,
        deleteCheckpointsForRun: async () => {},
      };
      service.setCheckpointRepository(repo);
      await service.saveCheckpoint(makeCheckpoint("run-1"));
      const loaded = await service.getLatestCheckpoint("run-1");
      expect(loaded).not.toBeNull();
      expect(loaded?.id).toBe("cp-1");
      expect(loaded?.createdAt).toBeInstanceOf(Date);
    });

    it("should return null when no checkpoint exists for a run", async () => {
      const repo: CheckpointRepositoryPort = {
        saveCheckpoint: async () => {},
        getLatestCheckpoint: async () => null,
        deleteCheckpointsForRun: async () => {},
      };
      service.setCheckpointRepository(repo);
      expect(await service.getLatestCheckpoint("run-1")).toBeNull();
    });

    it("should throw when loading without a checkpoint repository", async () => {
      await expect(service.getLatestCheckpoint("run-1")).rejects.toThrow(
        "CHECKPOINT_REPOSITORY_NOT_CONFIGURED",
      );
    });
  });

  describe("recovery state", () => {
    it("should build recovery state without a checkpoint repository (graceful degrade)", async () => {
      const state = await service.buildRecoveryState("run-1", "cp-1", false);
      expect(state.runId).toBe("run-1");
      expect(state.checkpointId).toBe("cp-1");
      expect(state.recoveryAttempts).toBe(0);
      expect(state.changedHypothesis).toBe(false);
      expect(state.circuitBreakerOpen).toBe(false);
      expect(state.lastCheckpointAt).toBeInstanceOf(Date);
    });

    it("should include latest checkpoint and retry fingerprint when available", async () => {
      const repo: CheckpointRepositoryPort = {
        saveCheckpoint: async () => {},
        getLatestCheckpoint: async () => makeSerializedCheckpoint("run-1"),
        deleteCheckpointsForRun: async () => {},
      };
      service.setCheckpointRepository(repo);
      service.recordRecoveryAttempt("run-1");
      service.recordRecoveryAttempt("run-1");
      const state = await service.buildRecoveryState(
        "run-1",
        "cp-1",
        true,
        "fp-1",
        true,
      );
      expect(state.changedHypothesis).toBe(true);
      expect(state.retryFingerprint).toBe("fp-1");
      expect(state.circuitBreakerOpen).toBe(true);
      expect(state.recoveryAttempts).toBe(2);
      expect(state.lastCheckpointAt).toEqual(new Date("2026-01-01T00:00:00Z"));
    });

    it("should degrade gracefully when checkpoint repo read fails", async () => {
      const repo: CheckpointRepositoryPort = {
        saveCheckpoint: async () => {},
        getLatestCheckpoint: async () => { throw new Error("db down"); },
        deleteCheckpointsForRun: async () => {},
      };
      service.setCheckpointRepository(repo);
      const state = await service.buildRecoveryState("run-1", "cp-1", false);
      expect(state.lastCheckpointAt).toBeInstanceOf(Date);
    });

    it("should cap recovery attempts at MAX_RECOVERY_ATTEMPTS", () => {
      for (let i = 0; i < 5; i++) {
        service.recordRecoveryAttempt("run-1");
      }
      expect(service.getRecoveryAttemptCount("run-1")).toBe(5);
      // countRecoveryAttempts caps at MAX_RECOVERY_ATTEMPTS
      expect(MAX_RECOVERY_ATTEMPTS).toBe(3);
    });

    it("should restore recovery attempts from persisted state", () => {
      service.restoreRecoveryAttempts("run-1", 2);
      expect(service.getRecoveryAttemptCount("run-1")).toBe(2);
    });
  });

  describe("serialization", () => {
    it("should serialize an existing token", () => {
      const root = service.createRootToken("run-1");
      const serialized = service.serializeToken(root.id);
      expect(serialized).not.toBeNull();
      expect(serialized?.id).toBe(root.id);
      expect(serialized?.children).toEqual([]);
    });

    it("should return null when serializing an unknown token", () => {
      expect(service.serializeToken("token:root:nope")).toBeNull();
    });

    it("should deserialize and restore a token", () => {
      service.deserializeAndRestore({
        id: "token:root:run-9",
        isCancelled: false,
        isRoot: true,
        children: [],
      });
      const token = service.getToken("token:root:run-9");
      expect(token).toBeDefined();
      expect(token?.isRoot).toBe(true);
    });
  });

  describe("events and disposal", () => {
    it("should remove handler via returned unsubscribe function", async () => {
      const seen: string[] = [];
      const off = service.onEvent((e) => { seen.push(e.type); });
      const root = service.createRootToken("run-1");
      await service.cancel(root.id, { force: true });
      expect(seen).toContain("token.cancelled");
      off();
      seen.length = 0;
      const root2 = service.createRootToken("run-2");
      await service.cancel(root2.id, { force: true });
      expect(seen).toHaveLength(0);
    });

    it("should tolerate throwing event handlers", async () => {
      service.onEvent(() => { throw new Error("handler boom"); });
      const root = service.createRootToken("run-1");
      await expect(service.cancel(root.id, { force: true })).resolves.toBe(true);
    });

    it("should dispose all state and stop timers", async () => {
      const root = service.createRootToken("run-1");
      service.acquireToolOwnership("t", root.id);
      const child = service.createChildToken(root.id, "c");
      void child;
      await service.cancel(root.id, { reason: "cleanup" });
      service.dispose();
      expect(service.getToken(root.id)).toBeUndefined();
      expect(service.serializeToken(root.id)).toBeNull();
      expect(await service.getCancelPhase("run-1")).toBe("active");
    });
  });

  describe("force escalation", () => {
    it("should escalate to force_requested after timeout and mark completed", async () => {
      service = new CancellationService({ defaultTimeoutMs: 10 });
      const events: string[] = [];
      service.onEvent((e) => {
        if (e.type === "token.cancelled") events.push(e.reason ?? "");
      });
      const root = service.createRootToken("run-1");
      await service.cancel(root.id, { reason: "slow" });
      // Wait for the timeout to fire and escalate
      await new Promise((r) => setTimeout(r, 50));
      const token = service.getToken(root.id);
      expect(token?.reason?.startsWith("FORCED:")).toBe(true);
      expect(await service.getCancelPhase("run-1")).toBe("completed");
      expect(events.some((r) => r.startsWith("FORCED:"))).toBe(true);
    });

    it("should not double-cancel children during escalation", async () => {
      service = new CancellationService({ defaultTimeoutMs: 10 });
      const root = service.createRootToken("run-1");
      service.createChildToken(root.id, "c1");
      await service.cancel(root.id, { reason: "slow" });
      await new Promise((r) => setTimeout(r, 50));
      const phase = await service.getCancelPhase("run-1");
      expect(phase).toBe("completed");
    });
  });
});
