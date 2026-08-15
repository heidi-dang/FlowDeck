/**
 * UI Architect for Heidi UI/App Studio
 *
 * Constructs structured UIArchitecture blueprints before large generation tasks,
 * while bypassing heavyweight architectural planning for minor component edits.
 */

import type { UIArchitecture } from "./types";

export interface UIArchitectOptions {
  userPrompt: string;
  existingComponentNames?: string[];
  designSystemTheme?: "minimal" | "professional" | "expressive" | "dense";
}

export class UIArchitect {
  /**
   * Determine if the user request requires a structured UI architecture pass.
   */
  public shouldArchitect(prompt: string): boolean {
    const text = prompt.toLowerCase();
    const lightweightPatterns = [
      "fix typo",
      "change color of button",
      "add padding",
      "update title",
      "small tweak",
      "fix bug",
      "adjust margin",
      "rename header",
    ];

    if (lightweightPatterns.some((pattern) => text.includes(pattern))) {
      return false;
    }

    const largePatterns = [
      "create app",
      "build page",
      "build dashboard",
      "dashboard",
      "redesign",
      "generate screen",
      "full stack",
      "new interface",
      "admin panel",
      "landing page",
      "saas",
    ];

    return largePatterns.some((pattern) => text.includes(pattern));
  }

  /**
   * Generate a structured UIArchitecture model.
   */
  public constructArchitecture(options: UIArchitectOptions): UIArchitecture {
    const prompt = options.userPrompt.toLowerCase();
    const existing = new Set(options.existingComponentNames || []);

    const theme = options.designSystemTheme || (prompt.includes("dense") ? "dense" : prompt.includes("expressive") ? "expressive" : "professional");

    let navType: "sidebar" | "navbar" | "tabs" | "stacked" = "navbar";
    if (prompt.includes("dashboard") || prompt.includes("admin")) navType = "sidebar";
    if (prompt.includes("mobile") || prompt.includes("tab")) navType = "tabs";

    const screens = [
      {
        id: "screen-main",
        name: "Main Overview",
        route: "/",
        layoutPattern: navType === "sidebar" ? "sidebar-content" : "header-content-footer",
        primaryComponents: ["Header", "StatGrid", "MainContentTable"],
      },
    ];

    if (prompt.includes("settings")) {
      screens.push({
        id: "screen-settings",
        name: "Settings View",
        route: "/settings",
        layoutPattern: "tabbed-form",
        primaryComponents: ["SettingsForm", "ConfigList"],
      });
    }

    const components = [
      {
        name: "Header",
        purpose: "Top navigation and brand title",
        reuseExisting: existing.has("Header") || existing.has("Navbar"),
      },
      {
        name: "Button",
        purpose: "Interactive trigger control",
        reuseExisting: existing.has("Button"),
      },
      {
        name: "Card",
        purpose: "Structured content container",
        reuseExisting: existing.has("Card"),
      },
      {
        name: "Table",
        purpose: "Tabular data display",
        reuseExisting: existing.has("Table") || existing.has("DataTable"),
      },
    ];

    return {
      screens,
      navigation: {
        type: navType,
        routes: screens.map((s) => ({ path: s.route, label: s.name })),
      },
      components,
      dataRequirements: [
        {
          entity: "UserSession",
          fields: ["id", "name", "role"],
          source: "api",
        },
      ],
      responsiveStrategy: {
        mobileLayout: "single-column-stacked",
        tabletLayout: "two-column-grid",
        desktopLayout: "multi-column-dashboard",
      },
      designDirection: {
        theme,
        spacingRhythm: "compact-8px",
      },
      interactionModel: {
        primaryActions: ["Submit", "Filter", "Export"],
        formInteractions: ["Inline Validation", "Toast Feedback"],
      },
    };
  }
}
