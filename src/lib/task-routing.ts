export type TaskType =
  | "planning"
  | "design"
  | "implementation"
  | "debugging"
  | "review"
  | "testing"
  | "documentation"
  | "analysis"
  | "security"
  | "orchestration"

export function normalizeTaskType(taskType: string | undefined, agent: string): TaskType {
  const normalized = (taskType ?? "").trim().toLowerCase()
  if (isTaskType(normalized)) return normalized

  const a = agent.toLowerCase()
  if (a.includes("design") || a.includes("ui-ux")) return "design"
  if (a.includes("review")) return "review"
  if (a.includes("test")) return "testing"
  if (a.includes("debug")) return "debugging"
  if (a.includes("security")) return "security"
  if (a.includes("doc")) return "documentation"
  if (a.includes("architect") || a.includes("planner")) return "planning"
  if (a.includes("orchestrator") || a.includes("coordinator")) return "orchestration"
  if (a.includes("analyst") || a.includes("research")) return "analysis"
  return "implementation"
}

export function isTaskType(value: string): value is TaskType {
  return (
    value === "planning" ||
    value === "design" ||
    value === "implementation" ||
    value === "debugging" ||
    value === "review" ||
    value === "testing" ||
    value === "documentation" ||
    value === "analysis" ||
    value === "security" ||
    value === "orchestration"
  )
}

const UI_HEAVY_KEYWORDS = [
  "landing page",
  "marketing site",
  "website",
  "web app",
  "mobile app",
  "app screen",
  "dashboard",
  "admin panel",
  "settings page",
  "onboarding ux",
  "kanban",
  "design system",
  "responsive",
  "ui",
  "ux",
  "cta",
  "conversion flow",
  "saas interface",
  "user-facing",
]

const NON_UI_KEYWORDS = [
  "backend",
  "infrastructure",
  "migration",
  "pipeline",
  "api only",
  "database only",
  "cli",
  "worker",
]

export function isUiHeavyTask(input: string): boolean {
  const normalized = input.trim().toLowerCase()
  if (!normalized) return false
  const hasUiSignal = UI_HEAVY_KEYWORDS.some((keyword) => normalized.includes(keyword))
  if (!hasUiSignal) return false
  const hasOnlyNonUiSignals = NON_UI_KEYWORDS.some((keyword) => normalized.includes(keyword)) && !normalized.includes("frontend")
  return !hasOnlyNonUiSignals
}

export type UiTaskType =
  | "landing-page"
  | "dashboard"
  | "admin-panel"
  | "marketing-site"
  | "mobile-app"
  | "saas-app"
  | "internal-tool"
  | "app-screen"
  | "general-ui"

export function classifyUiTaskType(input: string): UiTaskType | null {
  const normalized = input.trim().toLowerCase()
  if (!isUiHeavyTask(normalized)) return null
  if (normalized.includes("landing page")) return "landing-page"
  if (normalized.includes("dashboard")) return "dashboard"
  if (normalized.includes("admin panel")) return "admin-panel"
  if (normalized.includes("marketing site")) return "marketing-site"
  if (normalized.includes("mobile app")) return "mobile-app"
  if (normalized.includes("saas")) return "saas-app"
  if (normalized.includes("internal tool")) return "internal-tool"
  if (normalized.includes("screen")) return "app-screen"
  return "general-ui"
}

export interface BrowserDebugIntent {
  isBrowserDebug: boolean;
  intent?: {
    domain: "frontend";
    operation: "debug-and-repair";
    scope: "browser-runtime";
    completion: "no-actionable-browser-failures";
  };
}

const BROWSER_DEBUG_KEYWORDS = [
  "console bug",
  "console error",
  "console errors",
  "frontend runtime error",
  "debug the website",
  "browser for error",
  "browser for errors",
  "ui runtime bug",
  "ui runtime bugs",
  "react error",
  "react errors",
  "run the web app and fix",
  "why this page is broken",
  "test the frontend and repair",
  "fix all console bugs",
  "fix console errors",
  "fix frontend bugs",
  "browser debugging",
];

export function classifyBrowserDebugIntent(input: string): BrowserDebugIntent {
  const normalized = input.trim().toLowerCase();
  if (!normalized) return { isBrowserDebug: false };

  const matches = BROWSER_DEBUG_KEYWORDS.some((kw) => normalized.includes(kw));

  if (matches) {
    return {
      isBrowserDebug: true,
      intent: {
        domain: "frontend",
        operation: "debug-and-repair",
        scope: "browser-runtime",
        completion: "no-actionable-browser-failures",
      },
    };
  }

  return { isBrowserDebug: false };
}



export function resolveTaskSkills(
  _userPrompt: string,
  _packageManager?: "bun" | "npm" | "pnpm" | "yarn"
): LazyResolveResult {
    return { paths: [] };
}

export interface StudioIntent {
  isStudioTask: boolean;
  isFullStack: boolean;
  intent?: {
    domain: "frontend" | "fullstack";
    operation: "generate" | "redesign" | "design-mode" | "build-app";
  };
}

const STUDIO_KEYWORDS = [
  "generate ui",
  "build ui",
  "create ui",
  "build page",
  "build dashboard",
  "redesign screen",
  "design mode",
  "create app",
  "full stack app",
  "build fullstack app",
  "generate app screen",
  "app studio",
];

export function classifyStudioIntent(input: string): StudioIntent {
  const normalized = input.trim().toLowerCase();
  if (!normalized) return { isStudioTask: false, isFullStack: false };

  const isMatch = STUDIO_KEYWORDS.some((kw) => normalized.includes(kw));
  const isFullStack = normalized.includes("full stack") || normalized.includes("fullstack");

  if (isMatch || isFullStack) {
    return {
      isStudioTask: true,
      isFullStack,
      intent: {
        domain: isFullStack ? "fullstack" : "frontend",
        operation: normalized.includes("redesign") ? "redesign" : normalized.includes("design mode") ? "design-mode" : "generate",
      },
    };
  }

  return { isStudioTask: false, isFullStack: false };
}

type LazyResolveResult = { paths: string[] };
