/**
 * Read-Only Audit Scenario
 * Benchmark for analysis/audit tasks
 */

import type { BenchmarkScenario, BenchmarkExecution } from '../benchmark-runner';
import { createMockExecution } from './base';

const SCENARIO_ID = 'read-only-audit';
const SCENARIO_NAME = 'Read-Only Audit';
const SCENARIO_DESCRIPTION = 'Analysis task without code changes';

const FIXTURE = {
  repositoryState: {
    files: {
      'src/services/user.service.ts': `export class UserService {
  async getUser(id: string) {
    return { id, name: 'Test User' };
  }

  async createUser(data: any) {
    return { id: 'new', ...data };
  }
}
`,
      'src/services/payment.service.ts': `export class PaymentService {
  async processPayment(amount: number) {
    return { success: true, transactionId: 'tx123' };
  }
}
`,
      'src/routes/api.ts': `import { UserService } from './services/user.service';
import { PaymentService } from './services/payment.service';

export function setupRoutes(app: any) {
  app.get('/users/:id', async (req, res) => {
    const user = await new UserService().getUser(req.params.id);
    res.json(user);
  });
}
`,
    },
    gitSha: '5809fcf1230ff349ff0d7f5b53ed75403f44573b',
    branch: 'feat/performance-runtime-master-plan',
  },
  taskDescription: 'Audit the codebase for security vulnerabilities in user and payment services',
  expectedOutcome: 'success',
  analysisTarget: 'src/services/',
  findingsExpected: 3, // security audit findings
  verificationCriteria: [
    'User service input validation audit',
    'Payment service injection prevention audit',
    'API route authorization audit',
  ],
};

export const readOnlyAuditScenario: BenchmarkScenario = {
  id: SCENARIO_ID,
  name: SCENARIO_NAME,
  description: SCENARIO_DESCRIPTION,
  category: 'read-only-audit',
  baselineIterations: 3,
  milestoneIterations: 5,
  timeout: 90000,
  isolationLevel: 'memory',

  async execute(): Promise<BenchmarkExecution> {
    const startTime = performance.now();
    
    try {
      // Simulate read-only analysis
      const scanDuration = 180; // ms - code scanning
      const analysisDuration = 220; // ms - analyzing findings
      const reportDuration = 100; // ms - generating report
      
      await new Promise((resolve) =>
        setTimeout(resolve, scanDuration + analysisDuration + reportDuration)
      );
      
      return createMockExecution(
        performance.now() - startTime + scanDuration + analysisDuration + reportDuration,
        'success'
      );
    } catch (error) {
      return {
        status: 'failure',
        duration: performance.now() - startTime,
        memorySnapshot: {
          heapUsedMB: 70,
          heapTotalMB: 150,
          externalMB: 12,
          timestamp: Date.now(),
        },
        tokenCounts: { input: 5000, output: 1500, total: 6500 },
        output: null,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  },
};

export function getFixture() {
  return { ...FIXTURE };
}

export function getScenario(): BenchmarkScenario {
  return readOnlyAuditScenario;
}
