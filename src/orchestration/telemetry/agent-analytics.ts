// ── Input Types ────────────────────────────────────────────────────────────────

export interface TaskMetrics {
  agentId: string;
  taskClass: string;
  success: boolean;
  firstPassSuccess: boolean;
  durationMs: number;
  tokenUse: number;
  toolUse: number;
  recovered: boolean;
  verificationFailed: boolean;
  ownershipOverlap: number;
  estimatedValue: number;
}

// ── Output Types ───────────────────────────────────────────────────────────────

export interface AgentMetrics {
  agentId: string;
  taskClass: string;
  successRate: number;
  firstPassSuccess: number;
  averageDurationMs: number;
  averageTokenUse: number;
  averageToolUse: number;
  recoveryRate: number;
  verificationFailureRate: number;
  ownershipOverlapCount: number;
  estimatedValue: number;
}

export interface AgentAggregateMetrics {
  overallSuccessRate: number;
  overallFirstPassSuccess: number;
  averageDurationMs: number;
  totalTasks: number;
  totalTokenUse: number;
  totalToolUse: number;
  overallRecoveryRate: number;
  overallVerificationFailureRate: number;
  averageOwnershipOverlap: number;
  totalEstimatedValue: number;
}

// ── Agent Analytics ────────────────────────────────────────────────────────────

interface TaskRecord {
  metrics: TaskMetrics;
  timestamp: number;
}

export class AgentAnalytics {
  private readonly tasks: Map<string, TaskRecord[]> = new Map();

  recordTask(agentId: string, metrics: TaskMetrics): void {
    const records = this.tasks.get(agentId) ?? [];
    records.push({ metrics, timestamp: Date.now() });
    this.tasks.set(agentId, records);
  }

  getAgentMetrics(agentId: string): AgentMetrics {
    const records = this.tasks.get(agentId) ?? [];
    if (records.length === 0) {
      return {
        agentId,
        taskClass: "",
        successRate: 0,
        firstPassSuccess: 0,
        averageDurationMs: 0,
        averageTokenUse: 0,
        averageToolUse: 0,
        recoveryRate: 0,
        verificationFailureRate: 0,
        ownershipOverlapCount: 0,
        estimatedValue: 0,
      };
    }

    const taskClasses = new Set<string>();
    let totalSuccess = 0;
    let totalFirstPass = 0;
    let totalDuration = 0;
    let totalTokenUse = 0;
    let totalToolUse = 0;
    let totalRecovered = 0;
    let totalVerificationFailed = 0;
    let totalOwnershipOverlap = 0;
    let totalEstimatedValue = 0;

    for (const record of records) {
      const m = record.metrics;
      taskClasses.add(m.taskClass);
      if (m.success) totalSuccess++;
      if (m.firstPassSuccess) totalFirstPass++;
      totalDuration += m.durationMs;
      totalTokenUse += m.tokenUse;
      totalToolUse += m.toolUse;
      if (m.recovered) totalRecovered++;
      if (m.verificationFailed) totalVerificationFailed++;
      totalOwnershipOverlap += m.ownershipOverlap;
      totalEstimatedValue += m.estimatedValue;
    }

    const count = records.length;

    return {
      agentId,
      taskClass: Array.from(taskClasses).join(","),
      successRate: totalSuccess / count,
      firstPassSuccess: totalFirstPass / count,
      averageDurationMs: totalDuration / count,
      averageTokenUse: totalTokenUse / count,
      averageToolUse: totalToolUse / count,
      recoveryRate: totalRecovered / count,
      verificationFailureRate: totalVerificationFailed / count,
      ownershipOverlapCount: totalOwnershipOverlap / count,
      estimatedValue: totalEstimatedValue,
    };
  }

  getAggregateMetrics(): AgentAggregateMetrics {
    let totalTasks = 0;
    let totalSuccess = 0;
    let totalFirstPass = 0;
    let totalDuration = 0;
    let totalTokenUse = 0;
    let totalToolUse = 0;
    let totalRecovered = 0;
    let totalVerificationFailed = 0;
    let totalOwnershipOverlap = 0;
    let totalEstimatedValue = 0;

    for (const records of this.tasks.values()) {
      for (const record of records) {
        const m = record.metrics;
        totalTasks++;
        if (m.success) totalSuccess++;
        if (m.firstPassSuccess) totalFirstPass++;
        totalDuration += m.durationMs;
        totalTokenUse += m.tokenUse;
        totalToolUse += m.toolUse;
        if (m.recovered) totalRecovered++;
        if (m.verificationFailed) totalVerificationFailed++;
        totalOwnershipOverlap += m.ownershipOverlap;
        totalEstimatedValue += m.estimatedValue;
      }
    }

    if (totalTasks === 0) {
      return {
        overallSuccessRate: 0,
        overallFirstPassSuccess: 0,
        averageDurationMs: 0,
        totalTasks: 0,
        totalTokenUse: 0,
        totalToolUse: 0,
        overallRecoveryRate: 0,
        overallVerificationFailureRate: 0,
        averageOwnershipOverlap: 0,
        totalEstimatedValue: 0,
      };
    }

    return {
      overallSuccessRate: totalSuccess / totalTasks,
      overallFirstPassSuccess: totalFirstPass / totalTasks,
      averageDurationMs: totalDuration / totalTasks,
      totalTasks,
      totalTokenUse,
      totalToolUse,
      overallRecoveryRate: totalRecovered / totalTasks,
      overallVerificationFailureRate: totalVerificationFailed / totalTasks,
      averageOwnershipOverlap: totalOwnershipOverlap / totalTasks,
      totalEstimatedValue,
    };
  }
}
