import { resolve, normalize } from "path"
import { tmpdir } from "os"
import { DEFAULT_SENSITIVE_PATTERNS } from "./sensitive-path"
import type { AuthorizationDecision, RiskLevel, RiskCategory } from "./approval-service"

export type ShellCategory = "read" | "mutating" | "sensitive-read" | "risky" | "approval-required" | "unknown"

export interface AuthorizationEvaluation {
  decision: AuthorizationDecision
  riskLevel: RiskLevel
  riskCategory: RiskCategory
  reason: string
  sensitiveMatches: string[]
  head: string | null
  scope: string
  target: string
  normalizedAction: string
  reversible: boolean
  isExternal: boolean
  requiresHumanApproval: boolean
}

export interface Classification {
  category: ShellCategory
  reason: string
  sensitiveMatches: string[]
  head: string | null
  authorization?: AuthorizationEvaluation
}

export interface ClassifierOptions {
  workingDir?: string
  extraSensitivePatterns?: ReadonlyArray<string>
}

const PRIVILEGED_SYSTEM_COMMANDS: ReadonlySet<string> = new Set([
  "sudo", "su", "doas",
  "systemctl", "service", "init", "shutdown", "reboot", "halt", "poweroff",
  "useradd", "userdel", "usermod", "groupadd", "groupdel", "groupmod", "passwd", "chsh",
  "mount", "umount", "fsck", "mkfs", "fdisk", "parted",
  "iptables", "ip6tables", "nft", "firewall-cmd", "ufw",
  "crontab", "at", "batch",
  "insmod", "rmmod", "modprobe",
])

const SYSTEM_PACKAGE_MANAGERS: ReadonlySet<string> = new Set([
  "apt", "apt-get", "aptitude", "yum", "dnf", "rpm", "pacman", "yay", "paru",
  "apk", "zypper", "emerge", "xbps-install", "snap", "flatpak",
])

const INFRA_DEPLOY_COMMANDS: ReadonlySet<string> = new Set([
  "terraform", "tofu", "pulumi", "kubectl", "helm", "k9s", "kubeadm", "ansible", "ansible-playbook",
])

const PUBLISH_COMMANDS: ReadonlySet<string> = new Set([
  "twine",
])

const REMOTE_NETWORK_TOOLS: ReadonlySet<string> = new Set([
  "ssh", "scp", "sftp", "ftp", "rsync", "nc", "ncat", "netcat", "socat",
])

const ALWAYS_READ_ONLY: ReadonlySet<string> = new Set([
  "ls", "pwd", "cd", "pushd", "popd", "echo", "printf", "true", "false", ":",
  "which", "whereis", "type", "command", "hash", "compgen", "complete",
  "head", "tail", "cat", "less", "more", "view", "tac", "rev",
  "wc", "file", "stat", "du", "df", "tree",
  "date", "uptime", "uname", "whoami", "id", "groups", "hostname", "hostnamectl",
  "env", "printenv",
  "tput", "stty", "tty", "locale", "localectl",
  "man", "info", "help", "apropos", "whatis",
  "dirname", "basename", "realpath", "readlink",
  "md5sum", "sha1sum", "sha256sum", "sha512sum", "b2sum", "sum", "cksum",
  "od", "xxd", "hexdump", "base64", "strings",
  "column", "paste", "expand", "unexpand", "fold", "fmt", "nl", "pr",
  "sort", "uniq", "comm", "diff",
  "cut", "tr", "shuf", "tsort", "join",
  "grep", "egrep", "fgrep", "rgrep", "ack", "ag", "rg", "ripgrep",
  "find", "fd", "fdfind", "locate", "mlocate",
  "ps", "top", "htop", "btop", "atop", "iotop", "iostat", "vmstat", "mpstat", "sar", "free",
  "ss", "netstat", "lsof", "lspci", "lsusb", "lsblk", "lsmod", "lsattr",
  "ip", "ifconfig", "route", "arp", "traceroute", "tracepath", "ping", "ping6", "mtr", "dig", "nslookup", "host", "drill",
  "getent", "ldapsearch",
  "seq", "yes", "sleep", "test", "[", "[["
])

