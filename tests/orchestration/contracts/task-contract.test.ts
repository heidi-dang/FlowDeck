/**
 * Tests for Structured Task Contract system.
 *
 * Validates:
 * - Contract immutability after activation
 * - Deterministic hash
 * - Activation conflict detection
 * - Historical reconstruction
 * - Required-field validation
 * - Mutation-scope validation
 */

import { describe, it, expect } from "bun:test"
import {
  type TaskContract,
  type TaskContractDraft,
  type MutationScope,
} from "@/orchestration/contracts/task-contract"
import { hashContract, verifyContractHash } from "@/orchestration/contracts/contract-hasher"
import {
  validateContractDraft,
  validateMutationScope,
  activateContract,
  validateActivatedContract,
} from "@/orchestration/contracts/contract-validator"
import {
  createContractStore,
  reconstructContractStore,
} from "@/orchestration/contracts/contract-store"
import { ImmutableContractError } from "@/orchestration/contracts/domain/errors"

function makeDraft(overrides: Partial<TaskContractDraft> = {}): TaskContractDraft {
  return {
    id: "contract-001",
    version: "1.0.0",
    objective: "Implement user authentication",
    requirements: [
      { id: "req-1", description: "Must support OAuth2", critical: true, verifiable: true },
      { id: "req-2", description: "Must support session management", critical: true, verifiable: true },
    ],
    acceptanceCriteria: [
      { id: "ac-1", description: "User can login with OAuth2", critical: true, testable: true },
      { id: "ac-2", description: "Session expires after 30 minutes", critical: false, testable: true },
    ],
    constraints: [
      { id: "c-1", description: "Must use HTTPS", enforce: true },
    ],
    exclusions: ["Do not implement SAML"],
    requiredEvidence: [
      { type: "test", description: "OAuth2 integration test results" },
      { type: "file", path: "docs/auth-design.md", description: "Auth design document" },
    ],
    requiredVerification: [
      { type: "test", description: "All auth tests pass" },
      { type: "build", description: "Build succeeds" },
    ],
    startingSha: "abc123def456789012345678901234567890abcd",
    allowedMutationScope: {
      allowedPaths: ["src/auth/", "tests/auth/"],
      deniedPaths: ["src/admin/", "tests/admin/"],
      maxFiles: 50,
    },
    approvalGates: [
      { type: "automatic" },
      { type: "manual", authority: "security-team" },
    ],
    createdAt: new Date("2024-01-15T10:00:00Z"),
    status: "draft",
    ...overrides,
  }
}

