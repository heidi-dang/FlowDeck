import { describe, it, expect } from "bun:test"
import { evaluateShellAuthorization } from "../../src/services/shell-command-classifier"

describe("FlowDeck v2.2.7 Shell Authorization Engine", () => {
  const workspace = "/home/shacker/Desktop/flowdeck-antigravity"

  describe("1. Autonomous Workspace Development (ALLOW)", () => {
    it("allows variable assignment with safe command substitution", () => {
      const cmd = 'audit_id="heidi-v2.2.6-full-audit-$(date +%Y%m%d-%H%M%S)"'
      const auth = evaluateShellAuthorization(cmd, { workingDir: workspace })
      expect(auth.decision).toBe("ALLOW")
      expect(auth.riskLevel).toBe("normal")
      expect(auth.requiresHumanApproval).toBe(false)
    })

    it("allows git rev-parse HEAD in command substitution", () => {
      const cmd = 'sha=$(git rev-parse HEAD)'
      const auth = evaluateShellAuthorization(cmd, { workingDir: workspace })
      expect(auth.decision).toBe("ALLOW")
      expect(auth.requiresHumanApproval).toBe(false)
    })

    it("allows mkdir -p inside /tmp or workspace", () => {
      const cmd = 'mkdir -p /tmp/flowdeck-heidi-audit/heidi-v2.2.7-test'
      const auth = evaluateShellAuthorization(cmd, { workingDir: workspace })
      expect(auth.decision).toBe("ALLOW")
      expect(auth.requiresHumanApproval).toBe(false)
    })

    it("allows touch and file creation inside /tmp or workspace", () => {
      const cmd = 'touch /tmp/flowdeck-heidi-audit/run-123/events.jsonl'
      const auth = evaluateShellAuthorization(cmd, { workingDir: workspace })
      expect(auth.decision).toBe("ALLOW")
    })

    it("allows file redirects into workspace files", () => {
      const cmd = 'printf "%s\n" "123" > /tmp/flowdeck-heidi-audit/run-123/run-id'
      const auth = evaluateShellAuthorization(cmd, { workingDir: workspace })
      expect(auth.decision).toBe("ALLOW")
    })

    it("allows local git commit and branch operations", () => {
      const cmd = 'git add . && git commit -m "feat: local dev" && git checkout -b feat/test'
      const auth = evaluateShellAuthorization(cmd, { workingDir: workspace })
      expect(auth.decision).toBe("ALLOW")
      expect(auth.riskCategory).toBe("workspace_development")
    })

    it("allows local dependency & test commands", () => {
      const cmds = [
        "npm install",
        "bun add -d typescript",
        "pnpm test",
        "cargo check",
        "cargo test",
        "cargo clippy",
        "bun test tests/foo.test.ts",
      ]
      for (const cmd of cmds) {
        const auth = evaluateShellAuthorization(cmd, { workingDir: workspace })
        expect(auth.decision).toBe("ALLOW")
      }
    })

    it("allows safe file deletion inside workspace/tmp", () => {
      const cmd = "rm -f /tmp/flowdeck-test/artifact.json"
      const auth = evaluateShellAuthorization(cmd, { workingDir: workspace })
      expect(auth.decision).toBe("ALLOW")
    })
  })

  describe("2. Approval-Required Trust Boundaries (APPROVAL_REQUIRED)", () => {
    it("requires approval for git push (high risk)", () => {
      const cmd = "git push origin feat/new-feature"
      const auth = evaluateShellAuthorization(cmd, { workingDir: workspace })
      expect(auth.decision).toBe("APPROVAL_REQUIRED")
      expect(auth.riskLevel).toBe("high")
      expect(auth.riskCategory).toBe("external_git")
      expect(auth.requiresHumanApproval).toBe(true)
    })

    it("requires critical approval for git push --force", () => {
      const cmd = "git push --force origin main"
      const auth = evaluateShellAuthorization(cmd, { workingDir: workspace })
      expect(auth.decision).toBe("APPROVAL_REQUIRED")
      expect(auth.riskLevel).toBe("critical")
      expect(auth.riskCategory).toBe("external_git")
    })

    it("requires approval for package publishing (npm/cargo publish)", () => {
      const npmAuth = evaluateShellAuthorization("npm publish --access public", { workingDir: workspace })
      expect(npmAuth.decision).toBe("APPROVAL_REQUIRED")
      expect(npmAuth.riskCategory).toBe("package_release")

      const cargoAuth = evaluateShellAuthorization("cargo publish", { workingDir: workspace })
      expect(cargoAuth.decision).toBe("APPROVAL_REQUIRED")
      expect(cargoAuth.riskCategory).toBe("package_release")
    })

    it("requires approval for gh release create", () => {
      const ghAuth = evaluateShellAuthorization("gh release create v2.2.7 --title 'v2.2.7' dist/*", { workingDir: workspace })
      expect(ghAuth.decision).toBe("APPROVAL_REQUIRED")
      expect(ghAuth.riskCategory).toBe("package_release")
    })

    it("requires approval for sudo and privileged system operations", () => {
      const sudoAuth = evaluateShellAuthorization("sudo systemctl restart nginx", { workingDir: workspace })
      expect(sudoAuth.decision).toBe("APPROVAL_REQUIRED")
      expect(sudoAuth.riskCategory).toBe("privileged_system")
    })

    it("requires approval for sensitive credential access (.env, ~/.ssh)", () => {
      const envAuth = evaluateShellAuthorization("cat .env", { workingDir: workspace })
      expect(envAuth.decision).toBe("APPROVAL_REQUIRED")
      expect(envAuth.riskCategory).toBe("sensitive_data")

      const sshAuth = evaluateShellAuthorization("head -n 2 ~/.ssh/id_rsa", { workingDir: workspace })
      expect(sshAuth.decision).toBe("APPROVAL_REQUIRED")
      expect(sshAuth.riskCategory).toBe("sensitive_data")
    })

    it("requires critical approval for catastrophic deletion outside workspace", () => {
      const rmRootAuth = evaluateShellAuthorization("rm -rf /", { workingDir: workspace })
      expect(rmRootAuth.decision).toBe("APPROVAL_REQUIRED")
      expect(rmRootAuth.riskLevel).toBe("critical")
      expect(rmRootAuth.riskCategory).toBe("destructive_external")

      const rmExtAuth = evaluateShellAuthorization("rm -rf /var/log", { workingDir: workspace })
      expect(rmExtAuth.decision).toBe("APPROVAL_REQUIRED")
      expect(rmExtAuth.riskCategory).toBe("destructive_external")
    })
  })

  describe("3. Command Substitution & Pipeline Escalation", () => {
    it("escalates nested dangerous command in substitution $(git push ...)", () => {
      const cmd = 'res=$(git push origin main)'
      const auth = evaluateShellAuthorization(cmd, { workingDir: workspace })
      expect(auth.decision).toBe("APPROVAL_REQUIRED")
      expect(auth.riskCategory).toBe("external_git")
    })

    it("takes highest risk in pipeline (safe pipe dangerous)", () => {
      const cmd = "echo 'foo' && git push origin feat"
      const auth = evaluateShellAuthorization(cmd, { workingDir: workspace })
      expect(auth.decision).toBe("APPROVAL_REQUIRED")
      expect(auth.riskCategory).toBe("external_git")
    })

    it("keeps safe pipeline as ALLOW", () => {
      const cmd = "git rev-parse HEAD | cat | grep '0b5'"
      const auth = evaluateShellAuthorization(cmd, { workingDir: workspace })
      expect(auth.decision).toBe("ALLOW")
    })
  })

  describe("4. Pseudo-device redirect regression (fix: /dev/null false positive)", () => {
    // These must ALL be ALLOW — 2>/dev/null is not a sensitive /dev/ access.
    const benignCases = [
      "ls src/ 2>/dev/null",
      "cat package.json 2>/dev/null",
      "find src -type f 2>/dev/null",
      "echo x >/dev/null",
      "echo x 1>/dev/null",
      "echo x 2>/dev/null",
      "echo x >/dev/null 2>&1",
      "command >/dev/null 2>&1",
      "ls src/ 2>/dev/null; echo '---'; ls src/services/ 2>/dev/null",
    ]

    for (const cmd of benignCases) {
      it(`allows: ${cmd}`, () => {
        const auth = evaluateShellAuthorization(cmd, { workingDir: workspace })
        expect(auth.decision).toBe("ALLOW")
        expect(auth.riskCategory).not.toBe("sensitive_data")
      })
    }

    it("the exact compound command from the incident does not trigger sensitive_data", () => {
      const cmd = [
        'ls src/ 2>/dev/null; echo "---"; ls src/services/ 2>/dev/null; echo "---";',
        'ls tests/audit/ 2>/dev/null; echo "---"; ls .codebase/ 2>/dev/null | head;',
        'echo "---STATE---"; cat .codebase/STATE.md 2>/dev/null | head -50',
      ].join(" ")
      const auth = evaluateShellAuthorization(cmd, { workingDir: workspace })
      expect(auth.decision).toBe("ALLOW")
      expect(auth.sensitiveMatches).toHaveLength(0)
    })

    it("does NOT whitelist genuine /dev/ device access (e.g. /dev/sda)", () => {
      const auth = evaluateShellAuthorization("dd if=/dev/sda of=/tmp/disk.img", { workingDir: workspace })
      // /dev/sda is not a benign pseudo-device — still flagged as sensitive
      expect(auth.decision).toBe("APPROVAL_REQUIRED")
      expect(auth.riskCategory).toBe("sensitive_data")
    })

    it("does NOT whitelist reads of real /dev/ character devices via cat", () => {
      const auth = evaluateShellAuthorization("cat /dev/sda1", { workingDir: workspace })
      expect(auth.decision).toBe("APPROVAL_REQUIRED")
    })

    it("still requires approval for real sensitive paths alongside /dev/null redirect", () => {
      const auth = evaluateShellAuthorization("cat .env 2>/dev/null", { workingDir: workspace })
      expect(auth.decision).toBe("APPROVAL_REQUIRED")
      expect(auth.riskCategory).toBe("sensitive_data")
    })
  })
})
