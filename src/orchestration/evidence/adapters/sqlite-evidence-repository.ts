/**
 * SQLite-backed evidence repository.
 *
 * Implements the canonical `EvidenceRepository` port over the frozen v0.2.6
 * schema (`evidence`, `evidence_lifecycle`, `run_criterion_evidence`).
 *
 * Mapping notes:
 *  - Domain `content` → `evidence.title` (summary) + `evidence.description`
 *    (full content).
 *  - Domain `contentType` → `evidence.evidence_type`.
 *  - Domain `criterionIds` → `run_criterion_evidence` rows, resolved through
 *    `run_acceptance_criteria` (run-scoped criterion binding). Criterion ids
 *    supplied by callers are acceptance_criteria ids; the repository resolves
 *    them to the run-scoped row for the evidence's run.
 *  - Domain `status`/`createdAt` → `evidence_lifecycle.status` and
 *    `evidence.created_at`.
 *
 * All writes go through the injected TransactionManager so they participate
 * in the caller's transaction boundary (rollback-safe).
 */

import type { Database } from "bun:sqlite";
import type { EvidenceRepository } from "../ports/evidence-repository";
import { Evidence } from "../domain/evidence";
import { EvidenceLink } from "../domain/evidence-link";
import type { TransactionManager } from "../../persistence/transaction-manager";

interface EvidenceRow {
  id: string;
  run_id: string;
  evidence_type: string;
  title: string;
  description: string | null;
  source: string;
  source_id: string | null;
  content_hash: string;
  file_path: string | null;
  format: string;
  size: number | null;
  sha: string;
  created_at: string;
}

interface LifecycleRow {
  status: string;
}

interface CriterionLinkRow {
  run_acceptance_criterion_id: string;
  criterion_id: string | null;
}

export class SqliteEvidenceRepository implements EvidenceRepository {
  constructor(
    private readonly db: Database,
    private readonly tx: TransactionManager,
  ) {}

  async saveEvidence(evidence: Evidence): Promise<void> {
    this.tx.write(() => {
      const createdAt = evidence.createdAt.toISOString();
      const title = evidence.content.length > 240 ? `${evidence.content.slice(0, 240)}…` : evidence.content;
      this.db.query(
        `INSERT INTO evidence (id, run_id, evidence_type, title, description, source, source_id, content_hash, file_path, format, size, sha, created_at)
         VALUES (?, ?, ?, ?, ?, 'better-harness', ?, ?, NULL, 'better-harness/v1', ?, ?, ?)`,
      ).run(
        evidence.id,
        evidence.runId,
        evidence.contentType,
        title,
        evidence.content,
        evidence.id,
        evidence.content.length,
        evidence.sha,
        createdAt,
      );

      // Lifecycle row (current by default; archived evidence is marked archived).
      this.db.query(
        `INSERT OR REPLACE INTO evidence_lifecycle (evidence_id, status, superseded_at, expires_at)
         VALUES (?, ?, NULL, NULL)`,
      ).run(evidence.id, evidence.status === "archived" ? "archived" : "current");

      // Criterion linkage: resolve acceptance_criteria ids to the run-scoped
      // run_acceptance_criteria row for this evidence's run.
      for (const criterionId of evidence.criterionIds) {
        const rac = this.db.query(
          "SELECT id FROM run_acceptance_criteria WHERE run_id = ? AND criterion_id = ?",
        ).get(evidence.runId, criterionId) as { id: string } | undefined;
        if (!rac) {
          throw new Error(
            `Criterion ${criterionId} is not bound to run ${evidence.runId} (run_acceptance_criteria row missing)`,
          );
        }
        this.db.query(
          `INSERT OR IGNORE INTO run_criterion_evidence (run_acceptance_criterion_id, evidence_id, relationship, linked_at)
           VALUES (?, ?, 'verifies', ?)`,
        ).run(rac.id, evidence.id, createdAt);
      }
    });
  }

  async getEvidence(evidenceId: string): Promise<Evidence | undefined> {
    const row = this.db.query(
      `SELECT e.*, lc.status AS lifecycle_status
       FROM evidence e
       LEFT JOIN evidence_lifecycle lc ON lc.evidence_id = e.id
       WHERE e.id = ?`,
    ).get(evidenceId) as (EvidenceRow & { lifecycle_status: string | null }) | undefined;
    if (!row) return undefined;

    const criterionRows = this.db.query(
      `SELECT rce.run_acceptance_criterion_id, rac.criterion_id
       FROM run_criterion_evidence rce
       LEFT JOIN run_acceptance_criteria rac ON rac.id = rce.run_acceptance_criterion_id
       WHERE rce.evidence_id = ?`,
    ).all(evidenceId) as CriterionLinkRow[];

    return this.mapRow(row, criterionRows);
  }