const VERSION_OR_HELP_FLAGS: ReadonlySet<string> = new Set([
  "--version", "-v", "-V", "version",
  "--help", "-h", "help", "-help", "-version",
])

function isVersionOrHelpQuery(tokens: ReadonlyArray<string>): boolean {
  if (tokens.length === 0) return false
  const rest = tokens.slice(1)
  if (rest.length > 0 && rest.every((t) => VERSION_OR_HELP_FLAGS.has(t.toLowerCase()))) {
    return true
  }
  return false
}

function unquote(token: string): string {
  if (token.length >= 2) {
    const first = token[0]
    const last = token[token.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return token.slice(1, -1)
    }
  }
  return token
}

export function tokenize(command: string): string[] {
  const tokens: string[] = []
  let buf = ""
  let quote: '"' | "'" | null = null
  let escaped = false
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]
    if (escaped) {
      buf += ch
      escaped = false
      continue
    }
    if (ch === "\\") {
      escaped = true
      continue
    }
    if (quote) {
      if (ch === quote) {
        quote = null
        continue
      }
      buf += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      if (buf.length > 0) {
        tokens.push(unquote(buf))
        buf = ""
      }
      continue
    }
    buf += ch
  }
  if (buf.length > 0) tokens.push(unquote(buf))
  return tokens
}

function stripPrefix(command: string): { stripped: string; hasSudo: boolean } {
  let s = command.trim()
  let hasSudo = false
  let changed = true
  while (changed) {
    changed = false
    s = s.trim()
    if (s.startsWith("sudo ") || s.startsWith("sudo\t") || s.startsWith("doas ") || s.startsWith("su ")) {
      hasSudo = true
      s = s.replace(/^(sudo|doas|su)\s+/, "")
      changed = true
      continue
    }
    const envMatch = /^([A-Za-z_][A-Za-z0-9_]*)=(\S*)\s+/.exec(s)
    if (envMatch) {
      s = s.slice(envMatch[0].length)
      changed = true
    }
  }
  return { stripped: s, hasSudo }
}

export function extractCommandSubstitutions(command: string): string[] {
  const substitutions: string[] = []
  let i = 0
  while (i < command.length) {
    if (command[i] === "$" && command[i + 1] === "(") {
      let depth = 1
      let start = i + 2
      let j = start
      let quote: '"' | "'" | null = null
      let escaped = false
      while (j < command.length && depth > 0) {
        const ch = command[j]
        if (escaped) {
          escaped = false
          j++
          continue
        }
        if (ch === "\\") {
          escaped = true
          j++
          continue
        }
        if (quote) {
          if (ch === quote) quote = null
          j++
          continue
        }
        if (ch === '"' || ch === "'") {
          quote = ch
          j++
          continue
        }
        if (ch === "(") depth++
        else if (ch === ")") depth--
        j++
      }
      if (depth === 0) {
        substitutions.push(command.slice(start, j - 1))
        i = j
        continue
      }
    }
    if (command[i] === "`") {
      let start = i + 1
      let j = start
      let escaped = false
      while (j < command.length) {
        const ch = command[j]
        if (escaped) {
          escaped = false
          j++
          continue
        }
        if (ch === "\\") {
          escaped = true
          j++
          continue
        }
        if (ch === "`") break
        j++
      }
      if (j < command.length && command[j] === "`") {
        substitutions.push(command.slice(start, j))
        i = j + 1
        continue
      }
    }
    i++
  }
  return substitutions
}

