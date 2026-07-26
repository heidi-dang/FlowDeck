import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import { runDoctorChecks } from "../services/doctor"

export const doctorTool: ToolDefinition = tool({
  description:
    "Run FlowDeck diagnostic health checks on runtime environment, configuration, contracts, skills, and FDX availability.",
  args: {
    directory: tool.schema.string().optional(),
  },
  async execute(args, context) {
    const dir = args.directory ?? context?.directory ?? process.cwd()
    const report = runDoctorChecks(dir)

    const lines: string[] = [
      `# FlowDeck Doctor Health Report`,
      `**Timestamp**: ${report.timestamp}`,
      `**Directory**: ${report.directory}`,
      `**Summary**: ${report.passed} Passed | ${report.warned} Warned | ${report.failed} Failed`,
      ``,
      `## Diagnostic Checks`,
    ]

    for (const c of report.checks) {
      const badge = c.status === "pass" ? "[OK]" : c.status === "warn" ? "[WARN]" : "[FAIL]"
      lines.push(`- **${badge} ${c.name}** (\`${c.id}\`): ${c.message}`)
      if (c.remediation) {
        lines.push(`  *Remediation*: ${c.remediation}`)
      }
    }

    return lines.join("\n")
  },
})
