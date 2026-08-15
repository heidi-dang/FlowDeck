/**
 * Heidi UI/App Studio Core Types for FlowDeck v2.0.0
 */

export interface ScreenDefinition {
  id: string;
  name: string;
  route: string;
  layoutPattern: string;
  primaryComponents: string[];
}

export interface NavigationDefinition {
  type: "sidebar" | "navbar" | "tabs" | "stacked";
  routes: Array<{ path: string; label: string; icon?: string }>;
}

export interface ComponentRequirement {
  name: string;
  purpose: string;
  reuseExisting: boolean;
  existingPath?: string;
}

export interface DataRequirement {
  entity: string;
  fields: string[];
  source: "api" | "local-state" | "props" | "database";
}

export interface ResponsiveStrategy {
  mobileLayout: string;
  tabletLayout: string;
  desktopLayout: string;
}

export interface DesignDirection {
  theme: "minimal" | "professional" | "expressive" | "dense";
  colorPalette?: Record<string, string>;
  spacingRhythm?: string;
}

export interface InteractionModel {
  primaryActions: string[];
  formInteractions?: string[];
  feedbackStates?: string[];
}

export interface UIArchitecture {
  screens: ScreenDefinition[];
  navigation: NavigationDefinition;
  components: ComponentRequirement[];
  dataRequirements: DataRequirement[];
  responsiveStrategy: ResponsiveStrategy;
  designDirection: DesignDirection;
  interactionModel: InteractionModel;
}

export interface DesignTokenIndex {
  colors: Record<string, string>;
  spacing: Record<string, string>;
  typography: Record<string, string>;
  radii: Record<string, string>;
  shadows: Record<string, string>;
}

export interface ComponentIndexEntry {
  name: string;
  filePath: string;
  category: "primitive" | "composite" | "layout" | "form";
  exportedSymbols: string[];
  propsSummary?: string[];
}

export type ComponentIndex = ComponentIndexEntry[];

export interface ProjectDesignSystem {
  tokens: DesignTokenIndex;
  components: ComponentIndex;
  typography: Record<string, string>;
  patterns: string[];
  constraints: string[];
  framework: string;
  hasTailwind: boolean;
  hasShadcn: boolean;
}

export interface VisualFinding {
  id: string;
  category:
    | "hierarchy"
    | "spacing"
    | "alignment"
    | "typography"
    | "contrast"
    | "responsive"
    | "accessibility"
    | "consistency"
    | "overflow";
  severity: "low" | "medium" | "high";
  target?: { selector?: string; semanticId?: string };
  description: string;
  actionable: boolean;
}

export type ModificationScope = "instance-local" | "feature-local" | "shared-component" | "global-token";

export interface DesignModeCorrelation {
  domSelector: string;
  reactComponentName?: string;
  sourceFile?: string;
  sourceLine?: number;
  sourceSymbol?: string;
  designComponentCategory?: string;
  modificationScope: ModificationScope;
  usagesCount?: number;
}

export interface FrontendProjectModel {
  framework: string;
  routing?: string;
  styling?: string;
  stateManagement?: string;
  components: ComponentIndex;
  designTokens: DesignTokenIndex;
  hooks: string[];
  apis: string[];
  patterns: string[];
}

export interface FullStackStage {
  id: string;
  name: string;
  domain: "database" | "backend" | "frontend" | "integration" | "verification";
  tasks: string[];
  dependencies: string[];
}

export interface FullStackExecutionGraph {
  applicationName: string;
  providers: {
    database: string;
    auth: string;
    deployment: string;
    apiType: string;
  };
  stages: FullStackStage[];
}

export interface StudioTaskResult {
  taskId: string;
  architecture?: UIArchitecture;
  designSystem?: ProjectDesignSystem;
  visualFindings: VisualFinding[];
  refinementCycles: number;
  responsiveVerification: {
    mobile: boolean;
    tablet: boolean;
    desktop: boolean;
  };
  reusedComponentCount: number;
  generatedComponentCount: number;
  summary: string;
  success: boolean;
}
