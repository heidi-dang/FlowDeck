import type { CheckResult } from "../types";
import { detectBrowserCapability } from "../../browser/capability";

export async function runBrowserChecks(_directory: string): Promise<CheckResult[]> {
  const checks: CheckResult[] = [];
  const status = await detectBrowserCapability({ checkTimeoutMs: 2000 });

  if (status.available) {
    checks.push({
      id: "browser.capability",
      title: "Browser Runtime Subsystem",
      category: "environment",
      severity: "low",
      status: "pass",
      detected: `${status.provider} v${status.version} (${status.binaryPath})`,
      expected: "Browser runtime available for autonomous debugging",
      recommendation: "OK — autonomous browser debugging is active and available",
      autoFixAvailable: false,
    });
  } else {
    checks.push({
      id: "browser.capability",
      title: "Browser Runtime Subsystem",
      category: "environment",
      severity: "low",
      status: "warning",
      detected: `${status.reason}`,
      expected: "Browser runtime available for autonomous debugging",
      recommendation: status.remediation || "Install agent-browser via `npm install -g agent-browser`",
      autoFixAvailable: false,
    });
  }

  return checks;
}
