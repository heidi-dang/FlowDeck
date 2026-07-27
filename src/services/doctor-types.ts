export interface DiagnosticCheck {
  id: string
  name: string
  status: "pass" | "warn" | "fail"
  message: string
  remediation?: string
}

export interface DoctorReport {
  timestamp: string
  directory: string
  passed: number
  warned: number
  failed: number
  checks: DiagnosticCheck[]
}