  async listEvidenceByRun(runId: string): Promise<Evidence[]> {
    const rows = this.db.query(
      `SELECT e.*, lc.status AS lifecycle_status
       FROM evidence e
       LEFT JOIN evidence_lifecycle lc ON lc.evidence_id = e.id
       WHERE e.run_id = ?
       ORDER BY e.created_at ASC`,
    ).all(runId) as (EvidenceRow & { lifecycle_status: string | null })[];

    const result: Evidence[] = [];
    for (const row of rows) {
      const criterionRows = this.db.query(
        `SELECT rce.run_acceptance_criterion_id, rac.criterion_id
         FROM run_criterion_evidence rce
         LEFT JOIN run_acceptance_criteria rac ON rac.id = rce.run_acceptance_criterion_id
         WHERE rce.evidence_id = ?`,
      ).all(row.id) as CriterionLinkRow[];
      result.push(this.mapRow(row, criterionRows));
    }
    return result;
  }

  async listEvidenceByCriterion(criterionId: string): Promise<Evidence[]> {
    const rows = this.db.query(
      `SELECT e.*, lc.status AS lifecycle_status
       FROM evidence e
       JOIN run_criterion_evidence rce ON rce.evidence_id = e.id
       JOIN run_acceptance_criteria rac ON rac.id = rce.run_acceptance_criterion_id
       LEFT JOIN evidence_lifecycle lc ON lc.evidence_id = e.id
       WHERE rac.criterion_id = ?
       ORDER BY e.created_at ASC`,
    ).all(criterionId) as (EvidenceRow & { lifecycle_status: string | null })[];

    const result: Evidence[] = [];
    for (const row of rows) {
      result.push(this.mapRow(row, []));
    }
    return result;
  }

  async listEvidenceBySha(sha: string): Promise<Evidence[]> {
    const rows = this.db.query(
      `SELECT e.*, lc.status AS lifecycle_status
       FROM evidence e
       LEFT JOIN evidence_lifecycle lc ON lc.evidence_id = e.id
       WHERE e.sha = ?
       ORDER BY e.created_at ASC`,
    ).all(sha) as (EvidenceRow & { lifecycle_status: string | null })[];

    const result: Evidence[] = [];
    for (const row of rows) {
      const criterionRows = this.db.query(
        `SELECT rce.run_acceptance_criterion_id, rac.criterion_id
         FROM run_criterion_evidence rce
         LEFT JOIN run_acceptance_criteria rac ON rac.id = rce.run_acceptance_criterion_id
         WHERE rce.evidence_id = ?`,
      ).all(row.id) as CriterionLinkRow[];
      result.push(this.mapRow(row, criterionRows));
    }
    return result;
  }

  async saveLink(link: EvidenceLink): Promise<void> {
    this.tx.write(() => {
      // Link by evidence run + criterion id, resolved through the run-scoped row.
      const evidenceRow = this.db.query(
        "SELECT run_id FROM evidence WHERE id = ?",
      ).get(link.evidenceId) as { run_id: string } | undefined;
      if (!evidenceRow) {
        throw new Error(`Cannot link missing evidence ${link.evidenceId}`);
      }
      const criterionId = link.criterionId;
      if (!criterionId) {
        throw new Error(`Evidence link ${link.evidenceId} has no criterion id`);
      }
      const rac = this.db.query(
        "SELECT id FROM run_acceptance_criteria WHERE run_id = ? AND criterion_id = ?",
      ).get(evidenceRow.run_id, criterionId) as { id: string } | undefined;
      if (!rac) {
        throw new Error(`Criterion ${criterionId} is not bound to run ${evidenceRow.run_id}`);
      }
      this.db.query(
        `INSERT OR IGNORE INTO run_criterion_evidence (run_acceptance_criterion_id, evidence_id, relationship, linked_at)
         VALUES (?, ?, 'verifies', ?)`,
      ).run(rac.id, link.evidenceId, link.createdAt.toISOString());
    });
  }

  async listLinksByEvidence(evidenceId: string): Promise<EvidenceLink[]> {
    const rows = this.db.query(
      `SELECT rce.run_acceptance_criterion_id, rac.criterion_id, rce.linked_at
       FROM run_criterion_evidence rce
       LEFT JOIN run_acceptance_criteria rac ON rac.id = rce.run_acceptance_criterion_id
       WHERE rce.evidence_id = ?`,
    ).all(evidenceId) as (CriterionLinkRow & { linked_at: string })[];

    return rows
      .filter((r) => r.criterion_id !== null)
      .map((r) => new EvidenceLink({
        evidenceId,
        criterionId: r.criterion_id!,
        createdAt: new Date(r.linked_at),
      }));
  }

  private mapRow(
    row: EvidenceRow & { lifecycle_status: string | null },
    criterionRows: CriterionLinkRow[],
  ): Evidence {
    const criterionIds = criterionRows
      .map((r) => r.criterion_id)
      .filter((c): c is string => c !== null);
    const status = row.lifecycle_status === "archived" ? "archived" : "current";

    return new Evidence({
      id: row.id,
      content: row.description ?? row.title,
      contentType: row.evidence_type,
      sha: row.sha,
      runId: row.run_id,
      criterionIds,
      status,
      createdAt: new Date(row.created_at),
    });
  }
}
