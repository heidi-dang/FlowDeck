/**
 * SQLite adapter for Dev 2's ContractRepository port.
 * Implements: saveFamily, getFamily, listFamilies, deleteFamily
 */
import type Database from "better-sqlite3"
import type { TransactionManager } from "../transaction-manager"
import type { ContractRepository } from "../../contracts/ports/contract-repository"
import type { ContractFamily } from "../../contracts/domain/contract"

export class SqliteContractRepositoryAdapter implements ContractRepository {
  constructor(private db: Database.Database, private tx: TransactionManager) {}

  async saveFamily(family: ContractFamily): Promise<void> {
    return this.tx.write(() => {
      this.db.prepare(`INSERT INTO contract_families (family_id, name, description, created_by, created_at)
        VALUES (?, ?, ?, ?, datetime('now'))
        ON CONFLICT(family_id) DO UPDATE SET name=excluded.name, description=excluded.description`)
        .run(family.id, family.name, family.description ?? null, family.createdBy ?? 'system')
    })
  }

  async getFamily(familyId: string): Promise<ContractFamily | undefined> {
    const r = this.db.prepare("SELECT * FROM contract_families WHERE family_id=?").get(familyId) as Record<string, unknown> | undefined
    if (!r) return undefined
    return new ContractFamily({ id: r.family_id as string, name: r.name as string, description: r.description as string | undefined, createdBy: r.created_by as string, createdAt: new Date(r.created_at as string) })
  }

  async listFamilies(): Promise<ContractFamily[]> {
    return (this.db.prepare("SELECT * FROM contract_families ORDER BY name").all() as Record<string, unknown>[]).map(r => new ContractFamily({ id: r.family_id as string, name: r.name as string, description: r.description as string | undefined, createdBy: r.created_by as string, createdAt: new Date(r.created_at as string) }))
  }

  async deleteFamily(familyId: string): Promise<void> {
    this.tx.write(() => { this.db.prepare("DELETE FROM contract_families WHERE family_id=?").run(familyId) })
  }
}
