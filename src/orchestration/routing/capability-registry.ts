/**
 * Capability Registry
 *
 * Maintains specialist capability definitions and access control.
 * Used to determine what operations each agent can perform and what
 * tools are available to them.
 */

export interface SpecialistCapability {
  readonly capability: string
  readonly allowedAgents: readonly string[]
  readonly allowedTools: readonly string[]
  readonly mutationStatus: "forbidden" | "limited" | "allowed"
  readonly humanGateRequired: boolean
  readonly parallelismSupport: "none" | "sequential" | "parallel"
  readonly cancellationSupport: boolean
  readonly expectedLatencyMs: number
}

export class CapabilityRegistry {
  private capabilities = new Map<string, SpecialistCapability>()

  register(capability: SpecialistCapability): void {
    this.capabilities.set(capability.capability, capability)
  }

  getCapability(capability: string): SpecialistCapability | undefined {
    return this.capabilities.get(capability)
  }

  canPerform(agent: string, capability: string): boolean {
    const cap = this.capabilities.get(capability)
    if (!cap) return false
    return cap.allowedAgents.includes(agent)
  }

  getAllowedTools(capability: string): string[] {
    const cap = this.capabilities.get(capability)
    if (!cap) return []
    return [...cap.allowedTools]
  }

  /**
   * Check if an agent can perform mutation operations on a capability.
   */
  canMutate(agent: string, capability: string): boolean {
    const cap = this.capabilities.get(capability)
    if (!cap) return false
    if (!cap.allowedAgents.includes(agent)) return false
    return cap.mutationStatus !== "forbidden"
  }

  /**
   * Check if an agent can execute operations on a capability in parallel.
   */
  supportsParallelism(capability: string): boolean {
    const cap = this.capabilities.get(capability)
    if (!cap) return false
    return cap.parallelismSupport === "parallel"
  }

  /**
   * Check if a capability supports cancellation.
   */
  supportsCancellation(capability: string): boolean {
    const cap = this.capabilities.get(capability)
    if (!cap) return false
    return cap.cancellationSupport
  }
}
