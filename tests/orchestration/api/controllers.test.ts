import { describe, it, expect } from "bun:test"
import { Readable } from "stream"
import { createRunController } from "../../../src/orchestration/api/controllers/run-controller"
import { createHealthController } from "../../../src/orchestration/api/controllers/health-controller"
import { createContractController } from "../../../src/orchestration/api/controllers/contract-controller"
import type { RequestContext } from "../../../src/orchestration/api/middleware/request-context"

function createMockReq(method: string, url: string, body?: any, headers: Record<string, string> = {}): any {
  const readable = new Readable({
    read() {
      if (body) {
        this.push(typeof body === "string" ? body : JSON.stringify(body))
      }
      this.push(null)
    },
  })
  ;(readable as any).method = method
  ;(readable as any).url = url
  ;(readable as any).headers = { host: "localhost:3000", ...headers }
  return readable
}

function createMockRes(): { res: any; getOutput: () => { status: number; headers: any; body: string } } {
  let status = 200
  let headers: any = {}
  let body = ""

  const res: any = {
    writeHead(s: number, h?: any) {
      status = s
      if (h) headers = { ...headers, ...h }
      return res
    },
    setHeader(k: string, v: string) {
      headers[k] = v
    },
    end(data?: string) {
      if (data) body += data
    },
  }

  return {
    res,
    getOutput: () => ({ status, headers, body }),
  }
}

const mockCtx: RequestContext = {
  requestId: "req-123",
  method: "GET",
  url: "/test",
  correlationId: "corr-123",
  startTime: Date.now(),
}

describe("Orchestration API Controllers", () => {
  describe("HealthController", () => {
    it("handles health check JSON and text/plain formats", async () => {
      const mockHealthService: any = {
        checkHealth: async () => ({
          status: "healthy",
          uptime: 1000,
          checks: [{ name: "db", status: "healthy", message: "connected" }],
        }),
        checkReadiness: async () => ({ status: "healthy", checks: [] }),
        checkLiveness: async () => ({ status: "healthy", uptime: 1000 }),
      }

      const controller = createHealthController(mockHealthService)

      // JSON health
      const reqJson = createMockReq("GET", "/health")
      const { res: resJson, getOutput: getOutputJson } = createMockRes()
      await controller.health(reqJson, resJson, mockCtx)
      expect(getOutputJson().status).toBe(200)
      expect(JSON.parse(getOutputJson().body).status).toBe("healthy")

      // Plaintext health
      const reqPlain = createMockReq("GET", "/health", undefined, { accept: "text/plain" })
      const { res: resPlain, getOutput: getOutputPlain } = createMockRes()
      await controller.health(reqPlain, resPlain, mockCtx)
      expect(getOutputPlain().status).toBe(200)
      expect(getOutputPlain().body).toContain("db: healthy - connected")

      // Readiness
      const reqReady = createMockReq("GET", "/readiness")
      const { res: resReady, getOutput: getOutputReady } = createMockRes()
      await controller.readiness(reqReady, resReady, mockCtx)
      expect(getOutputReady().status).toBe(200)
      expect(JSON.parse(getOutputReady().body).ready).toBe(true)

      // Liveness
      const reqLive = createMockReq("GET", "/liveness")
      const { res: resLive, getOutput: getOutputLive } = createMockRes()
      await controller.liveness(reqLive, resLive, mockCtx)
      expect(getOutputLive().status).toBe(200)
      expect(JSON.parse(getOutputLive().body).status).toBe("healthy")
    })
  })

  describe("RunController", () => {
    it("creates, lists, gets, updates, cancels, and pauses runs", async () => {
      const mockRunService: any = {
        createRun: async (input: any) => ({ id: "run-1", ...input, status: "created" }),
        listRuns: async () => ({ items: [{ id: "run-1" }], total: 1 }),
        getRun: async (id: string) => ({ id, status: "running" }),
        updateRun: async (id: string, input: any) => ({ id, ...input }),
        cancelRun: async (id: string, reason?: string) => ({ id, status: "cancelled", reason }),
        pauseRun: async (id: string) => ({ id, status: "paused" }),
      }

      const controller = createRunController(mockRunService)

      // Create Run
      const createReq = createMockReq("POST", "/runs", {
        runType: "planning",
        correlationId: "corr-123",
      })
      const { res: createRes, getOutput: getCreateOut } = createMockRes()
      await controller.create(createReq, createRes, mockCtx)
      expect(getCreateOut().status).toBe(201)
      expect(JSON.parse(getCreateOut().body).data.id).toBe("run-1")

      // List Runs
      const listReq = createMockReq("GET", "/runs?page=1&limit=10")
      const { res: listRes, getOutput: getListOut } = createMockRes()
      await controller.list(listReq, listRes, mockCtx)
      expect(getListOut().status).toBe(200)
      expect(JSON.parse(getListOut().body).data).toHaveLength(1)

      // Get Run
      const getReq = createMockReq("GET", "/runs/run-1")
      const { res: getRes, getOutput: getOut } = createMockRes()
      await controller.get(getReq, getRes, mockCtx, "run-1")
      expect(getOut().status).toBe(200)
      expect(JSON.parse(getOut().body).data.id).toBe("run-1")

      // Cancel Run
      const cancelReq = createMockReq("POST", "/runs/run-1/cancel", { reason: "User abort" })
      const { res: cancelRes, getOutput: getCancelOut } = createMockRes()
      await controller.cancel(cancelReq, cancelRes, mockCtx, "run-1")
      expect(getCancelOut().status).toBe(200)
      expect(JSON.parse(getCancelOut().body).data.status).toBe("cancelled")

      // Pause Run
      const pauseReq = createMockReq("POST", "/runs/run-1/pause", {})
      const { res: pauseRes, getOutput: getPauseOut } = createMockRes()
      await controller.pause(pauseReq, pauseRes, mockCtx, "run-1")
      expect(getPauseOut().status).toBe(200)
      expect(JSON.parse(getPauseOut().body).data.status).toBe("paused")
    })
  })

  describe("ContractController", () => {
    it("creates, lists, gets, and updates contracts", async () => {
      const mockContractService: any = {
        createContract: async (input: any) => ({ contractId: "c-1", ...input }),
        listContracts: async () => ({ items: [{ contractId: "c-1" }], total: 1 }),
        getContract: async (id: string) => ({ contractId: id, status: "draft" }),
        updateContract: async (id: string, input: any) => ({ contractId: id, ...input }),
      }

      const controller = createContractController(mockContractService)

      // Create Contract
      const createReq = createMockReq("POST", "/contracts", {
        name: "Test Contract",
        correlationId: "corr-123",
      })
      const { res: createRes, getOutput: getCreateOut } = createMockRes()
      await controller.create(createReq, createRes, mockCtx)
      expect(getCreateOut().status).toBe(201)
      expect(JSON.parse(getCreateOut().body).data.contractId).toBe("c-1")

      // List Contracts
      const listReq = createMockReq("GET", "/contracts?page=1&limit=10")
      const { res: listRes, getOutput: getListOut } = createMockRes()
      await controller.list(listReq, listRes, mockCtx)
      expect(getListOut().status).toBe(200)

      // Get Contract
      const getReq = createMockReq("GET", "/contracts/c-1")
      const { res: getRes, getOutput: getOut } = createMockRes()
      await controller.get(getReq, getRes, mockCtx, "c-1")
      expect(getOut().status).toBe(200)
      expect(JSON.parse(getOut().body).data.contractId).toBe("c-1")
    })
  })
})