export function isPathInWorkspaceOrTemp(targetPath: string, workspaceRoot = process.cwd()): boolean {
  if (!targetPath || targetPath.trim() === "") return true
  const trimmed = targetPath.trim()
  if (trimmed === "/" || trimmed === "~" || trimmed === "$HOME" || trimmed === "/etc" || trimmed === "/usr" || trimmed === "/var") {
    return false
  }

  const normalizedWorkspace = normalize(resolve(workspaceRoot))
  const allowedRoots = [
    normalizedWorkspace,
    normalize(resolve(tmpdir())),
    normalize(resolve("/tmp")),
    normalize(resolve("/private/tmp")),
    normalize(resolve("/var/folders")),
    normalize(resolve("/private/var/folders")),
    process.env.TMPDIR ? normalize(resolve(process.env.TMPDIR)) : null,
  ].filter(Boolean) as string[]

  let resolvedTarget = trimmed.startsWith("/") ? normalize(resolve(trimmed)) : normalize(resolve(workspaceRoot, trimmed))

  for (const root of allowedRoots) {
    if (resolvedTarget === root || resolvedTarget.startsWith(root + "/") || resolvedTarget.startsWith(root + "\\")) {
      return true
    }
  }

  return false
}

export function splitTopLevelSegments(cmd: string): string[] {
  const segments: string[] = []
  let buf = ""
  let quote: '"' | "'" | null = null
  let parenDepth = 0
  let escaped = false

  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]
    if (escaped) {
      buf += ch
      escaped = false
      continue
    }
    if (ch === "\\") {
      buf += ch
      escaped = true
      continue
    }
    if (quote) {
      buf += ch
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      buf += ch
      quote = ch
      continue
    }
    if (ch === "(") { parenDepth++; buf += ch; continue }
    if (ch === ")") { parenDepth = Math.max(0, parenDepth - 1); buf += ch; continue }

    if (parenDepth === 0) {
      if (ch === "|" && cmd[i + 1] === "|") {
        segments.push(buf.trim())
        buf = ""
        i++
        continue
      }
      if (ch === "&" && cmd[i + 1] === "&") {
        segments.push(buf.trim())
        buf = ""
        i++
        continue
      }
      if (ch === "|" || ch === ";" || ch === "\n") {
        segments.push(buf.trim())
        buf = ""
        continue
      }
    }
    buf += ch
  }
  if (buf.trim().length > 0) {
    segments.push(buf.trim())
  }
  return segments.filter((s) => s.length > 0)
}

export function checkSensitiveMatches(cmd: string, extraPatterns?: ReadonlyArray<string>): string[] {
  const matches: string[] = []
  const patterns = extraPatterns ? [...DEFAULT_SENSITIVE_PATTERNS, ...extraPatterns] : DEFAULT_SENSITIVE_PATTERNS
  for (const pat of patterns) {
    if (cmd.includes(pat)) {
      matches.push(pat)
    }
  }
  return matches
}

