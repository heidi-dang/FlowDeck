/**
 * Integration tests for the ContractService.
 *
 * Validates the full contract lifecycle through the service layer:
 * - Family creation
 * - Draft version creation
 * - Draft update
 * - Activation
 * - Status transitions
 * - Retrieval and listing
 */

import { describe, it, expect, beforeEach } from "bun:test"
import { ContractService } from "@/orchestration/contracts/services/contract-service"
import { InMemoryContractRepository } from "@/orchestration/contracts/adapters/in-memory-contract-repository"
import { FamilyNotFoundError, ImmutableContractError } from "@/orchestration/contracts/domain/errors"
import { FakeClock, FakeIdGenerator } from "./test-utils"

describe("ContractService", () => {
  let repo: InMemoryContractRepository
  let service: ContractService
  let clock: FakeClock
  let idGen: FakeIdGenerator

  beforeEach(() => {
    repo = new InMemoryContractRepository()
    service = new ContractService(repo)
    clock = new FakeClock()
    idGen = new FakeIdGenerator("fam")
  })

  it("creates a contract family", async () => {
    const family = await service.createFamily(
      { name: "Auth Service", description: "Authentication contract" },
      clock,
      idGen,
    )

    expect(family.id).toBe("fam-1")
    expect(family.name).toBe("Auth Service")
    expect(family.versions).toHaveLength(0)
  })

  it("creates a draft version", async () => {
    const family = await service.createFamily({ name: "Test", description: "Test" }, clock, idGen)
    idGen = new FakeIdGenerator("ver")

    const version = await service.draftVersion({
      familyId: family.id,
      specification: {
        requirements: [{ id: "req-1", description: "Critical req", priority: "critical" }],
        acceptanceCriteria: [{ id: "ac-1", description: "AC", condition: "Condition", priority: "critical" }],
        verificationRules: [{ id: "vr-1", description: "VR", scope: "unit", required: true, failureClass: "blocking" }],
      },
      clock,
      idGenerator: idGen,
    })

    expect(version.version).toBe(1)
    expect(version.status).toBe("draft")
    expect(version.familyId).toBe(family.id)
    expect(version.hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it("auto-increments version number for drafts", async () => {
    const family = await service.createFamily({ name: "Test", description: "Test" }, clock, idGen)
    idGen = new FakeIdGenerator("ver")

    const v1 = await service.draftVersion({
      familyId: family.id,
      specification: {
        requirements: [{ id: "req-1", description: "Req", priority: "critical" }],
        acceptanceCriteria: [{ id: "ac-1", description: "AC", condition: "C", priority: "critical" }],
        verificationRules: [],
      },
      clock,
      idGenerator: idGen,
    })

    const v2 = await service.draftVersion({
      familyId: family.id,
      specification: {
        requirements: [{ id: "req-1", description: "Req", priority: "critical" }],
        acceptanceCriteria: [{ id: "ac-1", description: "AC", condition: "C", priority: "critical" }],
        verificationRules: [],
      },
      clock,
      idGenerator: new FakeIdGenerator("ver"),
    })

    expect(v1.version).toBe(1)
    expect(v2.version).toBe(2)
  })

  it("updates a draft version", async () => {
    const family = await service.createFamily({ name: "Test", description: "Test" }, clock, idGen)
    idGen = new FakeIdGenerator("ver")
    const v1 = await service.draftVersion({
      familyId: family.id,
      specification: {
        requirements: [{ id: "req-1", description: "Original", priority: "critical" }],
        acceptanceCriteria: [{ id: "ac-1", description: "AC", condition: "C", priority: "critical" }],
        verificationRules: [],
      },
      clock,
      idGenerator: idGen,
    })

    const updated = await service.updateDraft({
      familyId: family.id,
      versionId: v1.id,
      specification: {
        requirements: [{ id: "req-1", description: "Updated", priority: "critical" }],
        acceptanceCriteria: [{ id: "ac-1", description: "AC", condition: "C", priority: "critical" }],
        verificationRules: [],
      },
      clock,
    })

    expect(updated.hash).not.toBe(v1.hash)
    // v1 was not mutated
    expect(v1.hash).not.toBe(updated.hash)
  })

  it("rejects updating an activated version (immutability)", async () => {
    const family = await service.createFamily({ name: "Test", description: "Test" }, clock, idGen)
    const v1 = await service.draftVersion({
      familyId: family.id,
      specification: {
        requirements: [{ id: "req-1", description: "Critical req", priority: "critical" }],
        acceptanceCriteria: [{ id: "ac-1", description: "AC", condition: "C", priority: "critical" }],
        verificationRules: [],
      },
      clock,
      idGenerator: idGen,
    })

    await service.activateVersion(family.id, v1.id, clock)

    expect(
      service.updateDraft({
        familyId: family.id,
        versionId: v1.id,
        specification: {
          requirements: [{ id: "req-1", description: "Should fail", priority: "critical" }],
          acceptanceCriteria: [{ id: "ac-1", description: "AC", condition: "C", priority: "critical" }],
          verificationRules: [],
        },
        clock,
      })
    ).rejects.toThrow(ImmutableContractError)
  })

  it("activates a draft version", async () => {
    const family = await service.createFamily({ name: "Test", description: "Test" }, clock, idGen)
    const v1 = await service.draftVersion({
      familyId: family.id,
      specification: {
        requirements: [{ id: "req-1", description: "Critical req", priority: "critical" }],
        acceptanceCriteria: [{ id: "ac-1", description: "AC", condition: "C", priority: "critical" }],
        verificationRules: [],
      },
      clock,
      idGenerator: idGen,
    })

    const activated = await service.activateVersion(family.id, v1.id, clock)

    expect(activated.status).toBe("activated")
    expect(activated.activatedAt).toBeDefined()

    // Verify through repository
    const storedFamily = await service.getFamily(family.id)
    expect(storedFamily.activeVersion?.id).toBe(v1.id)
  })

  it("rejects activating with empty specification", async () => {
    const family = await service.createFamily({ name: "Test", description: "Test" }, clock, idGen)
    const v1 = await service.draftVersion({
      familyId: family.id,
      specification: { requirements: [], acceptanceCriteria: [], verificationRules: [] },
      clock,
      idGenerator: idGen,
    })

    expect(
      service.activateVersion(family.id, v1.id, clock)
    ).rejects.toThrow()
  })

  it("transitions activated version to deprecated", async () => {
    const family = await service.createFamily({ name: "Test", description: "Test" }, clock, idGen)
    const v1 = await service.draftVersion({
      familyId: family.id,
      specification: {
        requirements: [{ id: "req-1", description: "Critical req", priority: "critical" }],
        acceptanceCriteria: [{ id: "ac-1", description: "AC", condition: "C", priority: "critical" }],
        verificationRules: [],
      },
      clock,
      idGenerator: idGen,
    })

    await service.activateVersion(family.id, v1.id, clock)
    const deprecated = await service.transitionVersion(family.id, v1.id, "deprecated")

    expect(deprecated.status).toBe("deprecated")
  })

  it("rejects invalid status transition", async () => {
    const family = await service.createFamily({ name: "Test", description: "Test" }, clock, idGen)
    const v1 = await service.draftVersion({
      familyId: family.id,
      specification: {
        requirements: [{ id: "req-1", description: "Critical req", priority: "critical" }],
        acceptanceCriteria: [{ id: "ac-1", description: "AC", condition: "C", priority: "critical" }],
        verificationRules: [],
      },
      clock,
      idGenerator: idGen,
    })

    expect(
      service.transitionVersion(family.id, v1.id, "superseded")
    ).rejects.toThrow()
  })

  it("gets a family by ID", async () => {
    await service.createFamily({ name: "Family 1", description: "First" }, clock, idGen)
    idGen = new FakeIdGenerator("fam2")
    await service.createFamily({ name: "Family 2", description: "Second" }, clock, idGen)

    const family = await service.getFamily("fam-1")
    expect(family.name).toBe("Family 1")
  })

  it("throws FamilyNotFoundError for missing family", async () => {
    expect(
      service.getFamily("nonexistent")
    ).rejects.toThrow(FamilyNotFoundError)
  })

  it("lists all families", async () => {
    await service.createFamily({ name: "A", description: "A" }, clock, idGen)
    idGen = new FakeIdGenerator("fam2")
    await service.createFamily({ name: "B", description: "B" }, clock, idGen)

    const families = await service.listFamilies()
    expect(families).toHaveLength(2)
  })

  it("throws error for unknown family when drafting", async () => {
    expect(
      service.draftVersion({
        familyId: "missing",
        specification: {
          requirements: [{ id: "req-1", description: "Req", priority: "critical" }],
          acceptanceCriteria: [],
          verificationRules: [],
        },
        clock,
        idGenerator: idGen,
      })
    ).rejects.toThrow(FamilyNotFoundError)
  })
})
