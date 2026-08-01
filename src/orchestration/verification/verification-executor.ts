/**
 * Verification Executor
 *
 * Executes verification plans by running checks in order, collecting
 * results with timing, handling timeouts, and emitting events.
 */

import { exec } from "child_process"
import { readFileSync, existsSync, statSync } from "fs"
import { readFile } from "fs/promises"
import type { VerificationPlan, VerificationCheck, Precondition } from "./verification-plan"
import type { CheckResult, VerificationResult, VerificationStatus } from "./verification-result"
import type { Clock } from "../common/ports/clock"
import type { DomainEventAppender } from "../events/ports/event-publisher"

export type ExecutorEvent =
  | { type: "check_started"; checkId: string; timestamp: Date }
  | { type: "check_completed"; result: CheckResult; timestamp: Date }
  | { type: "precondition_failed"; precondition: Precondition; timestamp: Date }
  | { type: "plan_started"; planId: string; timestamp: Date }
  | { type: "plan_completed"; result: VerificationResult; timestamp: Date }

type EventHandler = (event: ExecutorEvent) => void

export class VerificationExecutor {
  private eventHandlers: EventHandler[] = []
  private abortController: AbortController | null = null

  constructor(
    private readonly clock: Clock,
    private readonly eventAppender?: DomainEventAppender,
  ) {}

  onEvent(handler: EventHandler): void {
    this.eventHandlers.push(handler)
  }

  removeEventHandler(handler: EventHandler): void {
    this.eventHandlers = this.eventHandlers.filter((h) => h !== handler)
  }

  async execute(plan: VerificationPlan, cwd: string = process.cwd()): Promise<VerificationResult> {
    this.abortController = new AbortController()
    const startTime = this.clock.now()

    this.emit({ type: "plan_started", planId: plan.id, timestamp: startTime })

    const checkResults: CheckResult[] = []

    const preconditionsMet = await this.checkPreconditions(plan.preconditions, cwd)
    if (!preconditionsMet) {
      const endTime = this.clock.now()
      const result: VerificationResult = {
        planId: plan.id,
        status: "failed",
        checkResults: [],
        startTime,
        endTime,
        duration: endTime.getTime() - startTime.getTime(),
      }
      this.emit({ type: "plan_completed", result, timestamp: endTime })
      return result
    }

    const sortedChecks = [...plan.checks].sort((a, b) => a.order - b.order)

    for (const check of sortedChecks) {
      if (this.abortController.signal.aborted) {
        break
      }

      const checkResult = await this.executeCheck(check, cwd)
      checkResults.push(checkResult)
      this.emit({ type: "check_completed", result: checkResult, timestamp: this.clock.now() })

      if (check.critical && checkResult.status === "failed") {
        break
      }
    }

    const endTime = this.clock.now()
    const status = this.computeStatus(checkResults)
    const result: VerificationResult = {
      planId: plan.id,
      status,
      checkResults,
      startTime,
      endTime,
      duration: endTime.getTime() - startTime.getTime(),
    }

    this.emit({ type: "plan_completed", result, timestamp: endTime })
    return result
  }

  abort(): void {
    this.abortController?.abort()
  }

  private async checkPreconditions(preconditions: Precondition[], cwd: string): Promise<boolean> {
    for (const precondition of preconditions) {
      let met = false

      switch (precondition.type) {
        case "file_exists":
          met = existsSync(precondition.path!)
          break
        case "dir_exists":
          met = existsSync(precondition.path!) && statSync(precondition.path!).isDirectory()
          break
        case "sha_match":
          if (precondition.path && precondition.expected) {
            try {
              const content = readFileSync(precondition.path, "utf-8")
              met = content.trim() === precondition.expected.trim()
            } catch {
              met = false
            }
          }
          break
        case "env_set":
          met = process.env[precondition.envKey!] !== undefined
          break
      }

      if (!met) {
        this.emit({
          type: "precondition_failed",
          precondition,
          timestamp: this.clock.now(),
        })
        return false
      }
    }
    return true
  }

