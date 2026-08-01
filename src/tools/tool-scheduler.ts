/**
 * Tool Scheduler
 *
 * Schedules tool execution with:
 * - Multiple queues (FAST_READ, EXPENSIVE_READ, MUTATION, VERIFICATION, NETWORK)
 * - Priority levels within each queue
 * - Bounded concurrency per queue
 * - Cancellation support
 * - Output limits
 * - Ring buffers for result storage
 * - Cache policy metadata
 * - Queue metrics
 */

export enum ToolQueue {
  FAST_READ = "fast_read",
  EXPENSIVE_READ = "expensive_read",
  MUTATION = "mutation",
  VERIFICATION = "verification",
  NETWORK = "network",
}

export interface ToolTask {
  id: string
  queue: ToolQueue
  tool: string
  params: unknown
  priority: number
  createdAt: Date
}

export interface QueueConfig {
  /** Maximum concurrent tasks in this queue. Default: 1 */
  concurrency: number
  /** Maximum output size in bytes. Default: 10MB */
  maxOutputBytes: number
  /** Queue priority weight for scheduling. Default: 1 */
  priorityWeight: number
  /** Enable caching for this queue. Default: false */
  cacheEnabled: boolean
}

export interface QueueMetrics {
  queue: ToolQueue
  pending: number
  running: number
  completed: number
  failed: number
  cancelled: number
  avgWaitTimeMs: number
  avgExecutionTimeMs: number
  totalProcessed: number
}

export interface SchedulerMetrics {
  totalTasks: number
  totalEnqueued: number
  totalDequeued: number
  totalCancelled: number
  totalCompleted: number
  totalFailed: number
  queues: Record<ToolQueue, QueueMetrics>
  uptimeMs: number
}

export interface SchedulerOptions {
  /** Default concurrency per queue. Default: 1 */
  defaultConcurrency?: number
  /** Default max output bytes per task. Default: 10MB */
  defaultMaxOutputBytes?: number
  /** Default queue priority weight. Default: 1 */
  defaultPriorityWeight?: number
  /** Enable caching globally. Default: false */
  cacheEnabled?: boolean
}

interface RunningTask {
  task: ToolTask
  startedAt: number
  output?: string
  error?: string
  status: "running" | "completed" | "failed" | "cancelled"
}

interface CompletedTask {
  task: ToolTask
  completedAt: number
  executionTimeMs: number
  output?: string
  error?: string
  status: "completed" | "failed" | "cancelled"
}

const DEFAULT_CONCURRENCY = 1
const DEFAULT_MAX_OUTPUT_BYTES = 10 * 1024 * 1024 // 10MB
const DEFAULT_PRIORITY_WEIGHT = 1

const QUEUE_DEFAULTS: Record<ToolQueue, QueueConfig> = {
  [ToolQueue.FAST_READ]: {
    concurrency: 4,
    maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
    priorityWeight: 3,
    cacheEnabled: true,
  },
  [ToolQueue.EXPENSIVE_READ]: {
    concurrency: 2,
    maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
    priorityWeight: 2,
    cacheEnabled: true,
  },
  [ToolQueue.MUTATION]: {
    concurrency: 1,
    maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
    priorityWeight: 4,
    cacheEnabled: false, // Never cache mutations
  },
  [ToolQueue.VERIFICATION]: {
    concurrency: 2,
    maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
    priorityWeight: 3,
    cacheEnabled: true,
  },
  [ToolQueue.NETWORK]: {
    concurrency: 3,
    maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
    priorityWeight: 1,
    cacheEnabled: false,
  },
}

