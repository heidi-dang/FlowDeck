/**
 * Task Classifier for FlowDeck routing intelligence.
 * @module orchestration/routing/task-classifier
 */

import type { State } from "../runtime/states.js";

/**
 * Input for task classification.
 */
export interface TaskInput {
  readonly description: string;
  readonly type?: "read" | "write" | "repair" | "audit";
  readonly filePatterns?: readonly string[];
  readonly domains?: readonly string[];
  readonly tags?: readonly string[];
  readonly isSecuritySensitive?: boolean;
  readonly isMigration?: boolean;
  readonly isCIFailure?: boolean;
  readonly isAuditRequest?: boolean;
  readonly estimatedFileCount?: number;
}

/**
 * Classification dimensions for task routing.
 */
export interface TaskClassification {
  readonly readOnly: boolean;
  readonly likelyFileCount: number;
  readonly domainCount: number;
  readonly verificationSurface: "minimal" | "moderate" | "extensive";
  readonly repositoryRisk: "none" | "low" | "medium" | "high";
  readonly productionImpact: "none" | "low" | "medium" | "high";
  readonly securitySensitive: boolean;
  readonly migrationInvolved: boolean;
  readonly ciFailure: boolean;
  readonly auditRequest: boolean;
  readonly ambiguity: "low" | "medium" | "high";
  readonly confidence: number; // 0-1
}

/**
 * Classifier that analyzes task characteristics using deterministic rules first.
 * Small model is invoked only when deterministic confidence is insufficient.
 */
export class TaskClassifier {
  private static readonly DETERMINISTIC_CONFIDENCE_THRESHOLD = 0.85;
  private static readonly HIGH_FILE_COUNT_THRESHOLD = 10;
  private static readonly MULTI_DOMAIN_THRESHOLD = 2;
  private static readonly RISKY_PATTERNS = [
    /production/i,
    /deploy/i,
    /migration/i,
    /schema/i,
    /\.env/i,
    /config\.(json|yaml|yml|ts)$/i,
    /\.sql$/i,
  ];
  private static readonly SECURITY_SENSITIVE_PATTERNS = [
    /auth/i,
    /credential/i,
    /secret/i,
    /password/i,
    /token/i,
    /permission/i,
    /access[_-]?control/i,
    /security/i,
    /encryption/i,
  ];
  private static readonly AUDIT_PATTERNS = [
    /audit/i,
    /review/i,
    /compliance/i,
    /certification/i,
    /assessment/i,
  ];
  private static readonly VERIFICATION_HEAVY_PATTERNS = [
    /test/i,
    /spec/i,
    /verify/i,
    /integration/i,
    /e2e/i,
    /acceptance/i,
  ];

  /**
   * Classify a task using deterministic rules.
   * Returns high confidence when rules are conclusive, lower confidence when ambiguous.
   */
  classify(task: TaskInput): TaskClassification {
    const readOnly = this.determineReadOnly(task);
    const likelyFileCount = this.estimateFileCount(task);
    const domainCount = this.countDomains(task);
    const verificationSurface = this.determineVerificationSurface(task);
    const repositoryRisk = this.determineRepositoryRisk(task);
    const productionImpact = this.determineProductionImpact(task);
    const securitySensitive = this.detectSecuritySensitivity(task);
    const migrationInvolved = this.detectMigration(task);
    const ciFailure = this.detectCIFailure(task);
    const auditRequest = this.detectAuditRequest(task);
    const ambiguity = this.determineAmbiguity(task);
    const confidence = this.calculateConfidence(task, {
      readOnly,
      likelyFileCount,
      domainCount,
      verificationSurface,
      repositoryRisk,
      productionImpact,
      securitySensitive,
      migrationInvolved,
      ciFailure,
      auditRequest,
      ambiguity,
    });

    return {
      readOnly,
      likelyFileCount,
      domainCount,
      verificationSurface,
      repositoryRisk,
      productionImpact,
      securitySensitive,
      migrationInvolved,
      ciFailure,
      auditRequest,
      ambiguity,
      confidence,
    };
  }

