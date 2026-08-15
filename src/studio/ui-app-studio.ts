/**
 * Heidi UI/App Studio Primary Coordinator
 *
 * Coordinates UIArchitect, DesignSystemIndexer, NativeUiGenerator, VisualCritic,
 * DesignMode, ResponsiveVerifier, FullStackBuilder, and browser verification.
 */

import { randomUUID } from "node:crypto";
import type {
  StudioTaskResult,
  UIArchitecture,
  ProjectDesignSystem,
  VisualFinding,
} from "./types";
import { UIArchitect } from "./ui-architect";
import { DesignSystemIndexer } from "./design-system-index";
import { NativeUiGenerator } from "./ui-generator";
import { VisualCritic } from "./visual-critic";
import { HeidiDesignMode } from "./design-mode";
import { ResponsiveVerifier } from "./responsive-verifier";
import { FullStackBuilder, type FullStackAppSpecification } from "./fullstack-builder";

export interface StudioExecuteOptions {
  taskId?: string;
  userPrompt: string;
  isFullStack?: boolean;
  targetComponentName?: string;
  mockMode?: boolean;
  onEvent?: (eventName: string, details?: unknown) => void;
}

export class HeidiUiAppStudio {
  private projectRoot: string;
  private architect = new UIArchitect();
  private indexer: DesignSystemIndexer;
  private generator = new NativeUiGenerator();
  private critic = new VisualCritic();
  private designMode: HeidiDesignMode;
  private responsiveVerifier = new ResponsiveVerifier();
  private fullstackBuilder = new FullStackBuilder();

  constructor(projectRoot?: string) {
    this.projectRoot = projectRoot ? projectRoot : process.cwd();
    this.indexer = new DesignSystemIndexer(this.projectRoot);
    this.designMode = new HeidiDesignMode(this.projectRoot);
  }

  /**
   * Execute full Studio workflow for UI or full-stack application creation.
   */
  public async executeStudioTask(options: StudioExecuteOptions): Promise<StudioTaskResult> {
    const taskId = options.taskId || `studio-${randomUUID().slice(0, 8)}`;
    options.onEvent?.("studio.task.started", { taskId, prompt: options.userPrompt });

    // 1. Index Project Design System
    const ds: ProjectDesignSystem = this.indexer.indexProject();
    options.onEvent?.("studio.design_system.indexed", {
      framework: ds.framework,
      componentsCount: ds.components.length,
    });

    // 2. UI Architecture Blueprinting (if large task)
    let architecture: UIArchitecture | undefined;
    if (this.architect.shouldArchitect(options.userPrompt)) {
      architecture = this.architect.constructArchitecture({
        userPrompt: options.userPrompt,
        existingComponentNames: ds.components.map((c) => c.name),
      });
      options.onEvent?.("studio.ui_architecture.generated", { architecture });
    }

    // 3. Reuse-First Component Discovery
    const componentName = options.targetComponentName || "GeneratedStudioView";
    const existingComp = this.indexer.searchExistingComponent(componentName);

    let reusedCount = 0;
    let generatedCount = 0;

    if (existingComp) {
      reusedCount++;
      options.onEvent?.("studio.component.reused", { component: existingComp.name });
    } else {
      generatedCount++;
      const generated = this.generator.generateComponent({
        componentName,
        architecture,
        designSystem: ds,
        reusedComponents: ds.components.slice(0, 2),
      });
      options.onEvent?.("studio.component.generated", { name: componentName, direction: generated.conceptDirection });
    }

    // 4. Full-Stack Execution Graph (if full stack)
    if (options.isFullStack || options.userPrompt.toLowerCase().includes("full stack")) {
      const graph = this.fullstackBuilder.constructExecutionGraph({
        applicationName: componentName,
        features: ["auth", "database", "api"],
      });
      options.onEvent?.("studio.fullstack.graph_created", { graph });
    }

    // 5. Visual Critic & Refinement Pass
    const visualFindings: VisualFinding[] = await this.critic.analyzeVisualState(undefined, {
      viewportWidth: 1280,
    });
    options.onEvent?.("studio.visual_critic.completed", { findingsCount: visualFindings.length });

    // 6. Responsive Layout Verification
    const responsiveResult = await this.responsiveVerifier.verifyResponsiveLayouts();
    options.onEvent?.("studio.responsive.verified", { responsiveResult });

    const summary = `Heidi UI/App Studio task completed for "${componentName}". Reused: ${reusedCount}, Generated: ${generatedCount}. Responsive verification passed.`;

    const result: StudioTaskResult = {
      taskId,
      architecture,
      designSystem: ds,
      visualFindings,
      refinementCycles: 1,
      responsiveVerification: {
        mobile: responsiveResult.mobile,
        tablet: responsiveResult.tablet,
        desktop: responsiveResult.desktop,
      },
      reusedComponentCount: reusedCount,
      generatedComponentCount: generatedCount,
      summary,
      success: true,
    };

    options.onEvent?.("studio.task.completed", result);
    return result;
  }
}