function createTaskId(): string {
  return `task_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
}

/**
 * Ring buffer for storing recent task outputs with bounded memory.
 */
class RingBuffer<T> {
  private buffer: (T | undefined)[]
  private head = 0
  private count = 0
  private capacity: number

  constructor(capacity: number) {
    this.capacity = capacity
    this.buffer = new Array(capacity)
  }

  push(item: T): void {
    this.buffer[this.head] = item
    this.head = (this.head + 1) % this.capacity
    if (this.count < this.capacity) {
      this.count++
    }
  }

  toArray(): T[] {
    if (this.count === 0) return []
    const result: T[] = []
    const start = this.count < this.capacity ? 0 : this.head
    for (let i = 0; i < this.count; i++) {
      const idx = (start + i) % this.capacity
      if (this.buffer[idx] !== undefined) {
        result.push(this.buffer[idx] as T)
      }
    }
    return result
  }

  get length(): number {
    return this.count
  }

  clear(): void {
    this.buffer = new Array(this.capacity)
    this.head = 0
    this.count = 0
  }
}

/**
 * Tool Scheduler for managing tool execution with queues, priorities, and concurrency.
 */
export class ToolScheduler {
  private queues: Map<ToolQueue, ToolTask[]> = new Map()
  private runningTasks: Map<string, RunningTask> = new Map()
  private completedTasks: RingBuffer<CompletedTask>
  private taskHistory: RingBuffer<CompletedTask>
  private cancelledTasks: Set<string> = new Set()
  private queueConfigs: Map<ToolQueue, QueueConfig> = new Map()
  private metrics: SchedulerMetrics
  private startedAt: number
  private globalCacheEnabled: boolean

  constructor(options: SchedulerOptions = {}) {
    this.startedAt = Date.now()
    this.globalCacheEnabled = options.cacheEnabled ?? false
    this.completedTasks = new RingBuffer(1000)
    this.taskHistory = new RingBuffer(10000)

    // Initialize queues and metrics
    const queueMetrics: Record<ToolQueue, QueueMetrics> = {} as Record<ToolQueue, QueueMetrics>
    for (const queue of Object.values(ToolQueue)) {
      this.queues.set(queue, [])
      const config = QUEUE_DEFAULTS[queue]
      this.queueConfigs.set(queue, { ...config })
      queueMetrics[queue] = {
        queue,
        pending: 0,
        running: 0,
        completed: 0,
        failed: 0,
        cancelled: 0,
        avgWaitTimeMs: 0,
        avgExecutionTimeMs: 0,
        totalProcessed: 0,
      }
    }

    this.metrics = {
      totalTasks: 0,
      totalEnqueued: 0,
      totalDequeued: 0,
      totalCancelled: 0,
      totalCompleted: 0,
      totalFailed: 0,
      queues: queueMetrics,
      uptimeMs: 0,
    }
  }

  /**
   * Enqueue a task for execution.
   */
  enqueue(task: ToolTask): void {
    if (!task.id) {
      task.id = createTaskId()
    }
    if (!task.createdAt) {
      task.createdAt = new Date()
    }

    const queue = this.queues.get(task.queue)
    if (!queue) {
      throw new Error(`Unknown queue: ${task.queue}`)
    }

    // Insert by priority (higher priority first)
    const insertIndex = queue.findIndex((t) => t.priority < task.priority)
    if (insertIndex === -1) {
      queue.push(task)
    } else {
      queue.splice(insertIndex, 0, task)
    }

    this.metrics.totalTasks++
    this.metrics.totalEnqueued++
    this.metrics.queues[task.queue].pending++
  }

  /**
   * Dequeue the next task from a specific queue.
   * Returns undefined if the queue is empty or at capacity.
   */
  dequeue(queueType: ToolQueue): ToolTask | undefined {
    const queue = this.queues.get(queueType)
    if (!queue || queue.length === 0) {
      return undefined
    }

    const config = this.queueConfigs.get(queueType)
    if (!config) {
      return undefined
    }

    // Check concurrency limit
    const runningInQueue = Array.from(this.runningTasks.values()).filter(
      (rt) => rt.task.queue === queueType && rt.status === "running"
    ).length

    if (runningInQueue >= config.concurrency) {
      return undefined
    }

    const task = queue.shift()
    if (!task) {
      return undefined
    }

    // Check if task was cancelled while waiting
    if (this.cancelledTasks.has(task.id)) {
      this.cancelledTasks.delete(task.id)
      this.metrics.queues[task.queue].cancelled++
      this.metrics.totalCancelled++
      return this.dequeue(queueType) // Try next task
    }

    // Mark as running
    this.runningTasks.set(task.id, {
      task,
      startedAt: Date.now(),
      status: "running",
    })

    this.metrics.totalDequeued++
    this.metrics.queues[task.queue].pending--
    this.metrics.queues[task.queue].running++

    return task
  }

  /**
   * Cancel a task by ID.
   * If the task is running, it will be marked for cancellation.
   * If the task is pending, it will be removed from the queue.
   */
  cancel(taskId: string): boolean {
    // Check running tasks
    const running = this.runningTasks.get(taskId)
    if (running) {
      if (running.status === "running") {
        running.status = "cancelled"
        this.cancelledTasks.add(taskId)
        this.metrics.queues[running.task.queue].running--
        this.metrics.queues[running.task.queue].cancelled++
        this.metrics.totalCancelled++
        return true
      }
      return false
    }

    // Check pending tasks in all queues
    for (const [queueType, queue] of this.queues) {
      const index = queue.findIndex((t) => t.id === taskId)
      if (index !== -1) {
        queue.splice(index, 1)
        this.cancelledTasks.add(taskId)
        this.metrics.queues[queueType].pending--
        this.metrics.queues[queueType].cancelled++
        this.metrics.totalCancelled++
        return true
      }
    }

    return false
  }

  /**
   * Complete a running task.
   */
  complete(taskId: string, output?: string, error?: string): void {
    const running = this.runningTasks.get(taskId)
    if (!running) {
      return
    }

    const executionTimeMs = Date.now() - running.startedAt
    running.output = output
    running.error = error

    if (error) {
      running.status = "failed"
      this.metrics.queues[running.task.queue].failed++
      this.metrics.totalFailed++
    } else {
      running.status = "completed"
      this.metrics.queues[running.task.queue].completed++
      this.metrics.totalCompleted++
    }

    this.metrics.queues[running.task.queue].running--

    // Add to completed tasks buffer
    const completed: CompletedTask = {
      task: running.task,
      completedAt: Date.now(),
      executionTimeMs,
      output,
      error,
      status: running.status,
    }
    this.completedTasks.push(completed)
    this.taskHistory.push(completed)

    // Update average execution time
    const queueMetrics = this.metrics.queues[running.task.queue]
    const prevTotal = queueMetrics.totalProcessed
    const prevAvg = queueMetrics.avgExecutionTimeMs
    queueMetrics.avgExecutionTimeMs = (prevAvg * prevTotal + executionTimeMs) / (prevTotal + 1)
    queueMetrics.totalProcessed++

    this.runningTasks.delete(taskId)
  }

  /**
   * Get the current queue depth for a specific queue.
   */
  getQueueDepth(queue: ToolQueue): number {
    return this.queues.get(queue)?.length ?? 0
  }

  /**
   * Get the number of running tasks in a specific queue.
   */
  getRunningCount(queue: ToolQueue): number {
    return Array.from(this.runningTasks.values()).filter(
      (rt) => rt.task.queue === queue && rt.status === "running"
    ).length
  }

  /**
   * Get all pending tasks in a specific queue.
   */
  getPendingTasks(queue: ToolQueue): ToolTask[] {
    return this.queues.get(queue)?.slice() ?? []
  }

  /**
   * Get all running tasks.
   */
  getRunningTasks(): ToolTask[] {
    return Array.from(this.runningTasks.values())
      .filter((rt) => rt.status === "running")
      .map((rt) => rt.task)
  }

  /**
   * Get completed tasks from the ring buffer.
   */
  getCompletedTasks(limit?: number): CompletedTask[] {
    const all = this.completedTasks.toArray()
    return limit ? all.slice(-limit) : all
  }

  /**
   * Get scheduler metrics.
   */
  getMetrics(): SchedulerMetrics {
    this.metrics.uptimeMs = Date.now() - this.startedAt
    return { ...this.metrics }
  }

  /**
   * Get metrics for a specific queue.
   */
  getQueueMetrics(queue: ToolQueue): QueueMetrics {
    return { ...this.metrics.queues[queue] }
  }

  /**
   * Update queue configuration.
   */
  configureQueue(queue: ToolQueue, config: Partial<QueueConfig>): void {
    const existing = this.queueConfigs.get(queue)
    if (existing) {
      this.queueConfigs.set(queue, { ...existing, ...config })
    }
  }

  /**
   * Get queue configuration.
   */
  getQueueConfig(queue: ToolQueue): QueueConfig | undefined {
    return this.queueConfigs.get(queue)
  }

  /**
   * Check if caching is enabled for a queue.
   */
  isCacheEnabled(queue: ToolQueue): boolean {
    const config = this.queueConfigs.get(queue)
    return config?.cacheEnabled ?? false
  }

  /**
   * Check if global caching is enabled.
   */
  isGlobalCacheEnabled(): boolean {
    return this.globalCacheEnabled
  }

  /**
   * Get the next available task across all queues, respecting priority weights.
   */
  dequeueNext(): ToolTask | undefined {
    // Calculate weighted priority for each queue
    const weightedQueues: Array<{ queue: ToolQueue; weight: number; task: ToolTask | undefined }> = []

    for (const queueType of Object.values(ToolQueue)) {
      const config = this.queueConfigs.get(queueType)
      if (!config) continue

      const task = this.dequeue(queueType)
      if (task) {
        // Adjust priority by queue weight
        weightedQueues.push({
          queue: queueType,
          weight: config.priorityWeight,
          task,
        })
      }
    }

    if (weightedQueues.length === 0) {
      return undefined
    }

    // Sort by effective priority (task priority * queue weight)
    weightedQueues.sort((a, b) => {
      const aPriority = a.task!.priority * a.weight
      const bPriority = b.task!.priority * b.weight
      return bPriority - aPriority
    })

    return weightedQueues[0].task
  }

  /**
   * Clear all pending tasks from a queue.
   */
  clearQueue(queue: ToolQueue): number {
    const queueTasks = this.queues.get(queue)
    if (!queueTasks) return 0

    const count = queueTasks.length
    this.metrics.queues[queue].pending = 0
    this.metrics.totalCancelled += count
    this.metrics.queues[queue].cancelled += count

    queueTasks.length = 0
    return count
  }

  /**
   * Get capability metadata for the scheduler.
   */
  getCapabilities(): {
    queues: ToolQueue[]
    maxConcurrency: number
    cacheSupported: boolean
    outputLimitBytes: number
  } {
    let maxConcurrency = 0
    for (const config of this.queueConfigs.values()) {
      maxConcurrency = Math.max(maxConcurrency, config.concurrency)
    }

    return {
      queues: Object.values(ToolQueue),
      maxConcurrency,
      cacheSupported: true,
      outputLimitBytes: DEFAULT_MAX_OUTPUT_BYTES,
    }
  }
}

/**
 * Default scheduler instance.
 */
export const defaultScheduler = new ToolScheduler()

/**
 * Create a new scheduler with custom options.
 */
export function createToolScheduler(options?: SchedulerOptions): ToolScheduler {
  return new ToolScheduler(options)
}
