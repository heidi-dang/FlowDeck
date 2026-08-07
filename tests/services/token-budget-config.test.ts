import { describe, it, expect } from "bun:test"
import {
  resolveTokenBudgetConfig,
  BUDGET_PROFILES,
  DEFAULT_PROFILE,
  TokenBudgetConfigError,
} from "../../src/config/token-budget-config"

describe("token-budget-config", () => {
  it("should resolve normal profile defaults", () => {
    const cfg = resolveTokenBudgetConfig()
    expect(cfg.enabled).toBe(true)
    expect(cfg.profile).toBe(DEFAULT_PROFILE)
    expect(cfg.runTotal).toBe(BUDGET_PROFILES.normal.runTotal)
    expect(cfg.childTotal).toBe(BUDGET_PROFILES.normal.childTotal)
    expect(cfg.warningThreshold).toBe(0.8)
    expect(cfg.hardStopThreshold).toBe(1.0)
  })

  it("applies explicit overrides on top of profile defaults", () => {
    const cfg = resolveTokenBudgetConfig({ profile: "audit", runTotal: 2_000_000, warningThreshold: 0.5 })
    expect(cfg.profile).toBe("audit")
    expect(cfg.runTotal).toBe(2_000_000)
    expect(cfg.childTotal).toBe(BUDGET_PROFILES.audit.childTotal)
    expect(cfg.warningThreshold).toBe(0.5)
  })

  it("rejects childTotal exceeding runTotal", () => {
    expect(() => resolveTokenBudgetConfig({ runTotal: 100_000, childTotal: 200_000 })).toThrow(TokenBudgetConfigError)
  })

  it("rejects non-positive runTotal", () => {
    expect(() => resolveTokenBudgetConfig({ runTotal: 0 })).toThrow(TokenBudgetConfigError)
    expect(() => resolveTokenBudgetConfig({ runTotal: -5 })).toThrow(TokenBudgetConfigError)
  })

  it("rejects NaN runTotal", () => {
    expect(() => resolveTokenBudgetConfig({ runTotal: Number.NaN })).toThrow(TokenBudgetConfigError)
  })

  it("rejects warningThreshold above hardStopThreshold", () => {
    expect(() => resolveTokenBudgetConfig({ warningThreshold: 0.9, hardStopThreshold: 0.5 })).toThrow(
      TokenBudgetConfigError,
    )
  })

  it("rejects out-of-range fractions", () => {
    expect(() => resolveTokenBudgetConfig({ warningThreshold: 0 })).toThrow(TokenBudgetConfigError)
    expect(() => resolveTokenBudgetConfig({ hardStopThreshold: 1.5 })).toThrow(TokenBudgetConfigError)
  })

  it("honours FLOWDECK_TOKEN_BUDGET_ENABLED=false", () => {
    const prev = process.env.FLOWDECK_TOKEN_BUDGET_ENABLED
    process.env.FLOWDECK_TOKEN_BUDGET_ENABLED = "false"
    try {
      expect(resolveTokenBudgetConfig().enabled).toBe(false)
    } finally {
      if (prev === undefined) delete process.env.FLOWDECK_TOKEN_BUDGET_ENABLED
      else process.env.FLOWDECK_TOKEN_BUDGET_ENABLED = prev
    }
  })

  it("honours FLOWDECK_TOKEN_BUDGET_RUN_TOTAL env override", () => {
    const prev = process.env.FLOWDECK_TOKEN_BUDGET_RUN_TOTAL
    process.env.FLOWDECK_TOKEN_BUDGET_RUN_TOTAL = "123456"
    try {
      // 123456 > childTotal (180000) would be invalid, so also raise childTotal.
      process.env.FLOWDECK_TOKEN_BUDGET_CHILD_TOTAL = "123456"
      expect(resolveTokenBudgetConfig().runTotal).toBe(123456)
      expect(resolveTokenBudgetConfig().childTotal).toBe(123456)
    } finally {
      if (prev === undefined) delete process.env.FLOWDECK_TOKEN_BUDGET_RUN_TOTAL
      else process.env.FLOWDECK_TOKEN_BUDGET_RUN_TOTAL = prev
      delete process.env.FLOWDECK_TOKEN_BUDGET_CHILD_TOTAL
    }
  })

  it("rejects invalid env profile", () => {
    const prev = process.env.FLOWDECK_TOKEN_BUDGET_PROFILE
    process.env.FLOWDECK_TOKEN_BUDGET_PROFILE = "bogus"
    try {
      expect(() => resolveTokenBudgetConfig()).toThrow(TokenBudgetConfigError)
    } finally {
      if (prev === undefined) delete process.env.FLOWDECK_TOKEN_BUDGET_PROFILE
      else process.env.FLOWDECK_TOKEN_BUDGET_PROFILE = prev
    }
  })

  it("config-matrix: every profile resolves with valid, monotonic ceilings", () => {
    for (const name of Object.keys(BUDGET_PROFILES) as Array<keyof typeof BUDGET_PROFILES>) {
      const cfg = resolveTokenBudgetConfig({ profile: name })
      expect(cfg.profile).toBe(name)
      expect(cfg.runTotal).toBeGreaterThan(0)
      expect(cfg.childTotal).toBeGreaterThan(0)
      // Child ceiling must never exceed run ceiling.
      expect(cfg.childTotal).toBeLessThanOrEqual(cfg.runTotal)
      // Thresholds are valid fractions.
      expect(cfg.warningThreshold).toBeGreaterThan(0)
      expect(cfg.warningThreshold).toBeLessThanOrEqual(1)
      expect(cfg.hardStopThreshold).toBeGreaterThan(0)
      expect(cfg.hardStopThreshold).toBeLessThanOrEqual(1)
      expect(cfg.warningThreshold).toBeLessThanOrEqual(cfg.hardStopThreshold)
    }
  })

  it("config-matrix: env overrides take precedence over config overrides", () => {
    const prevRun = process.env.FLOWDECK_TOKEN_BUDGET_RUN_TOTAL
    const prevChild = process.env.FLOWDECK_TOKEN_BUDGET_CHILD_TOTAL
    process.env.FLOWDECK_TOKEN_BUDGET_RUN_TOTAL = "999999"
    process.env.FLOWDECK_TOKEN_BUDGET_CHILD_TOTAL = "999999"
    try {
      // Config override says 100_000, but env must win.
      const cfg = resolveTokenBudgetConfig({ runTotal: 100_000, childTotal: 100_000 })
      expect(cfg.runTotal).toBe(999999)
      expect(cfg.childTotal).toBe(999999)
    } finally {
      if (prevRun === undefined) delete process.env.FLOWDECK_TOKEN_BUDGET_RUN_TOTAL
      else process.env.FLOWDECK_TOKEN_BUDGET_RUN_TOTAL = prevRun
      if (prevChild === undefined) delete process.env.FLOWDECK_TOKEN_BUDGET_CHILD_TOTAL
      else process.env.FLOWDECK_TOKEN_BUDGET_CHILD_TOTAL = prevChild
    }
  })

  it("config-matrix: rejects non-positive childTotal", () => {
    expect(() => resolveTokenBudgetConfig({ childTotal: 0 })).toThrow(TokenBudgetConfigError)
    expect(() => resolveTokenBudgetConfig({ childTotal: -1 })).toThrow(TokenBudgetConfigError)
  })

  it("config-matrix: rejects invalid env numbers", () => {
    const prev = process.env.FLOWDECK_TOKEN_BUDGET_RUN_TOTAL
    process.env.FLOWDECK_TOKEN_BUDGET_RUN_TOTAL = "not-a-number"
    try {
      expect(() => resolveTokenBudgetConfig()).toThrow(TokenBudgetConfigError)
    } finally {
      if (prev === undefined) delete process.env.FLOWDECK_TOKEN_BUDGET_RUN_TOTAL
      else process.env.FLOWDECK_TOKEN_BUDGET_RUN_TOTAL = prev
    }
  })
})