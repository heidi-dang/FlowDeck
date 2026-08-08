/**
 * Routing policy / weights fingerprint manifest.
 *
 * Every version-governed canonical value (policy tables, vocabularies,
 * mappings, alias authorization, classifier rule identity+priority, fallback
 * policy semantics) is hashed into a SHA-256 fingerprint. The fingerprint for
 * the current version is registered in an immutable manifest
 * (fingerprints.json) via the update helper
 * (scripts/update-routing-fingerprints.mjs).
 *
 * The CI gate (scripts/check-routing-policy-version.mjs) fails when a policy
 * fingerprint changes without a version bump, when a version changes without
 * fingerprint registration, or when an existing registered fingerprint is
 * modified. The check cannot be satisfied by editing a fixture — it hashes
 * the live canonical values.
 *
 * The manifest is deep-frozen at module load; mutating it throws in strict
 * mode. When a canonical policy value changes, the developer MUST bump
 * ROUTING_POLICY_VERSION (or ROUTING_WEIGHTS_VERSION) and re-run
 * `node scripts/update-routing-fingerprints.mjs` to register the new
 * fingerprint.
 */

import { readFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { canonicalJson } from "./contracts/canonical"
import { deepFreeze } from "./contracts/immutability"
import {
  TASK_CLASSES,
  EXECUTION_STRATEGIES,
  PLACEHOLDER_TOKENS,
} from "./contracts/task"
import {
  MODEL_TIERS,
  MODEL_TIER_RANK,
  CAPABILITY_TIER_FLOOR,
} from "./contracts/models"
import {
  DEFAULT_STRATEGY_POLICIES,
  HIGH_RISK_CAPABILITY_FLOOR,
  HIGH_RISK_APPROVAL_REQUIREMENT,
  MAX_RECOVERY_LIMIT,
  MAX_SPECIALISTS_LIMIT,
} from "./contracts/strategy"
import {
  SPECIALIST_TERMINAL_STATUSES,
  CANONICAL_ALIAS_LOOKUP,
} from "./contracts/agents"
import {
  ROUTING_POLICY_VERSION,
  ROUTING_WEIGHTS_VERSION,
} from "./contracts"
import { SPECIALIST_TASK_CLASS } from "./classifier/specialist-registry"
import { CLASSIFIER_RULE_IDS, HIGH_RISK_CLASSES, MUTATING_CLASSES } from "./classifier/classifier"
import { DEFAULT_WEIGHTS } from "./scoring/scorers"

/** Fallback policy semantics bound into the policy fingerprint. */
export const FALLBACK_POLICY_SEMANTICS = "degradation-only"

/** The canonical set of version-governed policy values, as one object. */
export function computeRoutingPolicyPayload(): Record<string, unknown> {
  return {
    taskClasses: TASK_CLASSES,
    executionStrategies: EXECUTION_STRATEGIES,
    modelTiers: MODEL_TIERS,
    modelTierRank: MODEL_TIER_RANK,
    capabilityTierFloor: CAPABILITY_TIER_FLOOR,
    strategyDefaults: DEFAULT_STRATEGY_POLICIES,
    highRiskCapabilityFloor: HIGH_RISK_CAPABILITY_FLOOR,
    highRiskApprovalRequirement: HIGH_RISK_APPROVAL_REQUIREMENT,
    maxRecoveryLimit: MAX_RECOVERY_LIMIT,
    maxSpecialistsLimit: MAX_SPECIALISTS_LIMIT,
    specialistTaskClass: SPECIALIST_TASK_CLASS,
    specialistTerminalStatuses: SPECIALIST_TERMINAL_STATUSES,
    canonicalAliasLookup: CANONICAL_ALIAS_LOOKUP,
    placeholderTokens: PLACEHOLDER_TOKENS,
    classifierRuleIds: CLASSIFIER_RULE_IDS,
    highRiskClasses: HIGH_RISK_CLASSES,
    mutatingClasses: MUTATING_CLASSES,
    fallbackPolicy: FALLBACK_POLICY_SEMANTICS,
  }
}

/** All version-governed scoring weights, as one object. */
export function computeWeightsPayload(): Record<string, unknown> {
  return { weights: DEFAULT_WEIGHTS }
}

/** SHA-256 of the canonical JSON serialization of `payload`. */
export function fingerprintOf(payload: Record<string, unknown>): string {
  const canonical = canonicalJson(payload)
  return createHash("sha256").update(canonical, "utf8").digest("hex")
}

/** Current routing-policy fingerprint. */
export function computeRoutingPolicyFingerprint(): string {
  return fingerprintOf(computeRoutingPolicyPayload())
}

/** Current weights fingerprint. */
export function computeWeightsFingerprint(): string {
  return fingerprintOf(computeWeightsPayload())
}

/** Manifest file read once at module load. */
interface FingerprintManifestFile {
  routingPolicyVersion: string
  weightsVersion: string
  routingPolicyFingerprints: Record<string, string>
  weightsFingerprints: Record<string, string>
}

function loadManifestFile(): FingerprintManifestFile {
  const raw = readFileSync(new URL("./fingerprints.json", import.meta.url), "utf8")
  return JSON.parse(raw) as FingerprintManifestFile
}

const manifestFile = loadManifestFile()

/**
 * Immutable version → fingerprint manifest for the routing policy.
 * Deep-frozen at module load.
 */
export const ROUTING_POLICY_FINGERPRINTS: Readonly<Record<string, string>> = deepFreeze({
  ...manifestFile.routingPolicyFingerprints,
})

/**
 * Immutable version → fingerprint manifest for the scoring weights.
 * Deep-frozen at module load.
 */
export const ROUTING_WEIGHTS_FINGERPRINTS: Readonly<Record<string, string>> = deepFreeze({
  ...manifestFile.weightsFingerprints,
})

/**
 * Returns a report used by the CI gate:
 *   currentPolicyVersion, currentWeightsVersion, live fingerprints, and the
 *   registered manifests.
 */
export function getFingerprintReport(): {
  policyVersion: string
  weightsVersion: string
  policyFingerprint: string
  weightsFingerprint: string
  policyManifest: Readonly<Record<string, string>>
  weightsManifest: Readonly<Record<string, string>>
} {
  return {
    policyVersion: ROUTING_POLICY_VERSION,
    weightsVersion: ROUTING_WEIGHTS_VERSION,
    policyFingerprint: computeRoutingPolicyFingerprint(),
    weightsFingerprint: computeWeightsFingerprint(),
    policyManifest: ROUTING_POLICY_FINGERPRINTS,
    weightsManifest: ROUTING_WEIGHTS_FINGERPRINTS,
  }
}
