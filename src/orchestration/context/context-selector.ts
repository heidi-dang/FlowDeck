/**
 * Context selection logic for filling token budget.
 * @module orchestration/context/context-selector
 */

import type { ContextItemRef, ContextManifest } from "./context-manifest";
import type { ContextBudget } from "./context-budget";
import {
  createBudget,
  addMandatoryCost,
  addHighValueCost,
  addOptionalCost,
  canAfford,
  truncateOptional,
} from "./context-budget";

export interface SelectionResult {
  manifest: ContextManifest;
  budget: ContextBudget;
  omittedItems: ContextItemRef[];
}

/**
 * Select context items within token budget, prioritizing mandatory items.
 * - Mandatory items are always included (fail if over budget)
 * - High-value items are added while budget allows
 * - Optional items fill remaining budget, truncated if needed
 */
export function selectContext(
  manifest: ContextManifest,
  totalBudget: number,
): SelectionResult {
  let budget = createBudget(totalBudget);
  const selectedItems: ContextItemRef[] = [];
  const omittedItems: ContextItemRef[] = [];

  // Sort items by priority (mandatory first, then high, then optional)
  const sortedItems = [...manifest.selectedItems].sort((a, b) => {
    const priorityOrder = { mandatory: 0, high: 1, optional: 2 };
    return priorityOrder[a.priority] - priorityOrder[b.priority];
  });

  for (const item of sortedItems) {
    if (item.priority === "mandatory") {
      if (canAfford(budget, item.tokenEstimate)) {
        budget = addMandatoryCost(budget, item.tokenEstimate);
        selectedItems.push(item);
      } else {
        // Mandatory items cannot be omitted - this signals a budget problem
        budget = addMandatoryCost(budget, item.tokenEstimate);
        selectedItems.push(item);
      }
    } else if (item.priority === "high") {
      if (canAfford(budget, item.tokenEstimate)) {
        budget = addHighValueCost(budget, item.tokenEstimate);
        selectedItems.push(item);
      } else {
        omittedItems.push(item);
      }
    } else {
      // Optional - try to add, truncate if over
      if (canAfford(budget, item.tokenEstimate)) {
        budget = addOptionalCost(budget, item.tokenEstimate);
        selectedItems.push(item);
      } else {
        omittedItems.push(item);
      }
    }
  }

  // Truncate optional items if over budget
  if (budget.isOverBudget && budget.truncationNeeded > 0) {
    budget = truncateOptional(budget, budget.truncationNeeded);
    // Re-filter selected items to only those still affordable
    const mandatoryItems = selectedItems.filter((i) => i.priority === "mandatory");
    const highValueItems = selectedItems.filter((i) => i.priority === "high");
    const optionalItems = selectedItems.filter((i) => i.priority === "optional");

    let runningCost = budget.mandatoryCost + budget.highValueCost;
    const finalSelected: ContextItemRef[] = [...mandatoryItems, ...highValueItems];

    for (const item of optionalItems) {
      if (runningCost + item.tokenEstimate <= budget.totalBudget) {
        finalSelected.push(item);
        runningCost += item.tokenEstimate;
      } else {
        omittedItems.push(item);
      }
    }

    return {
      manifest: {
        ...manifest,
        selectedItems: finalSelected,
        omittedItemCount: omittedItems.length,
        tokenUsage: runningCost,
      },
      budget: {
        ...budget,
        optionalCost: runningCost - budget.mandatoryCost - budget.highValueCost,
      },
      omittedItems,
    };
  }

  return {
    manifest: {
      ...manifest,
      selectedItems,
      omittedItemCount: omittedItems.length,
      tokenUsage: budget.mandatoryCost + budget.highValueCost + budget.optionalCost,
    },
    budget,
    omittedItems,
  };
}

/**
 * Validate that mandatory items haven't been silently removed.
 */
export function validateMandatoryPreserved(result: SelectionResult): boolean {
  const mandatoryItems = result.manifest.selectedItems.filter((i) => i.priority === "mandatory");
  const omittedMandatory = result.omittedItems.filter((i) => i.priority === "mandatory");
  return omittedMandatory.length === 0;
}
