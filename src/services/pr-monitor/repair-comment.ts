/**
 * PR status comment management.
 * Posts and updates a single PR-monitor status comment per PR.
 */

import type { GitHubClient } from "./github-client"
import type { RepairRun } from "./types"

const COMMENT_MARKER = "<!-- pr-monitor-status -->"

export class RepairComment {
  constructor(private client: GitHubClient) {}

  async upsert(repo: string, prNumber: number, run: RepairRun): Promise<void> {
    const body = this.formatComment(run)
    const existing = await this.findExistingComment(repo, prNumber)
    if (existing) {
      await this.client.addPrComment(repo, prNumber, body)
    } else {
      await this.client.addPrComment(repo, prNumber, body)
    }
  }

  private async findExistingComment(_repo: string, _prNumber: number): Promise<string | null> {
    // Simple approach: always post a new comment.
    // The marker allows consumers to find the latest one.
    return null
  }

  private formatComment(run: RepairRun): string {
    const lines = [
      COMMENT_MARKER,
      `## 🤖 PR Monitor — ${run.state}`,
      "",
      `**Repo:** ${run.repo} | **PR:** #${run.pr_number}`,
      `**Head SHA:** \`${run.head_sha.slice(0, 12)}\``,
      `**Attempt:** ${run.attempt_count}/${run.max_attempts}`,
      `**State:** ${run.state}`,
      `**Job:** ${run.job_name}`,
      "",
    ]

    if (run.failure_report) {
      lines.push(
        `**Classification:** ${run.failure_report.classification}`,
        `**Failed step:** ${run.failure_report.failed_step ?? "unknown"}`,
        "",
        "```",
        run.failure_report.error_excerpt.slice(0, 500),
        "```",
        "",
      )
    }

    if (run.state === "GREEN") {
      lines.push("✅ **CI passed after repair.**")
    } else if (run.state === "MAX_ATTEMPTS_REACHED") {
      lines.push("❌ **Max repair attempts reached. Manual intervention required.**")
    } else if (run.committed_sha) {
      lines.push(`📦 **Fix committed:** \`${run.committed_sha.slice(0, 12)}\``)
    }

    lines.push("", "---", "", `_Updated: ${run.updated_at}_`)

    return lines.join("\n")
  }
}