  private determineReadOnly(task: TaskInput): boolean {
    if (task.type === "read") return true;
    if (task.type === "write" || task.type === "repair") return false;
    if (task.type === "audit") return true;

    // Deterministic heuristics
    const desc = task.description.toLowerCase();
    if (
      desc.includes("read") ||
      desc.includes("get") ||
      desc.includes("list") ||
      desc.includes("query") ||
      desc.includes("fetch") ||
      desc.includes("search") ||
      desc.includes("find")
    ) {
      return true;
    }
    if (
      desc.includes("create") ||
      desc.includes("update") ||
      desc.includes("delete") ||
      desc.includes("modify") ||
      desc.includes("change") ||
      desc.includes("fix") ||
      desc.includes("add") ||
      desc.includes("remove")
    ) {
      return false;
    }

    return false; // Default to mutating for safety
  }

  private estimateFileCount(task: TaskInput): number {
    if (task.estimatedFileCount !== undefined) {
      return task.estimatedFileCount;
    }

    let count = 1;

    if (task.filePatterns) {
      count = Math.max(count, task.filePatterns.length);
    }

    const desc = task.description.toLowerCase();

    // Multi-file indicators
    if (
      desc.includes("multiple") ||
      desc.includes("several") ||
      desc.includes("all") ||
      desc.includes("batch")
    ) {
      count = Math.max(count, 5);
    }

    // Large-scale indicators
    if (
      desc.includes("refactor") ||
      desc.includes("restructure") ||
      desc.includes("migrate") ||
      desc.includes("overhaul")
    ) {
      count = Math.max(count, 10);
    }

    // Single-file indicators
    if (
      desc.includes("this file") ||
      desc.includes("single") ||
      desc.includes("one file")
    ) {
      count = 1;
    }

    return count;
  }

  private countDomains(task: TaskInput): number {
    if (task.domains) {
      return task.domains.length;
    }

    // Heuristic domain counting based on description
    const desc = task.description.toLowerCase();
    const domainKeywords = [
      "auth",
      "api",
      "database",
      "frontend",
      "backend",
      "storage",
      "cache",
      "queue",
      "logging",
      "metrics",
      "security",
      "config",
      "deployment",
    ];

    let domains = 0;
    for (const domain of domainKeywords) {
      if (desc.includes(domain)) {
        domains++;
      }
    }

    return Math.max(domains, 1); // At least one domain
  }

  private determineVerificationSurface(
    task: TaskInput,
  ): "minimal" | "moderate" | "extensive" {
    const desc = task.description.toLowerCase();

    if (
      this.matchAny(desc, TaskClassifier.VERIFICATION_HEAVY_PATTERNS) ||
      task.type === "write"
    ) {
      return "extensive";
    }

    if (task.type === "audit" || task.type === "read") {
      return "minimal";
    }

    if (this.matchAny(desc, TaskClassifier.RISKY_PATTERNS)) {
      return "moderate";
    }

    return "minimal";
  }

  private determineRepositoryRisk(
    task: TaskInput,
  ): "none" | "low" | "medium" | "high" {
    const desc = task.description.toLowerCase();

    if (this.matchAny(desc, TaskClassifier.RISKY_PATTERNS)) {
      return "high";
    }

    if (
      desc.includes("test") ||
      desc.includes("spec") ||
      desc.includes("mock") ||
      desc.includes("fixture")
    ) {
      return "low";
    }

    if (
      desc.includes("docs") ||
      desc.includes("readme") ||
      desc.includes("comment") ||
      desc.includes("format")
    ) {
      return "none";
    }

    // File pattern analysis
    if (task.filePatterns) {
      for (const pattern of task.filePatterns) {
        if (/\.(sql|env|yaml|json)$/i.test(pattern)) {
          return "medium";
        }
        if (/test|spec/i.test(pattern)) {
          return "low";
        }
      }
    }

    return "low";
  }

