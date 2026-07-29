/**
 * Policy version identifiers.
 * Strong PolicyVersion value object used for historical explainability.
 */

import { type PolicyVersion, CURRENT_POLICY_VERSION } from "../../common/types"

export function getCompletionPolicyVersion(): PolicyVersion {
  return CURRENT_POLICY_VERSION
}

export function isCompatiblePolicyVersion(version: string): boolean {
  // For now, only v1 is supported
  return version === CURRENT_POLICY_VERSION || version === "1.0.0"
}

export function assertValidPolicyVersion(version: string): void {
  if (!isCompatiblePolicyVersion(version)) {
    throw new Error(`Unknown policy version: "${version}". Supported: ${CURRENT_POLICY_VERSION}`)
  }
}
