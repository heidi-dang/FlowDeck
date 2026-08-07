/**
 * Context budget tracking for token allocation.
 * @module orchestration/context/context-budget
 */

export interface ContextBudget {
  totalBudget: number;
  mandatoryCost: number;
  highValueCost: number;
  optionalCost: number;
  remainingBudget: number;
  isOverBudget: boolean;
  truncationNeeded: number;
}

export function createBudget(totalBudget: number): ContextBudget {
  return {
    totalBudget,
    mandatoryCost: 0,
    highValueCost: 0,
    optionalCost: 0,
    remainingBudget: totalBudget,
    isOverBudget: false,
    truncationNeeded: 0,
  };
}

export function addMandatoryCost(budget: ContextBudget, cost: number): ContextBudget {
  const mandatoryCost = budget.mandatoryCost + cost;
  const totalCost = mandatoryCost + budget.highValueCost + budget.optionalCost;
  const remainingBudget = Math.max(0, budget.totalBudget - totalCost);
  const isOverBudget = totalCost > budget.totalBudget;
  const truncationNeeded = isOverBudget ? totalCost - budget.totalBudget : 0;

  return {
    ...budget,
    mandatoryCost,
    remainingBudget,
    isOverBudget,
    truncationNeeded,
  };
}

export function addHighValueCost(budget: ContextBudget, cost: number): ContextBudget {
  const highValueCost = budget.highValueCost + cost;
  const totalCost = budget.mandatoryCost + highValueCost + budget.optionalCost;
  const remainingBudget = Math.max(0, budget.totalBudget - totalCost);
  const isOverBudget = totalCost > budget.totalBudget;
  const truncationNeeded = isOverBudget ? totalCost - budget.totalBudget : 0;

  return {
    ...budget,
    highValueCost,
    remainingBudget,
    isOverBudget,
    truncationNeeded,
  };
}

export function addOptionalCost(budget: ContextBudget, cost: number): ContextBudget {
  const optionalCost = budget.optionalCost + cost;
  const totalCost = budget.mandatoryCost + budget.highValueCost + optionalCost;
  const remainingBudget = Math.max(0, budget.totalBudget - totalCost);
  const isOverBudget = totalCost > budget.totalBudget;
  const truncationNeeded = isOverBudget ? totalCost - budget.totalBudget : 0;

  return {
    ...budget,
    optionalCost,
    remainingBudget,
    isOverBudget,
    truncationNeeded,
  };
}

export function truncateOptional(budget: ContextBudget, amount: number): ContextBudget {
  const reducedOptional = Math.max(0, budget.optionalCost - amount);
  const optionalCost = reducedOptional;
  const totalCost = budget.mandatoryCost + budget.highValueCost + optionalCost;
  const remainingBudget = Math.max(0, budget.totalBudget - totalCost);
  const isOverBudget = totalCost > budget.totalBudget;
  const truncationNeeded = isOverBudget ? totalCost - budget.totalBudget : 0;

  return {
    ...budget,
    optionalCost,
    remainingBudget,
    isOverBudget,
    truncationNeeded,
  };
}

export function canAfford(budget: ContextBudget, cost: number): boolean {
  return budget.remainingBudget >= cost;
}
