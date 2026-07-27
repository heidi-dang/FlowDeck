import { execSync } from "child_process";

export interface RequirementResult {
  requirement: string;
  passed: boolean;
  output: string;
  error?: string;
}

export function runRequirements(
  requirements: string[],
  cwd: string,
): RequirementResult[] {
  return requirements.map((req) => {
    try {
      const output = execSync(req, { cwd, encoding: "utf-8", timeout: 30_000 });
      return {
        requirement: req,
        passed: true,
        output: output.trim(),
      };
    } catch (err) {
      const e = err as any;
      return {
        requirement: req,
        passed: false,
        output: e.stdout ?? "",
        error: e.stderr ?? (err instanceof Error ? err.message : String(err)),
      };
    }
  });
}
