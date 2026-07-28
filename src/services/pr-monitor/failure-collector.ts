/**
 * Collects failure information from a CI job into a normalized CiFailureReport.
 */

import type { CiFailureReport, FailureClassification } from "./types"
import type { GitHubClient, JobResponse, PrResponse } from "./github-client"

export class FailureCollector {
  constructor(private client: GitHubClient) {}

  async collect(
    repo: string,
    prNumber: number,
    headSha: string,
    job: JobResponse,
    pr: PrResponse,
  ): Promise<CiFailureReport> {
    const jobName = job.name
    const conclusion = job.conclusion ?? "failure"
    const failedStep = job.steps?.find(s => s.conclusion === "failure")
    const workflowRunId = job.run_id
    const runAttempt = job.run_attempt

    // Collect logs
    let logs = ""
    try {
      logs = await this.client.downloadJobLogs(job.id)
    } catch { /* log unavailable */ }

    // Parse error excerpt
    const errorExcerpt = extractErrorExcerpt(logs)
    const exitCode = extractExitCode(logs)

    // Get changed files
    let changedFiles: string[] = []
    try {
      changedFiles = await this.client.listChangedFiles(repo, prNumber)
    } catch { /* files unavailable */ }

    const classification = this.classify(jobName, failedStep?.name ?? "", errorExcerpt)

    return {
      schema_version: 1,
      repository: repo,
      pr_number: prNumber,
      head_sha: headSha,
      workflow_run_id: workflowRunId,
      run_attempt: runAttempt,
      job_id: job.id,
      job_name: jobName,
      runner_os: job.labels?.find(l => l.startsWith("ubuntu") || l.startsWith("macos") || l.startsWith("windows")),
      failed_step: failedStep?.name,
      conclusion,
      exit_code: exitCode,
      error_excerpt: errorExcerpt,
      changed_files: changedFiles,
      suspected_files: [],
      classification,
    }
  }

  private classify(jobName: string, stepName: string, log: string): FailureClassification {
    const l = (jobName + " " + stepName + " " + log).toLowerCase()

    if (l.includes("lint") || l.includes("oxlint") || l.includes("eslint")) return "lint"
    if (l.includes("typecheck") || l.includes("tsc") || l.includes("typescript")) return "typecheck"
    if (l.includes("build") && (l.includes("error") || l.includes("failed"))) return "build"
    if (l.includes("test") && (l.includes("fail") || l.includes("assert"))) return "test"
    if (l.includes("pack") || l.includes("tarball") || l.includes("npm pack")) return "packaging"
    if (l.includes("migrat")) return "migration"
    if (l.includes("rust") || l.includes("cargo") || l.includes("clippy")) return "platform"
    if (l.includes("timeout") || l.includes("network") || l.includes("time out")) return "infrastructure"
    if (l.includes("flaky") || /expect\(.*\)\.to/.test(l)) return "flaky"
    if (l.includes("code") || l.includes("source")) return "code"

    return "unknown"
  }
}

export function extractErrorExcerpt(log: string): string {
  const lines = log.split("\n")
  const errorLines: string[] = []
  for (let i = 0; i < lines.length; i++) {
    if (/error|Error|FAILED|failure|panicked|exit code/.test(lines[i])) {
      const start = Math.max(0, i - 2)
      const end = Math.min(lines.length, i + 8)
      for (let j = start; j < end; j++) {
        errorLines.push(lines[j])
      }
      errorLines.push("---")
    }
  }
  return errorLines.slice(0, 80).join("\n").slice(0, 4000)
}

export function extractExitCode(log: string): number | undefined {
  const m = log.match(/exit code (\d+)/i) ?? log.match(/Process completed with exit code (\d+)/)
  return m ? parseInt(m[1], 10) : undefined
}
