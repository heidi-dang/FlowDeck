/**
 * Exploration Strategy & Safety Policy for Autonomous Browser Subsystem
 *
 * Defines targeted vs exploratory strategies, safe interactive target selection,
 * semantic reference preference, and strict destructive action filtering.
 */

import type { InteractiveElement, BrowserTarget } from "./types";

export type ExplorationMode = "targeted" | "exploratory";

export interface ExplorationBudget {
  maxRoutes: number;
  maxActions: number;
  maxTimeMs: number;
}

export const DEFAULT_EXPLORATION_BUDGET: ExplorationBudget = {
  maxRoutes: 10,
  maxActions: 25,
  maxTimeMs: 90000,
};

const DESTRUCTIVE_KEYWORDS = [
  "delete",
  "destroy",
  "remove account",
  "remove project",
  "remove member",
  "remove workspace",
  "permanently remove",
  "erase",
  "drop database",
  "drop table",
  "wipe data",
  "clear database",
  "publish",
  "publish changes",
  "deploy",
  "deploy production",
  "purchase",
  "confirm purchase",
  "checkout",
  "submit order",
  "payment",
  "submit payment",
  "process payment",
  "buy",
  "buy now",
  "charge",
  "send email",
  "send message",
  "send invitation",
  "invite user",
  "invite member",
  "revoke",
  "revoke token",
  "revoke access",
  "rotate credential",
  "rotate secret",
  "rotate key",
  "reset database",
  "truncate",
  "format disk",
  "uninstall",
  "transfer funds",
];

const SAFE_INTERACTIVE_ROLES = [
  "button",
  "link",
  "tab",
  "menuitem",
  "combobox",
  "checkbox",
  "radio",
  "textbox",
  "searchbox",
  "treeitem",
  "option",
];

export class ExplorationPolicy {
  public readonly mode: ExplorationMode;
  public readonly budget: ExplorationBudget;
  private visitedUrls = new Set<string>();
  private performedActionsCount: number = 0;
  private startTime: number;

  constructor(mode: ExplorationMode = "exploratory", customBudget?: Partial<ExplorationBudget>) {
    this.mode = mode;
    this.budget = { ...DEFAULT_EXPLORATION_BUDGET, ...customBudget };
    this.startTime = Date.now();
  }

  /**
   * Check if an element or label represents a destructive action.
   */
  public isDestructiveAction(element: InteractiveElement | string): boolean {
    const text = typeof element === "string" ? element : `${element.name} ${element.role} ${element.id || ""}`;
    const normalized = text.toLowerCase();

    return DESTRUCTIVE_KEYWORDS.some((keyword) => normalized.includes(keyword));
  }

  /**
   * Filter safe interactive targets from an accessibility snapshot.
   */
  public filterSafeTargets(elements: InteractiveElement[]): InteractiveElement[] {
    return elements.filter((el) => {
      // Must be a safe role
      if (!SAFE_INTERACTIVE_ROLES.includes(el.role.toLowerCase())) {
        return false;
      }
      // Must NOT be destructive
      if (el.isDestructive || this.isDestructiveAction(el)) {
        return false;
      }
      return true;
    });
  }

  /**
   * Select best semantic target reference over screen coordinates.
   */
  public selectSemanticTarget(element: InteractiveElement): BrowserTarget {
    if (element.id) {
      return { semanticId: element.id };
    }
    if (element.role && element.name) {
      return { role: element.role, name: element.name };
    }
    if (element.selector) {
      return { selector: element.selector };
    }
    return { text: element.name || "element" };
  }

  /**
   * Track visited URL and check if exploration coverage budget is exhausted.
   */
  public recordVisit(url: string): void {
    const clean = url.split("?")[0].split("#")[0];
    this.visitedUrls.add(clean);
  }

  public recordAction(): void {
    this.performedActionsCount++;
  }

  public isBudgetExhausted(): boolean {
    if (this.visitedUrls.size >= this.budget.maxRoutes) return true;
    if (this.performedActionsCount >= this.budget.maxActions) return true;
    if (Date.now() - this.startTime >= this.budget.maxTimeMs) return true;
    return false;
  }

  public isUrlVisited(url: string): boolean {
    const clean = url.split("?")[0].split("#")[0];
    return this.visitedUrls.has(clean);
  }
}
