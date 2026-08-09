import { z } from "zod"

export const PERFORMANCE_POLICY_VERSION = "1.0.0"
export const performanceObservationSchema = z.object({
  observationId: z.string().min(1), runId: z.string().min(1), workstreamId: z.string().min(1), agentId: z.string().min(1), capability: z.string().min(1), taskClass: z.string().min(1), strategy: z.string().min(1), complexityBand: z.enum(["low", "medium", "high"]), riskBand: z.enum(["low", "medium", "high"]), success: z.boolean(), verificationPassed: z.boolean(), integrationPassed: z.boolean(), tokenReserved: z.number().int().nonnegative(), tokenUsed: z.number().int().nonnegative(), durationMs: z.number().int().nonnegative(), retryCount: z.number().int().nonnegative(), reviewFindings: z.number().int().nonnegative(), regressionCount: z.number().int().nonnegative(), terminationReason: z.string().min(1), usefulnessSignals: z.array(z.string().min(1)), policyVersion: z.string().min(1), createdAt: z.string().datetime(),
}).strict()
export type PerformanceObservation = z.infer<typeof performanceObservationSchema>
export interface PerformanceProfile { agentId: string; capability: string; sampleCount: number; eligible: boolean; status: "eligible" | "insufficient_data"; components: { success: number; verification: number; efficiency: number; latency: number; retries: number; quality: number; regression: number; integration: number }; score: number; policyVersion: string }

export function scorePerformance(observations: readonly PerformanceObservation[], agentId: string, capability: string, minimumSamples = 3): PerformanceProfile {
  const rows = observations.filter(o => o.agentId === agentId && o.capability === capability)
  const n = rows.length; const avg = (f: (o: PerformanceObservation) => number) => n ? rows.reduce((s, o) => s + f(o), 0) / n : 0
  const components = { success: avg(o => o.success ? 100 : 0), verification: avg(o => o.verificationPassed ? 100 : 0), efficiency: avg(o => o.tokenReserved ? Math.min(100, (o.tokenUsed / o.tokenReserved) * 100) : 0), latency: avg(o => Math.max(0, 100 - Math.min(100, o.durationMs / 1000)),), retries: avg(o => Math.max(0, 100 - Math.min(100, o.retryCount * 20))), quality: avg(o => Math.max(0, 100 - Math.min(100, o.reviewFindings * 20))), regression: avg(o => Math.max(0, 100 - Math.min(100, o.regressionCount * 25))), integration: avg(o => o.integrationPassed ? 100 : 0) }
  const score = Math.round(Object.values(components).reduce((a, b) => a + b, 0) / Object.keys(components).length)
  return { agentId, capability, sampleCount: n, eligible: n >= minimumSamples, status: n >= minimumSamples ? "eligible" : "insufficient_data", components, score: Math.max(0, Math.min(100, score)), policyVersion: PERFORMANCE_POLICY_VERSION }
}
