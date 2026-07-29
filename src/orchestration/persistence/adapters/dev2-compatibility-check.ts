/**
 * Compile-time compatibility assertions for all 8 Dev 2 adapters.
 *
 * This file verifies that the adapter classes satisfy the authoritative
 * Dev 2 port interfaces when those types are available.
 *
 * It is included in tsconfig and will produce type errors if the adapters
 * drift from the port contracts.
 *
 * Reference Dev 2 SHA: ffff758
 * Reference Dev 2 branch: dev2/orchestration-contract-domain
 *
 * When the Dev 2 types are present on main, these assertions compile.
 * Until then, this file's imports will produce MODULE_NOT_FOUND errors
 * (not adapter compatibility errors).
 */
import type { ContractRepository } from "../../contracts/ports/contract-repository"
import type { VerificationRepository } from "../../verification/ports/verification-repository"
import type { EvidenceRepository } from "../../evidence/ports/evidence-repository"
import type { ApprovalRepository } from "../../approval/ports/approval-repository"
import type { OverrideRepository } from "../../override/ports/override-repository"
import type { CompletionRepository } from "../../completion/ports/completion-repository"
import type { IdempotencyRepository } from "../../idempotency/ports/idempotency-repository"
import type { DomainEventAppender } from "../../events/ports/event-publisher"

import {
  SqliteContractRepoAdapter,
  SqliteVerificationRepoAdapter,
  SqliteEvidenceRepoAdapter,
  SqliteApprovalRepoAdapter,
  SqliteOverrideRepoAdapter,
  SqliteCompletionRepoAdapter,
  SqliteIdempotencyRepoAdapter,
  SqliteEventAppenderAdapter,
} from "./dev2-adapters"

// 8 compile-time assertions — each line errors if the adapter doesn't satisfy the interface
const _contractRepo: ContractRepository = new SqliteContractRepoAdapter(null as any, null as any)
const _verificationRepo: VerificationRepository = new SqliteVerificationRepoAdapter(null as any, null as any)
const _evidenceRepo: EvidenceRepository = new SqliteEvidenceRepoAdapter(null as any, null as any)
const _approvalRepo: ApprovalRepository = new SqliteApprovalRepoAdapter(null as any, null as any)
const _overrideRepo: OverrideRepository = new SqliteOverrideRepoAdapter(null as any, null as any)
const _completionRepo: CompletionRepository = new SqliteCompletionRepoAdapter(null as any, null as any)
const _idempotencyRepo: IdempotencyRepository = new SqliteIdempotencyRepoAdapter(null as any, null as any)
const _eventAppender: DomainEventAppender = new SqliteEventAppenderAdapter(null as any, null as any)

// Suppress unused-variable warnings
void(_contractRepo); void(_verificationRepo); void(_evidenceRepo); void(_approvalRepo)
void(_overrideRepo); void(_completionRepo); void(_idempotencyRepo); void(_eventAppender)
