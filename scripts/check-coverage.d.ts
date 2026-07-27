export function getBunExecutable(): string
export function validateThreshold(thresholdRaw?: string | number): number
export function isEligibleSourceFile(filePath?: string): boolean
export function parseLcov(lcovContent?: string): {
  coveredLines: number
  totalLines: number
  rawPercentage: number
  displayPercentage: number
  fileCount: number
}
export function runCoverageCheck(thresholdRaw?: string | number): {
  status: number
  rawPercentage: number
  displayPercentage: number
  coveredLines: number
  totalLines: number
  fileCount: number
}