function evaluateSingleSegment(segment: string, options?: ClassifierOptions): AuthorizationEvaluation {
  const workingDir = options?.workingDir ?? process.cwd()
  const trimmed = segment.trim()

  if (trimmed.length === 0) {
    return {
      decision: "ALLOW",
      riskLevel: "normal",
      riskCategory: "read_inspection",
      reason: "empty command segment",
      sensitiveMatches: [],
      head: null,
      scope: "workspace",
      target: workingDir,
      normalizedAction: "",
      reversible: true,
      isExternal: false,
      requiresHumanApproval: false,
    }
  }

  // 1. Check sensitive file patterns (.env, ~/.ssh, *.pem, *.key, etc.)
  const sensitiveMatches = checkSensitiveMatches(trimmed, options?.extraSensitivePatterns)
  if (sensitiveMatches.length > 0) {
    return {
      decision: "APPROVAL_REQUIRED",
      riskLevel: "high",
      riskCategory: "sensitive_data",
      reason: `Command accesses sensitive path(s): ${sensitiveMatches.join(", ")}`,
      sensitiveMatches,
      head: tokenize(trimmed)[0] || null,
      scope: "sensitive data access",
      target: sensitiveMatches.join(", "),
      normalizedAction: trimmed,
      reversible: false,
      isExternal: false,
      requiresHumanApproval: true,
    }
  }

  // 1b. Global version or help check
  const earlyTokens = tokenize(stripPrefix(trimmed).stripped)
  if (isVersionOrHelpQuery(earlyTokens)) {
    return {
      decision: "ALLOW",
      riskLevel: "normal",
      riskCategory: "read_inspection",
      reason: "Version or help query",
      sensitiveMatches: [],
      head: earlyTokens[0] || null,
      scope: "workspace",
      target: workingDir,
      normalizedAction: trimmed,
      reversible: true,
      isExternal: false,
      requiresHumanApproval: false,
    }
  }

  const { stripped, hasSudo } = stripPrefix(trimmed)
  if (hasSudo) {
    return {
      decision: "APPROVAL_REQUIRED",
      riskLevel: "high",
      riskCategory: "privileged_system",
      reason: "Command uses privileged elevation (sudo/su/doas)",
      sensitiveMatches: [],
      head: "sudo",
      scope: "system administration",
      target: "system",
      normalizedAction: trimmed,
      reversible: false,
      isExternal: false,
      requiresHumanApproval: true,
    }
  }

  const tokens = tokenize(stripped)
  if (tokens.length === 0) {
    return {
      decision: "ALLOW",
      riskLevel: "normal",
      riskCategory: "read_inspection",
      reason: "whitespace only",
      sensitiveMatches: [],
      head: null,
      scope: "workspace",
      target: workingDir,
      normalizedAction: trimmed,
      reversible: true,
      isExternal: false,
      requiresHumanApproval: false,
    }
  }

  const head = tokens[0].toLowerCase()

  // 2. Check Remote Network Tools (ssh, scp, rsync, nc)
  if (REMOTE_NETWORK_TOOLS.has(head)) {
    return {
      decision: "APPROVAL_REQUIRED",
      riskLevel: "high",
      riskCategory: "infrastructure_deployment",
      reason: `Remote network command '${head}' crosses machine boundary`,
      sensitiveMatches: [],
      head,
      scope: "remote network",
      target: tokens[1] || "remote host",
      normalizedAction: trimmed,
      reversible: false,
      isExternal: true,
      requiresHumanApproval: true,
    }
  }

  // 3. Check System Package Managers
  if (SYSTEM_PACKAGE_MANAGERS.has(head)) {
    const isInspection = tokens.some((t) => ["search", "info", "list", "show", "query", "-Ss", "-Si", "-Q"].includes(t)) || isVersionOrHelpQuery(tokens)
    if (!isInspection) {
      return {
        decision: "APPROVAL_REQUIRED",
        riskLevel: "high",
        riskCategory: "privileged_system",
        reason: `System package manager '${head}' alters system packages`,
        sensitiveMatches: [],
        head,
        scope: "system package management",
        target: "operating system",
        normalizedAction: trimmed,
        reversible: false,
        isExternal: false,
        requiresHumanApproval: true,
      }
    }
  }

  // 4. Check Privileged System Commands
  if (PRIVILEGED_SYSTEM_COMMANDS.has(head)) {
    return {
      decision: "APPROVAL_REQUIRED",
      riskLevel: "high",
      riskCategory: "privileged_system",
      reason: `System administration command '${head}' modifies system state`,
      sensitiveMatches: [],
      head,
      scope: "system state",
      target: "operating system",
      normalizedAction: trimmed,
      reversible: false,
      isExternal: false,
      requiresHumanApproval: true,
    }
  }

  // 5. Check Cloud / Infra Deployment
  if (INFRA_DEPLOY_COMMANDS.has(head)) {
    const isInspection = tokens.some((t) => ["plan", "validate", "version", "help", "get", "describe", "diff", "show", "status"].includes(t.toLowerCase())) || isVersionOrHelpQuery(tokens)
    if (!isInspection) {
      return {
        decision: "APPROVAL_REQUIRED",
        riskLevel: "critical",
        riskCategory: "infrastructure_deployment",
        reason: `Infrastructure tool '${head}' mutates cloud or container cluster resources`,
        sensitiveMatches: [],
        head,
        scope: "cloud / cluster infrastructure",
        target: "infrastructure",
        normalizedAction: trimmed,
        reversible: false,
        isExternal: true,
        requiresHumanApproval: true,
      }
    }
  }

  // 6. Check Package Publishing & Releases
  if (PUBLISH_COMMANDS.has(head)) {
    return {
      decision: "APPROVAL_REQUIRED",
      riskLevel: "critical",
      riskCategory: "package_release",
      reason: `Publishing tool '${head}' uploads packages to external registries`,
      sensitiveMatches: [],
      head,
      scope: "package publication",
      target: "external registry",
      normalizedAction: trimmed,
      reversible: false,
      isExternal: true,
      requiresHumanApproval: true,
    }
  }

  // 7. Check Node / Test Inspection Queries vs Generic Node Execution
  if (head === "node") {
    const hasPrint = tokens.some((t) => t === "-p" || t === "--print" || t === "-e" && (t.includes("require") && t.includes("version")))
    if (hasPrint || isVersionOrHelpQuery(tokens)) {
      return {
        decision: "ALLOW",
        riskLevel: "normal",
        riskCategory: "read_inspection",
        reason: "Node read-only version/evaluation query",
        sensitiveMatches: [],
        head: "node",
        scope: "workspace",
        target: workingDir,
        normalizedAction: trimmed,
        reversible: true,
        isExternal: false,
        requiresHumanApproval: false,
      }
    }
    if (tokens.some((t) => t === "-e" || t === "--eval")) {
      return {
        decision: "ALLOW",
        riskLevel: "normal",
        riskCategory: "workspace_development",
        reason: "Node inline script execution",
        sensitiveMatches: [],
        head: "node",
        scope: "workspace",
        target: workingDir,
        normalizedAction: trimmed,
        reversible: true,
        isExternal: false,
        requiresHumanApproval: false,
      }
    }
  }

  // 8. Check bun / npm / pnpm / yarn / cargo / gh subcommands
  if (["npm", "pnpm", "yarn", "bun", "cargo", "gh"].includes(head)) {
    const sub = tokens[1]?.toLowerCase()

    if (sub === "test" || sub === "check" || sub === "clippy" || sub === "fmt" || sub === "run" && tokens[2]?.toLowerCase() === "test") {
      return {
        decision: "ALLOW",
        riskLevel: "normal",
        riskCategory: "read_inspection",
        reason: `Test / lint verification runner '${head} ${sub}'`,
        sensitiveMatches: [],
        head,
        scope: "workspace",
        target: workingDir,
        normalizedAction: trimmed,
        reversible: true,
        isExternal: false,
        requiresHumanApproval: false,
      }
    }

    if (sub === "publish") {
      return {
        decision: "APPROVAL_REQUIRED",
        riskLevel: "critical",
        riskCategory: "package_release",
        reason: `'${head} publish' releases package to public/remote registry`,
        sensitiveMatches: [],
        head,
        scope: "package registry",
        target: "remote package registry",
        normalizedAction: trimmed,
        reversible: false,
        isExternal: true,
        requiresHumanApproval: true,
      }
    }

    if (head === "gh") {
      if (sub === "release" || sub === "repo") {
        const action = tokens[2]?.toLowerCase()
        if (action === "create" || action === "delete" || action === "edit") {
          return {
            decision: "APPROVAL_REQUIRED",
            riskLevel: "high",
            riskCategory: "package_release",
            reason: `'gh ${sub} ${action}' mutates GitHub releases or repository settings`,
            sensitiveMatches: [],
            head,
            scope: "GitHub repository releases",
            target: "GitHub",
            normalizedAction: trimmed,
            reversible: false,
            isExternal: true,
            requiresHumanApproval: true,
          }
        }
      }

      const hasMutatingApiFlag = tokens.some((t, idx) => (t === "-X" || t === "--method") && ["POST", "PUT", "DELETE", "PATCH"].includes(tokens[idx + 1]?.toUpperCase()))
      const isGhMutatingSub = ["create", "edit", "close", "reopen", "delete", "comment", "merge"].includes(tokens[2]?.toLowerCase())

      if (hasMutatingApiFlag || isGhMutatingSub) {
        return {
          decision: "ALLOW",
          riskLevel: "normal",
          riskCategory: "workspace_development",
          reason: `GitHub CLI mutating action '${head} ${sub} ${tokens[2] || ""}'`,
          sensitiveMatches: [],
          head: "gh",
          scope: "workspace",
          target: workingDir,
          normalizedAction: trimmed,
          reversible: true,
          isExternal: false,
          requiresHumanApproval: false,
        }
      }

      return {
        decision: "ALLOW",
        riskLevel: "normal",
        riskCategory: "read_inspection",
        reason: "GitHub CLI read inspection",
        sensitiveMatches: [],
        head: "gh",
        scope: "workspace",
        target: workingDir,
        normalizedAction: trimmed,
        reversible: true,
        isExternal: false,
        requiresHumanApproval: false,
      }
    }

    return {
      decision: "ALLOW",
      riskLevel: "normal",
      riskCategory: "workspace_development",
      reason: `Autonomous package management command '${head} ${sub || ""}'`,
      sensitiveMatches: [],
      head,
      scope: "workspace",
      target: workingDir,
      normalizedAction: trimmed,
      reversible: true,
      isExternal: false,
      requiresHumanApproval: false,
    }
  }

  // 9. Check Git Operations (External push vs Local dev)
  if (head === "git") {
    let subIdx = 1
    while (subIdx < tokens.length && (/^-[A-Za-z]+$/.test(tokens[subIdx]) || tokens[subIdx] === "-C" || tokens[subIdx] === "--git-dir" || tokens[subIdx] === "--work-tree")) {
      if (tokens[subIdx] === "-C" || tokens[subIdx] === "--git-dir" || tokens[subIdx] === "--work-tree") subIdx += 2
      else subIdx += 1
    }
    const sub = tokens[subIdx]?.toLowerCase()

    if (sub === "push") {
      const isForce = tokens.some((t) => ["-f", "--force", "--force-with-lease", "--force-if-includes", "+"].some(f => t === f || t.startsWith("+")))
      const isDelete = tokens.some((t) => t === "--delete" || t.startsWith(":"))
      const riskLevel: RiskLevel = isForce ? "critical" : "high"
      const reason = isForce
        ? "git push with force rewrites remote history on external repository"
        : isDelete
        ? "git push deletes remote branch/ref on external repository"
        : "git push publishes commits to remote repository"

      return {
        decision: "APPROVAL_REQUIRED",
        riskLevel,
        riskCategory: "external_git",
        reason,
        sensitiveMatches: [],
        head: "git push",
        scope: "remote Git repository",
        target: tokens[subIdx + 1] || "origin",
        normalizedAction: trimmed,
        reversible: !isForce,
        isExternal: true,
        requiresHumanApproval: true,
      }
    }

    if (sub === "branch" && tokens.some(t => t === "-r" || t === "--remotes") && tokens.some(t => t === "-d" || t === "-D" || t === "--delete")) {
      return {
        decision: "APPROVAL_REQUIRED",
        riskLevel: "high",
        riskCategory: "external_git",
        reason: "git branch deleting remote-tracking branches",
        sensitiveMatches: [],
        head: "git branch",
        scope: "remote Git refs",
        target: "remote branches",
        normalizedAction: trimmed,
        reversible: false,
        isExternal: true,
        requiresHumanApproval: true,
      }
    }

    const isGitRemoteRead = sub === "remote" && (tokens.length === 2 || ["-v", "--verbose", "show", "get-url"].includes(tokens[2]?.toLowerCase()))
    const isGitBranchRead = sub === "branch" && (tokens.length === 2 || ["-a", "-r", "-v", "--list", "-l", "--show-current"].some(f => tokens.includes(f)) && !tokens.some(f => ["-d", "-D", "-m", "-M", "--delete"].includes(f)))
    const isGitTagRead = sub === "tag" && (tokens.length === 2 || ["-l", "--list", "-n"].some(f => tokens.includes(f)) && !tokens.some(f => ["-d", "--delete", "-a"].includes(f)))
    const isGitConfigRead = sub === "config" && tokens.some(f => ["--get", "--get-all", "--list", "-l", "--get-regexp"].includes(f))

    const isGitRead = [
      "status", "log", "diff", "show", "blame", "annotate",
      "ls-files", "ls-tree", "ls-remote", "rev-parse", "rev-list",
      "describe", "reflog", "shortlog", "check-ref-format", "version",
    ].includes(sub) || isGitRemoteRead || isGitBranchRead || isGitTagRead || isGitConfigRead || isVersionOrHelpQuery(tokens)

    if (isGitRead) {
      return {
        decision: "ALLOW",
        riskLevel: "normal",
        riskCategory: "read_inspection",
        reason: `Git read-only inspection '${sub}'`,
        sensitiveMatches: [],
        head: "git",
        scope: "workspace",
        target: workingDir,
        normalizedAction: trimmed,
        reversible: true,
        isExternal: false,
        requiresHumanApproval: false,
      }
    }

    return {
      decision: "ALLOW",
      riskLevel: "normal",
      riskCategory: "workspace_development",
      reason: `Local git operation '${sub || "git"}'`,
      sensitiveMatches: [],
      head: "git",
      scope: "workspace",
      target: workingDir,
      normalizedAction: trimmed,
      reversible: true,
      isExternal: false,
      requiresHumanApproval: false,
    }
  }

  // 10. Check Catastrophic Deletion (rm -rf /...)
  if (head === "rm") {
    const isRecursive = tokens.some((t) => t.includes("r") || t.includes("R"))
    const isForce = tokens.some((t) => t.includes("f"))
    const targets = tokens.slice(1).filter((t) => !t.startsWith("-"))

    for (const target of targets) {
      const cleanTarget = target.trim().replace(/^['"]|['"]$/g, "")
      if (cleanTarget === "/" || cleanTarget === "/*" || cleanTarget === "~" || cleanTarget === "$HOME" || cleanTarget === "/etc" || cleanTarget === "/var" || cleanTarget === "/usr" || cleanTarget === "/home") {
        return {
          decision: "APPROVAL_REQUIRED",
          riskLevel: "critical",
          riskCategory: "destructive_external",
          reason: `Catastrophic filesystem deletion targeting root/system path: ${cleanTarget}`,
          sensitiveMatches: [],
          head: "rm",
          scope: "filesystem deletion outside workspace",
          target: cleanTarget,
          normalizedAction: trimmed,
          reversible: false,
          isExternal: true,
          requiresHumanApproval: true,
        }
      }
      if (!isPathInWorkspaceOrTemp(cleanTarget, workingDir)) {
        return {
          decision: "APPROVAL_REQUIRED",
          riskLevel: isRecursive && isForce ? "critical" : "high",
          riskCategory: "destructive_external",
          reason: `Filesystem deletion targeting path outside workspace: ${cleanTarget}`,
          sensitiveMatches: [],
          head: "rm",
          scope: "filesystem deletion outside workspace",
          target: cleanTarget,
          normalizedAction: trimmed,
          reversible: false,
          isExternal: true,
          requiresHumanApproval: true,
        }
      }
    }
    return {
      decision: "ALLOW",
      riskLevel: "normal",
      riskCategory: "workspace_development",
      reason: "Local workspace file deletion",
      sensitiveMatches: [],
      head: "rm",
      scope: "workspace",
      target: targets.join(", ") || workingDir,
      normalizedAction: trimmed,
      reversible: false,
      isExternal: false,
      requiresHumanApproval: false,
    }
  }

  // 11. Read-only inspection commands
  if (ALWAYS_READ_ONLY.has(head) || isVersionOrHelpQuery(tokens)) {
    return {
      decision: "ALLOW",
      riskLevel: "normal",
      riskCategory: "read_inspection",
      reason: `Read-only inspection command '${head}'`,
      sensitiveMatches: [],
      head,
      scope: "workspace",
      target: workingDir,
      normalizedAction: trimmed,
      reversible: true,
      isExternal: false,
      requiresHumanApproval: false,
    }
  }

  // 12. Default for standard workspace development commands
  return {
    decision: "ALLOW",
    riskLevel: "normal",
    riskCategory: "workspace_development",
    reason: `Authorized autonomous workspace development command '${head}'`,
    sensitiveMatches: [],
    head,
    scope: "workspace",
    target: workingDir,
    normalizedAction: trimmed,
    reversible: true,
    isExternal: false,
    requiresHumanApproval: false,
  }
}

export function evaluateShellAuthorization(command: string, options?: ClassifierOptions): AuthorizationEvaluation {
  if (!command || typeof command !== "string" || command.trim().length === 0) {
    return {
      decision: "ALLOW",
      riskLevel: "normal",
      riskCategory: "read_inspection",
      reason: "empty command",
      sensitiveMatches: [],
      head: null,
      scope: "workspace",
      target: options?.workingDir ?? process.cwd(),
      normalizedAction: "",
      reversible: true,
      isExternal: false,
      requiresHumanApproval: false,
    }
  }

  const nestedSubs = extractCommandSubstitutions(command)
  for (const nested of nestedSubs) {
    const nestedEval = evaluateShellAuthorization(nested, options)
    if (nestedEval.decision === "APPROVAL_REQUIRED" || nestedEval.decision === "DENY_INVALID") {
      return {
        ...nestedEval,
        reason: `Nested command substitution '$(${nested})' requires approval: ${nestedEval.reason}`,
        normalizedAction: command.trim(),
      }
    }
  }

  const segments = splitTopLevelSegments(command)
  if (segments.length === 0) {
    return evaluateSingleSegment(command, options)
  }

  let highestDecision: AuthorizationDecision = "ALLOW"
  let highestRiskLevel: RiskLevel = "normal"
  let winningEval: AuthorizationEvaluation | null = null

  const riskRank: Record<RiskLevel, number> = {
    normal: 0,
    elevated: 1,
    high: 2,
    critical: 3,
  }

  const allSensitive: string[] = []

  for (const seg of segments) {
    const segEval = evaluateSingleSegment(seg, options)
    if (segEval.sensitiveMatches.length > 0) {
      allSensitive.push(...segEval.sensitiveMatches)
    }

    if (segEval.decision === "DENY_INVALID") {
      return segEval
    }

    if (segEval.decision === "APPROVAL_REQUIRED") {
      highestDecision = "APPROVAL_REQUIRED"
      if (!winningEval || riskRank[segEval.riskLevel] >= riskRank[highestRiskLevel]) {
        highestRiskLevel = segEval.riskLevel
        winningEval = segEval
      }
    } else if (highestDecision === "ALLOW") {
      if (
        !winningEval ||
        riskRank[segEval.riskLevel] > riskRank[highestRiskLevel] ||
        (segEval.riskCategory === "workspace_development" && winningEval.riskCategory === "read_inspection")
      ) {
        highestRiskLevel = segEval.riskLevel
        winningEval = segEval
      }
    }
  }

  if (winningEval && highestDecision === "APPROVAL_REQUIRED") {
    return {
      ...winningEval,
      sensitiveMatches: [...new Set(allSensitive)],
      normalizedAction: command.trim(),
    }
  }

  return winningEval ?? evaluateSingleSegment(command, options)
}

export function classifyShellCommand(command: string, options?: ClassifierOptions): Classification {
  if (!command || typeof command !== "string" || command.trim().length === 0) {
    return {
      category: "unknown",
      reason: "empty or invalid command",
      sensitiveMatches: [],
      head: null,
    }
  }

  const auth = evaluateShellAuthorization(command, options)

  let category: ShellCategory = "read"
  if (auth.decision === "APPROVAL_REQUIRED") {
    if (auth.riskCategory === "sensitive_data") {
      category = "sensitive-read"
    } else if (auth.riskCategory === "package_release") {
      category = "mutating"
    } else {
      category = "risky"
    }
  } else if (auth.decision === "DENY_INVALID") {
    category = "unknown"
  } else {
    if (auth.riskCategory === "workspace_development") {
      category = "mutating"
    } else {
      category = "read"
    }
  }

  return {
    category,
    reason: auth.reason,
    sensitiveMatches: auth.sensitiveMatches,
    head: auth.head,
    authorization: auth,
  }
}
