/**
 * Specification value object.
 *
 * A Specification is the immutable content of a contract version. It captures
 * what the contract requires, how acceptance is measured, and what verification
 * rules apply. Once a contract version is activated, its specification becomes
 * immutable.
 *
 * Canonical serialization is provided separately via the hashing module.
 */

export type CriterionPriority = "critical" | "high" | "medium_mandatory" | "advisory"

export interface Requirement {
  readonly id: string
  readonly description: string
  readonly priority: CriterionPriority
  readonly category?: string
}

export interface AcceptanceCriterion {
  readonly id: string
  readonly description: string
  readonly condition: string
  readonly priority: CriterionPriority
}

export type VerificationScope = "unit" | "integration" | "e2e" | "manual"

export type FailureClass = "blocking" | "non_blocking"

export interface VerificationRule {
  readonly id: string
  readonly description: string
  readonly scope: VerificationScope
  readonly required: boolean
  readonly failureClass: FailureClass
}

export interface SpecificationInput {
  readonly requirements: readonly Requirement[]
  readonly acceptanceCriteria: readonly AcceptanceCriterion[]
  readonly verificationRules: readonly VerificationRule[]
}

export class Specification {
  public readonly requirements: readonly Requirement[]
  public readonly acceptanceCriteria: readonly AcceptanceCriterion[]
  public readonly verificationRules: readonly VerificationRule[]

  constructor(input: SpecificationInput) {
    this.requirements = Object.freeze([...input.requirements])
    this.acceptanceCriteria = Object.freeze([...input.acceptanceCriteria])
    this.verificationRules = Object.freeze([...input.verificationRules])
  }

  /** Returns a frozen copy of the specification. */
  toJSON(): SpecificationInput {
    return {
      requirements: this.requirements,
      acceptanceCriteria: this.acceptanceCriteria,
      verificationRules: this.verificationRules,
    }
  }
}