describe("Contract hashing", () => {
  it("produces a deterministic hash for identical drafts", () => {
    const draft1 = makeDraft()
    const draft2 = makeDraft()

    const hash1 = hashContract(draft1)
    const hash2 = hashContract(draft2)

    expect(hash1).toBe(hash2)
  })

  it("produces the same hash across repeated calls for the same draft", () => {
    const draft = makeDraft()
    const hash1 = hashContract(draft)
    const hash2 = hashContract(draft)
    const hash3 = hashContract(draft)

    expect(hash1).toBe(hash2)
    expect(hash2).toBe(hash3)
  })

  it("does not depend on object insertion order in arrays", () => {
    const draft1 = makeDraft({
      requirements: [
        { id: "req-1", description: "First", critical: true, verifiable: true },
        { id: "req-2", description: "Second", critical: false, verifiable: true },
      ],
    })

    const draft2 = makeDraft({
      requirements: [
        { id: "req-2", description: "Second", critical: false, verifiable: true },
        { id: "req-1", description: "First", critical: true, verifiable: true },
      ],
    })

    expect(hashContract(draft1)).toBe(hashContract(draft2))
  })

  it("hash changes when objective changes", () => {
    const draft1 = makeDraft({ objective: "Implement auth" })
    const draft2 = makeDraft({ objective: "Implement login" })

    expect(hashContract(draft1)).not.toBe(hashContract(draft2))
  })

  it("hash changes when requirement critical flag changes", () => {
    const draft1 = makeDraft({
      requirements: [{ id: "req-1", description: "Test", critical: true, verifiable: true }],
    })
    const draft2 = makeDraft({
      requirements: [{ id: "req-1", description: "Test", critical: false, verifiable: true }],
    })

    expect(hashContract(draft1)).not.toBe(hashContract(draft2))
  })

  it("hash changes when startingSha changes", () => {
    const draft1 = makeDraft({ startingSha: "abc123def456789012345678901234567890abcd" })
    const draft2 = makeDraft({ startingSha: "def456789012345678901234567890abcdef1234" })

    expect(hashContract(draft1)).not.toBe(hashContract(draft2))
  })

  it("hash changes when constraint enforce flag changes", () => {
    const draft1 = makeDraft({
      constraints: [{ id: "c-1", description: "Must use HTTPS", enforce: true }],
    })
    const draft2 = makeDraft({
      constraints: [{ id: "c-1", description: "Must use HTTPS", enforce: false }],
    })

    expect(hashContract(draft1)).not.toBe(hashContract(draft2))
  })

  it("produces a 64-char hex string (SHA-256)", () => {
    const draft = makeDraft()
    const hash = hashContract(draft)

    expect(hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it("verifies contract hash integrity", () => {
    const draft = makeDraft()
    const hash = hashContract(draft)

    const contract: TaskContract = {
      ...draft,
      hash,
      activatedAt: new Date(),
    }

    expect(verifyContractHash(contract)).toBe(true)
  })

  it("detects tampering via hash mismatch", () => {
    const draft = makeDraft()
    const hash = hashContract(draft)

    const contract: TaskContract = {
      ...draft,
      hash,
      activatedAt: new Date(),
    }

    // Tamper with the objective
    const tamperedContract = { ...contract, objective: "Tampered objective" }

    expect(verifyContractHash(tamperedContract as TaskContract)).toBe(false)
  })
})

describe("Contract validation", () => {
  it("validates a complete draft", () => {
    const draft = makeDraft()
    const result = validateContractDraft(draft)

    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it("fails when id is missing", () => {
    const draft = makeDraft({ id: "" })
    const result = validateContractDraft(draft)

    expect(result.valid).toBe(false)
    expect(result.errors).toContain("Contract ID is required")
  })

  it("fails when version is missing", () => {
    const draft = makeDraft({ version: "" })
    const result = validateContractDraft(draft)

    expect(result.valid).toBe(false)
    expect(result.errors).toContain("Contract version is required")
  })

  it("fails when objective is missing", () => {
    const draft = makeDraft({ objective: "" })
    const result = validateContractDraft(draft)

    expect(result.valid).toBe(false)
    expect(result.errors).toContain("Contract objective is required")
  })

  it("fails when no requirements defined", () => {
    const draft = makeDraft({ requirements: [] })
    const result = validateContractDraft(draft)

    expect(result.valid).toBe(false)
    expect(result.errors).toContain("At least one requirement is required")
  })

  it("fails when requirement missing description", () => {
    const draft = makeDraft({
      requirements: [{ id: "req-1", description: "", critical: true, verifiable: true }],
    })
    const result = validateContractDraft(draft)

    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.includes("missing description"))).toBe(true)
  })

  it("fails when no acceptance criteria defined", () => {
    const draft = makeDraft({ acceptanceCriteria: [] })
    const result = validateContractDraft(draft)

    expect(result.valid).toBe(false)
    expect(result.errors).toContain("At least one acceptance criterion is required")
  })

  it("fails when maxFiles is not positive", () => {
    const draft = makeDraft({
      allowedMutationScope: {
        allowedPaths: [],
        deniedPaths: [],
        maxFiles: 0,
      },
    })
    const result = validateContractDraft(draft)

    expect(result.valid).toBe(false)
    expect(result.errors).toContain("maxFiles must be positive")
  })

  it("fails when file evidence lacks path", () => {
    const draft = makeDraft({
      requiredEvidence: [{ type: "file", description: "File evidence" }],
    })
    const result = validateContractDraft(draft)

    expect(result.valid).toBe(false)
    expect(result.errors).toContain("File evidence requirement must specify path")
  })

  it("fails when custom verification lacks command", () => {
    const draft = makeDraft({
      requiredVerification: [{ type: "custom", description: "Custom verification" }],
    })
    const result = validateContractDraft(draft)

    expect(result.valid).toBe(false)
    expect(result.errors).toContain("Custom verification must specify command")
  })

  it("fails when no approval gates defined", () => {
    const draft = makeDraft({ approvalGates: [] })
    const result = validateContractDraft(draft)

    expect(result.valid).toBe(false)
    expect(result.errors).toContain("At least one approval gate is required")
  })

  it("warns when no constraints defined", () => {
    const draft = makeDraft({ constraints: [] })
    const result = validateContractDraft(draft)

    expect(result.valid).toBe(true)
    expect(result.warnings).toContain("No constraints defined - consider adding at least one constraint")
  })

  it("warns when no evidence requirements specified", () => {
    const draft = makeDraft({ requiredEvidence: [] })
    const result = validateContractDraft(draft)

    expect(result.warnings).toContain("No evidence requirements specified")
  })

  it("warns when no verification requirements specified", () => {
    const draft = makeDraft({ requiredVerification: [] })
    const result = validateContractDraft(draft)

    expect(result.warnings).toContain("No verification requirements specified")
  })
})

describe("Contract activation", () => {
  it("activates a valid contract", () => {
    const store = createContractStore()
    const draft = makeDraft()

    const result = activateContract(draft, store)

    expect(result.success).toBe(true)
    expect(result.contract).toBeDefined()
    expect(result.updatedStore).toBeDefined()
    expect(result.contract!.activatedAt).toBeDefined()
    expect(result.contract!.hash).toBe(hashContract(draft))
  })

  it("fails activation for incomplete draft", () => {
    const store = createContractStore()
    const draft = makeDraft({ objective: "" })

    const result = activateContract(draft, store)

    expect(result.success).toBe(false)
    expect(result.error).toContain("Validation failed")
  })

  it("prevents duplicate activation (conflict detection)", () => {
    let store = createContractStore()
    const draft = makeDraft()

    // First activation
    const result1 = activateContract(draft, store)
    expect(result1.success).toBe(true)
    store = result1.updatedStore!

    // Second activation attempt
    const result2 = activateContract(draft, store)
    expect(result2.success).toBe(false)
    expect(result2.error).toContain("already activated")
  })

  it("creates immutable contract after activation", () => {
    const store = createContractStore()
    const draft = makeDraft()

    const result = activateContract(draft, store)
    const contract = result.contract!

    // Contract should be frozen
    expect(Object.isFrozen(contract)).toBe(true)

    // activatedAt should be set
    expect(contract.activatedAt).toBeDefined()
  })

  it("validates activated contract integrity", () => {
    const store = createContractStore()
    const draft = makeDraft()

    const result = activateContract(draft, store)
    const contract = result.contract!

    const validation = validateActivatedContract(contract)
    expect(validation.valid).toBe(true)
  })

  it("detects tampering in activated contract", () => {
    const store = createContractStore()
    const draft = makeDraft()

    const result = activateContract(draft, store)
    const contract = result.contract!

    // Tamper with the contract
    const tampered = { ...contract, objective: "Tampered" }

    const validation = validateActivatedContract(tampered as TaskContract)
    expect(validation.valid).toBe(false)
    expect(validation.errors.some((e) => e.includes("Hash mismatch"))).toBe(true)
  })
})

describe("Mutation scope validation", () => {
  const scope: MutationScope = {
    allowedPaths: ["src/", "lib/"],
    deniedPaths: ["src/admin/", "secret/"],
    maxFiles: 10,
  }

  it("allows changes within allowed paths", () => {
    const result = validateMutationScope(scope, { path: "src/auth/login.ts", fileCount: 1 })

    expect(result.valid).toBe(true)
  })

  it("denies changes to denied paths", () => {
    const result = validateMutationScope(scope, { path: "src/admin/users.ts", fileCount: 1 })

    expect(result.valid).toBe(false)
    expect(result.error).toContain("explicitly denied")
  })

  it("denies changes outside allowed paths when allowedPaths specified", () => {
    const result = validateMutationScope(scope, { path: "other/file.ts", fileCount: 1 })

    expect(result.valid).toBe(false)
    expect(result.error).toContain("not in allowed paths")
  })

  it("denies when file count exceeds maxFiles", () => {
    const result = validateMutationScope(scope, { path: "src/auth/", fileCount: 15 })

    expect(result.valid).toBe(false)
    expect(result.error).toContain("exceeds maximum")
  })

  it("allows denied path if no allowedPaths restriction", () => {
    const unrestrictedScope: MutationScope = {
      allowedPaths: [],
      deniedPaths: ["secret/"],
      maxFiles: 50,
    }

    const result = validateMutationScope(unrestrictedScope, { path: "src/file.ts", fileCount: 1 })

    expect(result.valid).toBe(true)
  })
})

describe("Contract store", () => {
  it("stores and retrieves contracts by id", () => {
    const store = createContractStore()
    const draft = makeDraft({ id: "contract-001" })

    const result = activateContract(draft, store)
    const newStore = result.updatedStore!

    const retrieved = newStore.getById("contract-001")

    expect(retrieved).toBeDefined()
    expect(retrieved!.id).toBe("contract-001")
  })

  it("stores and retrieves contracts by hash", () => {
    const store = createContractStore()
    const draft = makeDraft()

    const result = activateContract(draft, store)
    const newStore = result.updatedStore!

    const retrieved = newStore.getByHash(result.contract!.hash)

    expect(retrieved).toBeDefined()
    expect(retrieved!.hash).toBe(result.contract!.hash)
  })

  it("retrieves contracts by starting SHA for historical reconstruction", () => {
    let store = createContractStore()
    const draft1 = makeDraft({ id: "contract-001", startingSha: "abc123def456789012345678901234567890abcd" })
    const draft2 = makeDraft({ id: "contract-002", startingSha: "abc123def456789012345678901234567890abcd" })
    const draft3 = makeDraft({ id: "contract-003", startingSha: "def456789012345678901234567890abcdef1234" })

    const result1 = activateContract(draft1, store)
    store = result1.updatedStore!
    const result2 = activateContract(draft2, store)
    store = result2.updatedStore!
    const result3 = activateContract(draft3, store)
    store = result3.updatedStore!

    const fromSha = store.getByStartingSha("abc123def456789012345678901234567890abcd")

    expect(fromSha).toHaveLength(2)
    expect(fromSha.map((c) => c.id).sort()).toEqual(["contract-001", "contract-002"])
  })

  it("throws when storing duplicate contract id", () => {
    const store = createContractStore()
    const draft = makeDraft({ id: "contract-001" })

    const result = activateContract(draft, store)
    const newStore = result.updatedStore!

    expect(() => newStore.withContract(result.contract!)).toThrow(ImmutableContractError)
  })

  it("reconstructs store from contracts list", () => {
    const draft1 = makeDraft({ id: "contract-001" })
    const draft2 = makeDraft({ id: "contract-002" })

    const hash1 = hashContract(draft1)
    const hash2 = hashContract(draft2)

    const contracts: TaskContract[] = [
      { ...draft1, hash: hash1, activatedAt: new Date() },
      { ...draft2, hash: hash2, activatedAt: new Date() },
    ]

    const store = reconstructContractStore(contracts)

    expect(store.getById("contract-001")).toBeDefined()
    expect(store.getById("contract-002")).toBeDefined()
    expect(store.size).toBe(2)
  })

  it("getAll returns all contracts", () => {
    let store = createContractStore()
    const draft1 = makeDraft({ id: "contract-001" })
    const draft2 = makeDraft({ id: "contract-002" })

    const result1 = activateContract(draft1, store)
    store = result1.updatedStore!
    const result2 = activateContract(draft2, store)
    store = result2.updatedStore!

    const all = store.getAll()

    expect(all).toHaveLength(2)
  })

  it("returns undefined for unknown id", () => {
    const store = createContractStore()

    expect(store.getById("unknown")).toBeUndefined()
  })

  it("returns undefined for unknown hash", () => {
    const store = createContractStore()

    expect(store.getByHash("unknownhash")).toBeUndefined()
  })

  it("empty store has size 0", () => {
    const store = createContractStore()

    expect(store.size).toBe(0)
  })
})

describe("Contract immutability", () => {
  it("activated contract cannot be modified", () => {
    const store = createContractStore()
    const draft = makeDraft()

    const result = activateContract(draft, store)
    const contract = result.contract!

    // Try to modify the contract - should not work
    expect(Object.isFrozen(contract)).toBe(true)
  })

  it("requirement arrays are frozen", () => {
    const store = createContractStore()
    const draft = makeDraft()

    const result = activateContract(draft, store)
    const contract = result.contract!

    expect(Object.isFrozen(contract.requirements)).toBe(true)
    expect(Object.isFrozen(contract.acceptanceCriteria)).toBe(true)
    expect(Object.isFrozen(contract.constraints)).toBe(true)
  })

  it("mutation scope is frozen", () => {
    const store = createContractStore()
    const draft = makeDraft()

    const result = activateContract(draft, store)
    const contract = result.contract!

    expect(Object.isFrozen(contract.allowedMutationScope)).toBe(true)
    expect(Object.isFrozen(contract.allowedMutationScope.allowedPaths)).toBe(true)
  })

  it("store returns frozen contracts", () => {
    const store = createContractStore()
    const draft = makeDraft()

    const result = activateContract(draft, store)
    const newStore = result.updatedStore!

    const retrieved = newStore.getById(draft.id)!

    expect(Object.isFrozen(retrieved)).toBe(true)
  })
})
