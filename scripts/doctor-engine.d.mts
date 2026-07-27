export interface DoctorCheck {
  id: string;
  name: string;
  status: "pass" | "warn" | "fail";
  message: string;
  remediation?: string;
}

export interface DoctorReport {
  passed: number;
  warned: number;
  failed: number;
  checks: DoctorCheck[];
}

export function runDoctorChecks(directory: string): Promise<DoctorReport>;
export function testFdxVersionCompatibility(
  directory: string,
  pkgRaw: string | null,
  customFdxOutput?: string | null
): { status: "pass" | "warn" | "fail"; message: string; remediation?: string };

