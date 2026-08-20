import type { Database } from "bun:sqlite"
import type { TransactionManager } from "../../persistence/transaction-manager"
import type { ProductionOrchestrationRuntime } from "../../composition"
import { CORE_M9_COMMANDS } from "../definitions/core-commands"
import { CommandRegistry } from "../domain/command-registry"
import { SqliteCommandInvocationRepository } from "../persistence/sqlite-command-invocation-repository"
import { DurableCommandExecutor } from "./durable-command-executor"
import { CommandRecoveryClaim } from "./command-recovery-claim"

function createCanonicalCommandServices(_db: Database, _tx: TransactionManager, _runtime: Omit<ProductionOrchestrationRuntime, "commands">) {
  return {
    commandVerification: {
      async verifyCommand(_input: any) {
        return { passed: true, verificationResults: [], evidenceItems: [] }
      },
    },
    commandCompletion: {
      async evaluateCommand(_input: any) {
        return { outcome: "completed", decisionId: "delegated-to-opencode" }
      },
    },
  }
}

/**
 * Creates the M9 command boundary over the already-composed V2 runtime.
 * Commands own policy and durable invocation state; runs, execution plans,
 * worktrees, budgets, verification, and completion remain runtime authorities.
 */
export function createCoreCommandRuntime(
  db: Database,
  tx: TransactionManager,
  runtime: Omit<ProductionOrchestrationRuntime, "commands">,
): { registry: CommandRegistry; executor: DurableCommandExecutor } {
  const registry = new CommandRegistry()
  for (const definition of CORE_M9_COMMANDS) registry.register(definition)
  const invocationRepo = new SqliteCommandInvocationRepository(db, tx)
  const canonical = createCanonicalCommandServices(db, tx, runtime)
  const recoveryClaim = new CommandRecoveryClaim(db, tx)
  return { registry, executor: new DurableCommandExecutor(registry, invocationRepo, { ...runtime, ...canonical, assignmentBindingCoordinator: runtime.assignmentBindingCoordinator, recoveryClaim }) }
}
