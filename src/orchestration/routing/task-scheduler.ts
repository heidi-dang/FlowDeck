/**
 * Task Scheduler
 *
 * Schedules and manages task execution within a WorkDAG.
 * Provides:
 * - Task queuing and scheduling
 * - Ready task detection
 * - Task completion tracking
 * - Cancellation support
 * - Scheduler overhead metrics
 */

import type { DAGNode, DAGNodeStatus, WorkDAG } from "./work-dag"
import { DAGBuilder } from "./work-dag"

export interface ScheduledTask {
  readonly node: DAGNode
  readonly scheduledAt: number
}

export class TaskScheduler {
  private dag: DAGBuilder
  private scheduledTasks = new Map<string, ScheduledTask>()
  private startTime: number = 0
  private totalSchedulingOps: number = 0

  constructor(initialParallelism: number = 1) {
    this.dag = new DAGBuilder()
    this.dag.setParallelism(initialParallelism)
    this.startTime = Date.now()
  }

  addTask(task: DAGNode): void {
    this.dag.addNode(task)
    this.totalSchedulingOps++
  }

  getReadyTasks(): DAGNode[] {
    return this.dag.getReadyNodes()
  }

  completeTask(taskId: string): void {
    const node = this.dag.getNode(taskId)
    if (!node) return

    this.dag.updateNodeStatus(taskId, "completed")
    this.scheduledTasks.delete(taskId)

    // Transition dependent nodes to ready if all dependencies are met
    const allNodes = Array.from((this.dag as any).nodes.values()) as DAGNode[]
    for (const n of allNodes) {
      if (n.dependencies.includes(taskId)) {
        const stillBlocked = n.dependencies.some((depId) => {
          if (depId === taskId) return false
          const dep = this.dag.getNode(depId)
          return dep?.status !== "completed"
        })
        if (!stillBlocked) {
          this.dag.updateNodeStatus(n.id, "ready")
        }
      }
    }

    this.totalSchedulingOps++
  }

  cancelTask(taskId: string): void {
    const node = this.dag.getNode(taskId)
    if (!node) return

    const status = node.status
    if (status === "completed" || status === "blocked") return

    this.dag.updateNodeStatus(taskId, "blocked")
    this.scheduledTasks.delete(taskId)

    // Cancel dependent tasks recursively
    const allNodes = Array.from((this.dag as any).nodes.values()) as DAGNode[]
    for (const n of allNodes) {
      if (n.dependencies.includes(taskId)) {
        this.cancelTask(n.id)
      }
    }

    this.totalSchedulingOps++
  }

  startTask(taskId: string, agentId: string): void {
    this.dag.updateNodeStatus(taskId, "running", agentId)
    this.scheduledTasks.set(taskId, {
      node: this.dag.getNode(taskId)!,
      scheduledAt: Date.now(),
    })
    this.totalSchedulingOps++
  }

  getSchedule(): DAGNode[] {
    const result: DAGNode[] = []
    const ready = this.getReadyTasks()

    // Sort by priority: checkpoints first, then verification, then tasks
    ready.sort((a, b) => {
      const priority = { checkpoint: 0, verification: 1, task: 2 }
      return priority[a.type] - priority[b.type]
    })

    // Limit by parallelism
    const running = this.dag.getRunningNodes()
    const availableSlots = (this.dag as any).parallelism - running.length

    result.push(...ready.slice(0, availableSlots))
    return result
  }

  getQueueDepth(): number {
    return this.dag.getReadyNodes().length
  }

  getSchedulerOverhead(): number {
    const elapsed = Date.now() - this.startTime
    return elapsed > 0 ? this.totalSchedulingOps / elapsed : 0
  }

  getDAG(): WorkDAG {
    return this.dag.build()
  }

  /**
   * Get all tasks that are currently blocked.
   */
  getBlockedTasks(): DAGNode[] {
    return this.dag.getBlockedNodes()
  }

  /**
   * Get all running tasks.
   */
  getRunningTasks(): DAGNode[] {
    return this.dag.getRunningNodes()
  }

  /**
   * Cancel all tasks assigned to a specific agent.
   */
  cancelAgentTasks(agentId: string): string[] {
    const running = this.getRunningTasks()
    const cancelled: string[] = []

    for (const task of running) {
      if (task.assignedTo === agentId) {
        this.cancelTask(task.id)
        cancelled.push(task.id)
      }
    }

    return cancelled
  }
}
