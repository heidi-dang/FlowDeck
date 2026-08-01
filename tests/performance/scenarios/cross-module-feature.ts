/**
 * Cross-Module Feature Scenario
 * Benchmark for feature implementation across multiple modules
 */

import type { BenchmarkScenario, BenchmarkExecution } from '../benchmark-runner';
import { createMockExecution } from './base';

const SCENARIO_ID = 'cross-module-feature';
const SCENARIO_NAME = 'Cross-Module Feature';
const SCENARIO_DESCRIPTION = 'Feature implementation touching multiple modules';

const FIXTURE = {
  repositoryState: {
    files: {
      'src/models/user.ts': `export interface User {
  id: string;
  name: string;
  email: string;
  createdAt: Date;
}
`,
      'src/services/auth.service.ts': `import { User } from '../models/user';

export class AuthService {
  async validateUser(user: User): Promise<boolean> {
    return !!user && !!user.email;
  }
}
`,
      'src/routes/auth.routes.ts': `import { AuthService } from '../services/auth.service';

export function setupAuthRoutes(app: any) {
  app.post('/login', async (req: any, res: any) => {
    res.json({ success: true });
  });
}
`,
    },
    gitSha: '5809fcf1230ff349ff0d7f5b53ed75403f44573b',
    branch: 'feat/performance-runtime-master-plan',
  },
  taskDescription: 'Add password reset functionality across User model, AuthService, and routes',
  expectedOutcome: 'success',
  affectedModules: [
    'src/models/user.ts',
    'src/services/auth.service.ts',
    'src/routes/auth.routes.ts',
  ],
  verificationCriteria: [
    'User model has resetToken field',
    'AuthService has requestPasswordReset method',
    'AuthService has resetPassword method',
    'New route POST /password-reset exists',
    'New route POST /reset-password exists',
  ],
};

export const crossModuleFeatureScenario: BenchmarkScenario = {
  id: SCENARIO_ID,
  name: SCENARIO_NAME,
  description: SCENARIO_DESCRIPTION,
  category: 'cross-module',
  baselineIterations: 3,
  milestoneIterations: 5,
  timeout: 120000,
  isolationLevel: 'filesystem',

  async execute(): Promise<BenchmarkExecution> {
    const startTime = performance.now();
    
    try {
      // Simulate multi-module coordination
      const modelEditDuration = 60;
      const serviceEditDuration = 100;
      const routeEditDuration = 80;
      const integrationDuration = 150;
      
      await new Promise((resolve) =>
        setTimeout(resolve, modelEditDuration + serviceEditDuration + routeEditDuration + integrationDuration)
      );
      
      return createMockExecution(
        performance.now() - startTime +
        modelEditDuration + serviceEditDuration + routeEditDuration + integrationDuration,
        'success'
      );
    } catch (error) {
      return {
        status: 'failure',
        duration: performance.now() - startTime,
        memorySnapshot: {
          heapUsedMB: 45,
          heapTotalMB: 100,
          externalMB: 8,
          timestamp: Date.now(),
        },
        tokenCounts: { input: 2500, output: 800, total: 3300 },
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
  return crossModuleFeatureScenario;
}
