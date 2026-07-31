import { execFileSync } from "child_process";

export interface RequirementResult {
  requirement: string;
  passed: boolean;
  output: string;
  error?: string;
}

function parseCommand(cmd: string): string[] {
  const regex = /[^\s"']+|"([^"]*)"|'([^']*)'/g;
  const args: string[] = [];
  let match;
  while ((match = regex.exec(cmd)) !== null) {
    args.push(
      match[1] !== undefined
        ? match[1]
        : match[2] !== undefined
          ? match[2]
          : match[0],
    );
  }
  return args;
}

export function runRequirements(
  requirements: string[],
  cwd: string,
): RequirementResult[] {
  return requirements.map((req) => {
    try {
      const args = parseCommand(req);
      if (args.length === 0) {
        return {
          requirement: req,
          passed: false,
          output: "",
          error: "Empty requirement",
        };
      }
      const output = execFileSync(args[0], args.slice(1), {
        cwd,
        encoding: "utf-8",
        timeout: 30_000,
      });
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
