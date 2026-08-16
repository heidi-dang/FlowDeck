/**
 * ModelLock — the authoritative model selection from the execution host.
 *
 * The host selects the model; FlowDeck locks it and enforces it throughout
 * all child workstream dispatches. No silent substitution is permitted.
 *
 * Phase 11 will use this type to enforce exact-model compatibility in the
 * runtime broker. Phase 2 defines the contract only.
 */

/**
 * Locked model context provided by the execution host.
 * Represents the user's authoritative model selection — immutable during
 * a FlowDeck orchestration run.
 */
export interface ModelLock {
  /**
   * The model identifier exactly as the host resolved it.
   * Must be passed unchanged to child workstreams.
   * Never substituted with a different model ID.
   */
  readonly modelId: string

  /**
   * The provider identifier exactly as the host resolved it.
   * Used by the runtime broker for MODEL_INCOMPATIBLE gate checks.
   */
  readonly providerId: string

  /**
   * Optional endpoint override when the provider uses a non-default base URL.
   * Resolved by the host; FlowDeck treats it as opaque.
   */
  readonly endpoint?: string | undefined

  /**
   * Optional credential reference (not the credential itself).
   * The host resolves the actual credential; FlowDeck never stores secrets.
   */
  readonly credentialRef?: string | undefined

  /**
   * Optional reasoning effort hint when supported by the model.
   * 'low' | 'medium' | 'high' or a provider-specific token string.
   */
  readonly reasoningEffort?: string | undefined

  /**
   * Context window size in tokens as declared by the host.
   * Used by budget calculations; absent means unknown.
   */
  readonly contextWindow?: number | undefined

  /**
   * Discriminant marking this as a locked (not provisional) selection.
   * Always true. Prevents accidental use of unresolved model references.
   */
  readonly locked: true
}
