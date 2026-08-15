/**
 * Full-Stack Builder for Heidi UI/App Studio
 *
 * Constructs provider-neutral execution graphs for full-stack application creation
 * across database, backend/API, frontend, auth, storage, and release verification.
 */

import type { FullStackExecutionGraph, FullStackStage } from "./types";

export interface FullStackAppSpecification {
  applicationName: string;
  databaseProvider?: "sqlite" | "postgres" | "mysql" | "supabase" | "neon" | "redis";
  authProvider?: "auth.js" | "clerk" | "supabase-auth" | "custom";
  deploymentProvider?: "vercel" | "docker" | "cloudflare" | "aws" | "self-hosted";
  apiType?: "rest" | "graphql" | "trpc" | "server-actions";
  features?: string[];
}

export class FullStackBuilder {
  /**
   * Construct an execution graph for full-stack application creation.
   */
  public constructExecutionGraph(spec: FullStackAppSpecification): FullStackExecutionGraph {
    const db = spec.databaseProvider || "sqlite";
    const auth = spec.authProvider || "custom";
    const deployment = spec.deploymentProvider || "docker";
    const api = spec.apiType || "rest";

    const stages: FullStackStage[] = [
      {
        id: "stage-db",
        name: "Database & Schema Definition",
        domain: "database",
        tasks: [
          `Create ${db} schema migrations`,
          "Define data model relations and indexes",
          "Seed initial test data",
        ],
        dependencies: [],
      },
      {
        id: "stage-backend",
        name: "Backend & API Implementation",
        domain: "backend",
        tasks: [
          `Implement ${api} API endpoints`,
          `Configure ${auth} authentication middleware`,
          "Add input validation & CORS guards",
        ],
        dependencies: ["stage-db"],
      },
      {
        id: "stage-frontend",
        name: "Frontend & UI Component Generation",
        domain: "frontend",
        tasks: [
          "Generate application screen layouts",
          "Bind UI components to API endpoints",
          "Apply design system tokens",
        ],
        dependencies: ["stage-backend"],
      },
      {
        id: "stage-integration",
        name: "Full-Stack Integration & E2E Testing",
        domain: "integration",
        tasks: [
          "Execute CRUD integration flow",
          "Verify data persistence across page reloads",
          "Test responsive viewports",
        ],
        dependencies: ["stage-frontend"],
      },
      {
        id: "stage-verification",
        name: "Release & Verification Gate",
        domain: "verification",
        tasks: [
          "Run TypeScript typecheck",
          "Run lint & unit test suite",
          `Verify ${deployment} build packaging`,
        ],
        dependencies: ["stage-integration"],
      },
    ];

    return {
      applicationName: spec.applicationName || "FullStackApp",
      providers: {
        database: db,
        auth,
        deployment,
        apiType: api,
      },
      stages,
    };
  }
}