  private determineProductionImpact(
    task: TaskInput,
  ): "none" | "low" | "medium" | "high" {
    const desc = task.description.toLowerCase();

    if (
      desc.includes("production") ||
      desc.includes("deploy") ||
      desc.includes("release")
    ) {
      return "high";
    }

    if (
      desc.includes("main") ||
      desc.includes("master") ||
      desc.includes("release")
    ) {
      return "medium";
    }

    if (task.tags) {
      if (task.tags.includes("production")) return "high";
      if (task.tags.includes("staging")) return "medium";
      if (task.tags.includes("dev")) return "low";
    }

    return "none";
  }

  private detectSecuritySensitivity(task: TaskInput): boolean {
    if (task.isSecuritySensitive !== undefined) {
      return task.isSecuritySensitive;
    }

    const desc = task.description.toLowerCase();
    return this.matchAny(desc, TaskClassifier.SECURITY_SENSITIVE_PATTERNS);
  }

  private detectMigration(task: TaskInput): boolean {
    if (task.isMigration !== undefined) {
      return task.isMigration;
    }

    const desc = task.description.toLowerCase();
    return (
      desc.includes("migration") ||
      desc.includes("migrate") ||
      desc.includes("schema") ||
      desc.includes("upgrade")
    );
  }

  private detectCIFailure(task: TaskInput): boolean {
    if (task.isCIFailure !== undefined) {
      return task.isCIFailure;
    }

    const desc = task.description.toLowerCase();
    return (
      desc.includes("ci failure") ||
      desc.includes("ci failure") ||
      desc.includes("build failed") ||
      desc.includes("test failed") ||
      desc.includes("pipeline failed")
    );
  }

  private detectAuditRequest(task: TaskInput): boolean {
    if (task.isAuditRequest !== undefined) {
      return task.isAuditRequest;
    }

    const desc = task.description.toLowerCase();
    return this.matchAny(desc, TaskClassifier.AUDIT_PATTERNS);
  }

  private determineAmbiguity(task: TaskInput): "low" | "medium" | "high" {
    const desc = task.description;

    // Clear patterns indicate low ambiguity
    if (
      desc.includes("fix") ||
      desc.includes("implement") ||
      desc.includes("add") ||
      desc.includes("remove") ||
      desc.includes("update")
    ) {
      return "low";
    }

    // Vague patterns indicate higher ambiguity
    if (
      desc.includes("maybe") ||
      desc.includes("perhaps") ||
      desc.includes("might") ||
      desc.includes("could be") ||
      desc.includes("something")
    ) {
      return "high";
    }

    // Underspecified indicates medium ambiguity
    if (desc.length < 20 || this.estimateFileCount(task) > 5) {
      return "medium";
    }

    return "low";
  }

  private calculateConfidence(
    task: TaskInput,
    classification: Omit<TaskClassification, "confidence">,
  ): number {
    let confidence = 0.9; // Base confidence for deterministic rules

    // Boost confidence when explicit type is provided
    if (task.type) {
      confidence = Math.min(confidence + 0.05, 1.0);
    }

    // Reduce confidence for ambiguous tasks
    if (classification.ambiguity === "high") {
      confidence -= 0.2;
    } else if (classification.ambiguity === "medium") {
      confidence -= 0.1;
    }

    // Reduce confidence when estimated file count is highly uncertain
    if (task.estimatedFileCount === undefined && classification.likelyFileCount > 10) {
      confidence -= 0.15;
    }

    // Boost confidence when multiple signals agree
    if (
      classification.securitySensitive ||
      classification.migrationInvolved ||
      classification.ciFailure
    ) {
      confidence = Math.min(confidence + 0.05, 1.0);
    }

    return Math.max(Math.min(confidence, 1.0), 0.0);
  }

  private matchAny(text: string, patterns: ReadonlyArray<RegExp>): boolean {
    return patterns.some((pattern) => pattern.test(text));
  }

  /**
   * Check if deterministic classification is sufficient
   * or if small model should be invoked.
   */
  needsSmallModel(classification: TaskClassification): boolean {
    return classification.confidence < TaskClassifier.DETERMINISTIC_CONFIDENCE_THRESHOLD;
  }
}
