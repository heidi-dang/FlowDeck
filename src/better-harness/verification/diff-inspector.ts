export interface DiffEntry {
  filePath: string;
  status: "added" | "modified" | "deleted";
}

export interface DiffInspectionResult {
  changedFiles: DiffEntry[];
  violations: string[];
  allowed: boolean;
}

export function inspectDiff(
  changedFiles: DiffEntry[],
  allowedPaths: string[],
): DiffInspectionResult {
  const violations: string[] = [];

  for (const file of changedFiles) {
    const isAllowed = allowedPaths.some((p) => file.filePath.startsWith(p) || file.filePath === p);
    if (!isAllowed) {
      violations.push(`${file.filePath} is not in allowed paths: ${allowedPaths.join(", ")}`);
    }
  }

  return {
    changedFiles,
    violations,
    allowed: violations.length === 0,
  };
}