  private async executeCheck(check: VerificationCheck, cwd: string): Promise<CheckResult> {
    const checkStart = this.clock.now()
    this.emit({ type: "check_started", checkId: check.id, timestamp: checkStart })

    switch (check.type) {
      case "file": {
        const exists = existsSync(check.command!)
        return {
          checkId: check.id,
          status: exists ? "passed" : "failed",
          output: exists ? `File exists: ${check.command}` : `File not found: ${check.command}`,
          duration: this.clock.now().getTime() - checkStart.getTime(),
          timestamp: checkStart,
        }
      }

      case "sha": {
        if (!check.command) {
          return {
            checkId: check.id,
            status: "failed",
            error: "SHA check requires a file path",
            duration: this.clock.now().getTime() - checkStart.getTime(),
            timestamp: checkStart,
          }
        }
        try {
          const content = await readFile(check.command, "utf-8")
          const actualSha = content.trim()
          const expectedSha = check.expectedExitCode?.toString()
          const passed = actualSha === expectedSha
          return {
            checkId: check.id,
            status: passed ? "passed" : "failed",
            output: `SHA: ${actualSha}`,
            error: passed ? undefined : `Expected ${expectedSha}, got ${actualSha}`,
            duration: this.clock.now().getTime() - checkStart.getTime(),
            timestamp: checkStart,
          }
        } catch (err) {
          return {
            checkId: check.id,
            status: "failed",
            error: `Failed to read file: ${check.command}`,
            duration: this.clock.now().getTime() - checkStart.getTime(),
            timestamp: checkStart,
          }
        }
      }

      case "command":
      case "test":
      case "build":
      case "lint":
      case "typecheck": {
        if (!check.command) {
          return {
            checkId: check.id,
            status: "failed",
            error: `${check.type} check requires a command`,
            duration: this.clock.now().getTime() - checkStart.getTime(),
            timestamp: checkStart,
          }
        }
        return this.runCommand(check, cwd, checkStart)
      }

      default:
        return {
          checkId: check.id,
          status: "skipped",
          error: `Unknown check type`,
          duration: this.clock.now().getTime() - checkStart.getTime(),
          timestamp: checkStart,
        }
    }
  }

  private runCommand(check: VerificationCheck, cwd: string, checkStart: Date): Promise<CheckResult> {
    return new Promise((resolve) => {
      const timeout = check.timeout ?? 60000

      const timer = setTimeout(() => {
        const result: CheckResult = {
          checkId: check.id,
          status: "failed",
          error: `Command timed out after ${timeout}ms`,
          duration: this.clock.now().getTime() - checkStart.getTime(),
          timestamp: checkStart,
        }
        resolve(result)
      }, timeout)

      exec(
        check.command!,
        { cwd, signal: this.abortController?.signal },
        (error, stdout, stderr) => {
          clearTimeout(timer)
          const exitCode = error instanceof Error ? (error as NodeJS.ErrnoException).code : 0
          const expectedCode = check.expectedExitCode ?? 0
          const passed = exitCode === expectedCode

          const result: CheckResult = {
            checkId: check.id,
            status: passed ? "passed" : "failed",
            output: stdout || undefined,
            error: passed ? undefined : stderr || `Exit code ${exitCode}, expected ${expectedCode}`,
            duration: this.clock.now().getTime() - checkStart.getTime(),
            timestamp: checkStart,
          }
          resolve(result)
        },
      )
    })
  }

  private computeStatus(checkResults: CheckResult[]): VerificationStatus {
    if (checkResults.length === 0) {
      return "failed"
    }

    const criticalFailed = checkResults.some(
      (r) => r.status === "failed" && checkResults.find((c) => c.checkId === r.checkId)?.status === "failed",
    )

    if (criticalFailed) {
      return "failed"
    }

    const allPassed = checkResults.every((r) => r.status === "passed")
    if (allPassed) {
      return "passed"
    }

    return "partial"
  }

  private emit(event: ExecutorEvent): void {
    for (const handler of this.eventHandlers) {
      try {
        handler(event)
      } catch {
        // handlers must not throw
      }
    }
  }
}
