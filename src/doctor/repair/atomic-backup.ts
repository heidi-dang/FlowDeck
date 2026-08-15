import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs"
import { join, dirname } from "node:path"

export interface BackupRecord {
  timestamp: string
  backupPath: string
  files: Record<string, string>
}

export class DoctorBackupManager {
  private backupDir: string

  constructor(directory: string) {
    const flowdeckDir = process.env.FLOWDECK_STATE_DIR || join(directory, ".flowdeck")
    this.backupDir = join(flowdeckDir, "backups")
  }

  /**
   * Create timestamped backup of mutable configuration & state files.
   */
  public createBackup(filePaths: string[]): BackupRecord | null {
    const files: Record<string, string> = {}
    for (const filePath of filePaths) {
      if (existsSync(filePath)) {
        try {
          files[filePath] = readFileSync(filePath, "utf-8")
        } catch {
          // ignore unreadable files
        }
      }
    }

    if (Object.keys(files).length === 0) {
      return null
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
    const backupPath = join(this.backupDir, `doctor-repair-${timestamp}.json`)
    const record: BackupRecord = { timestamp, backupPath, files }

    try {
      mkdirSync(this.backupDir, { recursive: true })
      writeFileSync(backupPath, JSON.stringify(record, null, 2), "utf-8")
      return record
    } catch {
      return null
    }
  }

  /**
   * Restore previous known-good configuration files from backup record.
   */
  public restoreBackup(record: BackupRecord): boolean {
    let allRestored = true
    for (const [filePath, content] of Object.entries(record.files)) {
      try {
        this.writeAtomic(filePath, content)
      } catch {
        allRestored = false
      }
    }
    return allRestored
  }

  /**
   * Atomic file write using temporary file and atomic rename.
   */
  public writeAtomic(filePath: string, content: string): void {
    const dir = dirname(filePath)
    mkdirSync(dir, { recursive: true })

    const tempPath = join(dir, `.tmp_${Date.now()}_${Math.random().toString(36).slice(2)}`)
    writeFileSync(tempPath, content, "utf-8")
    renameSync(tempPath, filePath)
  }
}
