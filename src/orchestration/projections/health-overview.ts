export interface HealthOverviewProjection {
  services: Array<{
    name: string;
    status: string;
    uptime: number;
    lastCheck: string;
  }>;
  overall: string;
  totalServices: number;
  healthyServices: number;
  degradedServices: number;
  unhealthyServices: number;
  timestamp: string;
}

export function buildHealthOverview(serviceStatuses: Array<{
  name: string; status: string; uptime: number; lastCheck: string;
}>): HealthOverviewProjection {
  const healthy = serviceStatuses.filter(s => s.status === "healthy").length;
  const degraded = serviceStatuses.filter(s => s.status === "degraded").length;
  const unhealthy = serviceStatuses.filter(s => s.status === "unhealthy").length;
  const overall = unhealthy > 0 ? "unhealthy" : degraded > 0 ? "degraded" : "healthy";

  return {
    services: serviceStatuses,
    overall,
    totalServices: serviceStatuses.length,
    healthyServices: healthy,
    degradedServices: degraded,
    unhealthyServices: unhealthy,
    timestamp: new Date().toISOString(),
  };
}
