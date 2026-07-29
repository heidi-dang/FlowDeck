import { createHash } from "crypto"

export function computeChecksum(sql: string): string {
  return createHash("sha256").update(sql, "utf-8").digest("hex")
}
