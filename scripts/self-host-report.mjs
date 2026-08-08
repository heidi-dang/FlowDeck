import { writeFileSync } from "fs";

// Self-host report generator
// Usage: npm run report:self-host
// Output: flowdeck-self-host-report.json, flowdeck-self-host-report.md

const JSON_OUTPUT = "flowdeck-self-host-report.json";
const MD_OUTPUT = "flowdeck-self-host-report.md";

async function main() {
  // Import from source TypeScript files via bun
  const telemetry = await import("../src/orchestration/telemetry/index.ts");

  const { createCollector } = telemetry;
  const { renderReportToJson, renderReportToMarkdown, SCHEMA_VERSION } = telemetry;

  // Gather environment and git context
  const taskId = process.env.FLOWDECK_TASK_ID;
  const developer = process.env.FLOWDECK_DEVELOPER || process.env.USER || "unknown";
  const branch = process.env.BASE_SHA
    ? undefined  // CI context - sha-based identification
    : await getGitBranch().catch(() => undefined);
  const baseSha = process.env.BASE_SHA;
  const startingSha = await getGitStartingSha().catch(() => undefined);
  const finalLocalSha = await getGitRevParse("HEAD").catch(() => undefined);
  const pr = process.env.PR || process.env.GITHUB_PR_NUMBER;
  const campaignId = process.env.FLOWDECK_CAMPAIGN_ID;

  // Build report
  const report = createCollector({
    taskId,
    developer,
    branch,
    baseSha,
    startingSha,
    campaignId,
  })
    .setIdentity({
      developer,
      taskId,
      branch,
      baseSha,
      startingSha,
      finalLocalSha,
      pr,
      campaignId,
    })
    .setOrchestration({
      strategy: process.env.FLOWDECK_STRATEGY,
      stageOrder: process.env.FLOWDECK_STAGES?.split(","),
    })
    .setPerformance({
      wallTimeMs: Number(process.env.FLOWDECK_WALL_TIME_MS) || undefined,
      activeExecutionTimeMs: Number(process.env.FLOWDECK_ACTIVE_TIME_MS) || undefined,
      timeToFirstUsefulActionMs: Number(process.env.FLOWDECK_TIME_TO_FIRST_ACTION_MS) || undefined,
    })
    .setStability({
      crashes: Number(process.env.FLOWDECK_CRASHES) || 0,
      unhandledErrors: Number(process.env.FLOWDECK_UNHANDLED_ERRORS) || 0,
      timeouts: Number(process.env.FLOWDECK_TIMEOUTS) || 0,
    })
    .build();

  // Render to JSON
  const jsonContent = renderReportToJson(report);
  writeFileSync(JSON_OUTPUT, jsonContent, "utf-8");
  console.log(`Written: ${JSON_OUTPUT}`);

  // Render to Markdown (from validated JSON)
  const mdContent = renderReportToMarkdown(report);
  writeFileSync(MD_OUTPUT, mdContent, "utf-8");
  console.log(`Written: ${MD_OUTPUT}`);

  console.log(`\nSchema version: ${SCHEMA_VERSION}`);
  console.log("Self-host report generation complete.");
}

async function getGitBranch() {
  const { execSync } = await import("child_process");
  return execSync("git branch --show-current", { encoding: "utf-8" }).trim();
}

async function getGitStartingSha() {
  const { execSync } = await import("child_process");
  return execSync("git log --oneline -2 | tail -1 | awk '{print $1}'", { encoding: "utf-8" }).trim();
}

async function getGitRevParse(ref) {
  const { execSync } = await import("child_process");
  return execSync(`git rev-parse ${ref}`, { encoding: "utf-8" }).trim();
}

main().catch((err) => {
  console.error("Failed to generate self-host report:", err);
  process.exit(1);
});
