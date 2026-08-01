/**
 * Work DAG (Directed Acyclic Graph)
 *
 * Represents task dependencies as a DAG structure. Supports:
 * - Read parallelism (independent nodes can run in parallel)
 * - Exact write ownership enforcement
 * - Capacity reservation for verification
 * - Cancellation of obsolete work
 */

export interface DAGNode {
  readonly id: string
  readonly type: "task" | "verification" | "checkpoint"
  readonly dependencies: readonly string[]
  assignedTo?: string
  status: DAGNodeStatus
  readonly estimatedCost: number
}

export type DAGNodeStatus = "pending" | "ready" | "running" | "completed" | "blocked" | "failed"

export interface WorkDAG {
  readonly nodes: ReadonlyMap<string, DAGNode>
  readonly parallelism: number
  readonly capacityReserved: number
}

export class DAGBuilder {
  private nodes = new Map<string, DAGNode>()
  private parallelism: number = 1
  private capacityReserved: number = 0

  addNode(node: DAGNode): void {
    this.nodes.set(node.id, { ...node })
  }

  removeNode(nodeId: string): void {
    const node = this.nodes.get(nodeId)
    if (!node) return

    // Remove this node from dependencies of other nodes
    for (const [id, n] of this.nodes) {
      if (n.dependencies.includes(nodeId)) {
        this.nodes.set(id, {
          ...n,
          dependencies: n.dependencies.filter((d) => d !== nodeId),
        })
      }
    }

    this.nodes.delete(nodeId)
  }

  updateNodeStatus(nodeId: string, status: DAGNodeStatus, assignedTo?: string): void {
    const node = this.nodes.get(nodeId)
    if (!node) return

    this.nodes.set(nodeId, {
      ...node,
      status,
      assignedTo: assignedTo ?? node.assignedTo,
    })
  }

  getNode(nodeId: string): DAGNode | undefined {
    return this.nodes.get(nodeId)
  }

  getReadyNodes(): DAGNode[] {
    return Array.from(this.nodes.values()).filter((node) => {
      if (node.status !== "pending") return false
      return node.dependencies.every((depId) => {
        const dep = this.nodes.get(depId)
        return dep?.status === "completed"
      })
    })
  }

  getRunningNodes(): DAGNode[] {
    return Array.from(this.nodes.values()).filter((node) => node.status === "running")
  }

  getBlockedNodes(): DAGNode[] {
    return Array.from(this.nodes.values()).filter((node) => {
      if (node.status === "blocked") return true
      if (node.status !== "pending") return false
      return node.dependencies.some((depId) => {
        const dep = this.nodes.get(depId)
        return dep?.status === "failed"
      })
    })
  }

  reserveCapacity(amount: number): void {
    this.capacityReserved += amount
  }

  setParallelism(value: number): void {
    this.parallelism = Math.max(1, value)
  }

  build(): WorkDAG {
    return {
      nodes: new Map(this.nodes),
      parallelism: this.parallelism,
      capacityReserved: this.capacityReserved,
    }
  }

  /**
   * Validate the DAG has no cycles.
   */
  validate(): { valid: boolean; cycle?: string[] } {
    const visited = new Set<string>()
    const recursionStack = new Set<string>()
    const path: string[] = []

    const visit = (nodeId: string): boolean => {
      if (recursionStack.has(nodeId)) {
        const cycleStart = path.indexOf(nodeId)
        return true
      }
      if (visited.has(nodeId)) return false

      visited.add(nodeId)
      recursionStack.add(nodeId)
      path.push(nodeId)

      const node = this.nodes.get(nodeId)
      if (node) {
        for (const dep of node.dependencies) {
          if (visit(dep)) return true
        }
      }

      path.pop()
      recursionStack.delete(nodeId)
      return false
    }

    for (const nodeId of this.nodes.keys()) {
      if (visit(nodeId)) {
        return { valid: false, cycle: [...path, nodeId] }
      }
    }

    return { valid: true }
  }
}
