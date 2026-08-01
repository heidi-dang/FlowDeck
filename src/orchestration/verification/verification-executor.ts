/**
 * Verification Executor
 *
 * Executes verification plans by running checks in order, collecting
 * results with timing, handling timeouts, and emitting events.
 */

import { spawn } from "child_process"
import { existsSync, statSync } from "fs"
import { readFileSync } from "fs"
import { readFile } from "fs/promises"
import { resolve } from "path"
import type { VerificationPlan, VerificationCheck, Precondition } from "./verification-plan"
import type { CheckResult, VerificationResult, VerificationStatus } from "./verification-result"
import type { Clock } from "../common/ports/clock"
import type { DomainEventAppender } from "../events/ports/event-publisher"

const MAX_OUTPUT_SIZE = 1024 * 1024 // 1MB max output

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
    const status = this.computeStatus(checkResults, sortedChecks)
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
      const resolvedPath = precondition.path ? resolve(cwd, precondition.path) : undefined

      switch (precondition.type) {
        case "file_exists":
          met = existsSync(resolvedPath!)
          break
        case "dir_exists":
          met = existsSync(resolvedPath!) && statSync(resolvedPath!).isDirectory()
          break
        case "sha_match":
          if (resolvedPath) {
            const expectedSha = precondition.expectedSha ?? precondition.expected
            if (expectedSha) {
              try {
                const content = readFileSync(resolvedPath, "utf-8")
                met = content.trim() === expectedSha.trim()
              } catch {
                met = false
              }
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
        const resolvedPath = check.command ? resolve(cwd, check.command) : undefined
        const exists = resolvedPath ? existsSync(resolvedPath) : false
        return {
          checkId: check.id,
          status: exists ? "passed" : "failed",
          output: exists ? `File exists: ${resolvedPath}` : `File not found: ${resolvedPath}`,
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
        const resolvedPath = resolve(cwd, check.command)
        try {
          const content = await readFile(resolvedPath, "utf-8")
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
        } catch {
          return {
            checkId: check.id,
            status: "failed",
            error: `Failed to read file: ${resolvedPath}`,
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
      let stdout = ""
      let stderr = ""
      let timedOut = false
      let killed = false

      const child = spawn(check.command!, {
        cwd,
        shell: true,
        signal: this.abortController?.signal,
      })

      const timer = setTimeout(() => {
        timedOut = true
        killed = true
        child.kill("SIGKILL")
      }, timeout)

      child.stdout?.on("data", (data: Buffer) => {
        if (stdout.length < MAX_OUTPUT_SIZE) {
          stdout += data.toString()
        }
      })

      child.stderr?.on("data", (data: Buffer) => {
        if (stderr.length < MAX_OUTPUT_SIZE) {
          stderr += data.toString()
        }
      })

      child.on("error", (error: Error) => {
        clearTimeout(timer)
        let errorMessage = error.message

        if (timedOut) {
          errorMessage = `Command timed out after ${timeout}ms`
        } else if (killed) {
          errorMessage = "Command was killed"
        } else if (this.abortController?.signal.aborted) {
          errorMessage = "Command was cancelled"
        }

        resolve({
          checkId: check.id,
          status: "failed",
          output: stdout.length > MAX_OUTPUT_SIZE ? stdout.slice(0, MAX_OUTPUT_SIZE) + "... (truncated)" : stdout,
          error: errorMessage,
          duration: this.clock.now().getTime() - checkStart.getTime(),
          timestamp: checkStart,
        })
      })

      child.on("close", (code: number | null, signal: string | null) => {
        clearTimeout(timer)

        if (timedOut) {
          resolve({
            checkId: check.id,
            status: "failed",
            output: stdout.length > MAX_OUTPUT_SIZE ? stdout.slice(0, MAX_OUTPUT_SIZE) + "... (truncated)" : stdout,
            error: `Command timed out after ${timeout}ms`,
            duration: this.clock.now().getTime() - checkStart.getTime(),
            timestamp: checkStart,
          })
          return
        }

        if (killed) {
          resolve({
            checkId: check.id,
            status: "failed",
            output: stdout.length > MAX_OUTPUT_SIZE ? stdout.slice(0, MAX_OUTPUT_SIZE) + "... (truncated)" : stdout,
            error: `Command was killed with signal ${signal}`,
            duration: this.clock.now().getTime() - checkStart.getTime(),
            timestamp: checkStart,
          })
          return
        }

        if (this.abortController?.signal.aborted) {
          resolve({
            checkId: check.id,
            status: "failed",
            output: stdout.length > MAX_OUTPUT_SIZE ? stdout.slice(0, MAX_OUTPUT_SIZE) + "... (truncated)" : stdout,
            error: "Command was cancelled",
            duration: this.clock.now().getTime() - checkStart.getTime(),
            timestamp: checkStart,
          })
          return
        }

        const exitCode = code ?? 0
        const expectedCode = check.expectedExitCode ?? 0
        const passed = exitCode === expectedCode

        resolve({
          checkId: check.id,
          status: passed ? "passed" : "failed",
          output: stdout.length > MAX_OUTPUT_SIZE ? stdout.slice(0, MAX_OUTPUT_SIZE) + "... (truncated)" : stdout,
          error: passed
            ? undefined
            : stderr
              ? `${stderr}\nExit code ${exitCode}, expected ${expectedCode}`
              : `Exit code ${exitCode}, expected ${expectedCode}`,
          duration: this.clock.now().getTime() - checkStart.getTime(),
          timestamp: checkStart,
        })
      })
    })
  }

  private computeStatus(checkResults: CheckResult[], checks: VerificationCheck[]): VerificationStatus {
    if (checkResults.length === 0) {
      return "failed"
    }

    // Check if any critical check failed
    const criticalFailed = checkResults.some((result) => {
      if (result.status === "failed") {
        const check = checks.find((c) => c.id === result.checkId)
        return check?.critical === true
      }
      return false
    })

    if (criticalFailed) {
      return "failed"
    }

    // Check if any check failed (non-critical)
    const anyFailed = checkResults.some((r) => r.status === "failed")

    // All checks passed
    const allPassed = checkResults.every((r) => r.status === "passed")
    if (allPassed) {
      return "passed"
    }

    // Some failed but none critical - partial/warnings
    if (anyFailed) {
      return "partial"
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
