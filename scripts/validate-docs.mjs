import { readdirSync, readFileSync, existsSync } from "fs"
import { join } from "path"

const root = process.cwd()
const commandsDir = join(root, "src", "commands")
const skillsDir = join(root, "src", "skills")
const wikiDir = join(root, "docs", "wiki")
const docsDir = join(root, "docs")

// Authoritative canonical agents from src/services/canonical-registry.ts
const canonicalAgentNames = new Set([
  "heidi",
  "orchestrator",
  "planner",
  "architect",
  "researcher",
  "mapper",
  "backend-coder",
  "frontend-coder",
  "devops",
  "tester",
  "reviewer",
  "security-auditor",
  "debug-specialist",
  "browser-debugger",
])

const commandFiles = readdirSync(commandsDir).filter((file) => file.endsWith(".md"))
const commandSet = new Set(commandFiles.map((file) => `/${file.replace(".md", "")}`))
const commandPattern = /\/fd-[a-z0-9-]+/g
const agentPattern = /@([a-z0-9-]+)/g

function countSkills() {
  const dirs = readdirSync(skillsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory())
  return dirs.length
}

function getAllDocFiles(dir, fileList = []) {
  if (!existsSync(dir)) return fileList
  const entries = readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      getAllDocFiles(full, fileList)
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      fileList.push(full)
    }
  }
  return fileList
}

const allDocFiles = [
  join(root, "README.md"),
  ...getAllDocFiles(docsDir),
]

const failures = []

for (const fullPath of allDocFiles) {
  const relPath = fullPath.replace(root + "/", "")
  const content = readFileSync(fullPath, "utf-8")

  // Check command references
  const matches = content.match(commandPattern) ?? []
  for (const command of matches) {
    if (!commandSet.has(command)) {
      failures.push(`${relPath}: references non-canonical command ${command}`)
    }
  }

  // Check agent references if file is agent documentation
  if (relPath.includes("agents/")) {
    let match
    const regex = new RegExp(agentPattern)
    while ((match = regex.exec(content)) !== null) {
      const agent = match[1]
      // Exclude npm scopes like @heidi-dang or @modelcontextprotocol or @opencode-ai
      if (["heidi-dang", "modelcontextprotocol", "opencode-ai", "dv", "nghiem", "types"].includes(agent)) {
        continue
      }
      if (!canonicalAgentNames.has(agent)) {
        failures.push(`${relPath}: references non-canonical agent @${agent}`)
      }
    }
  }
}

// Verify skill count in README and docs/index.md
const docsWithSkillCount = ["README.md", "docs/index.md"]
for (const relPath of docsWithSkillCount) {
  const fullPath = join(root, relPath)
  if (!existsSync(fullPath)) continue
  const content = readFileSync(fullPath, "utf-8")
  const skillCountMatch = content.match(/\*\*(\d+)\s+\w*\s*skills\*\*/i)
  if (!skillCountMatch) {
    failures.push(`${relPath}: missing skills count badge line`)
  } else {
    const declared = Number(skillCountMatch[1])
    const actual = countSkills()
    if (declared !== actual) {
      failures.push(`${relPath}: declares ${declared} skills but src/skills has ${actual}`)
    }
  }
}

// Verify command count in docs/index.md
const indexPath = join(root, "docs/index.md")
if (existsSync(indexPath)) {
  const indexContent = readFileSync(indexPath, "utf-8")
  const commandCountMatch = indexContent.match(/\*\*(\d+)\s+commands\*\*/i)
  if (!commandCountMatch) {
    failures.push("docs/index.md: missing commands count badge line")
  } else {
    const declared = Number(commandCountMatch[1])
    const actual = commandFiles.length
    if (declared !== actual) {
      failures.push(`docs/index.md: declares ${declared} commands but src/commands has ${actual}`)
    }
  }
}

// ── Wiki page validation ────────────────────────────────────────────────

const requiredWikiPages = [
  "Home.md", "Installation.md", "Installation-npm.md",
  "Installation-local-repository.md", "Installation-project.md",
  "Installation-Windows.md", "Installation-macOS.md", "Installation-Linux.md",
  "Configuration.md", "Verification.md", "OpenCode-integration-test.md",
  "CLI-reference.md", "Architecture.md", "Troubleshooting.md",
  "Upgrade.md", "Uninstall.md", "Development.md", "FAQ.md",
  "_Sidebar.md",
]

for (const page of requiredWikiPages) {
  const pagePath = join(wikiDir, page)
  if (!existsSync(pagePath)) {
    failures.push(`docs/wiki/${page}: required wiki page does not exist`)
  }
}

if (failures.length > 0) {
  console.error("Docs validation failed:")
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}

console.log("Docs validation passed.")
