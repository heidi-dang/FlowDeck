/**
 * Build/Deploy Guard Classifier Tests
 *
 * Verifies compound-command parsing, heredoc exclusion, and
 * executable-based classification for all shell syntax.
 */

import { describe, it, expect } from "vitest"
import {
  extractExecutable,
  classifyCommand,
  stripHeredocBodies,
  splitTopLevelSegments,
} from "../src/hooks/guard-rails"

// ─── extractExecutable ─────────────────────────────────────────────────

describe("extractExecutable", () => {
  it("extracts python3 from python3 <<EOF", () => {
    expect(extractExecutable("python3 <<EOF\n...\nEOF")).toBe("python3")
  })
  it("extracts python3 from python3 <<'PYEOF'", () => {
    expect(extractExecutable("python3 <<'PYEOF'\nprint('hello')\nPYEOF")).toBe("python3")
  })
  it("strips sudo", () => expect(extractExecutable("sudo npm publish")).toBe("npm"))
  it("strips env vars", () => expect(extractExecutable("NODE_ENV=production npm run build")).toBe("npm"))
  it("strips path", () => expect(extractExecutable("/usr/local/bin/node script.js")).toBe("node"))
  it("handles ./scripts", () => expect(extractExecutable("./scripts/deploy.sh")).toBe("deploy.sh"))
  it("simple commands", () => {
    expect(extractExecutable("node script.js")).toBe("node")
    expect(extractExecutable("npm test")).toBe("npm")
  })
})

// ─── stripHeredocBodies ─────────────────────────────────────────────────

describe("stripHeredocBodies", () => {
  it("removes inline heredoc body", () => {
    const cmd = `python3 <<'PYEOF'\nprint("hello")\nPYEOF`
    const result = stripHeredocBodies(cmd)
    expect(result).toContain("python3 <<'PYEOF'")
    expect(result).not.toContain('print("hello")')
  })

  it("removes multiple heredocs", () => {
    const cmd = `cat <<EOF\ncontent\nEOF\nnpm publish`
    const result = stripHeredocBodies(cmd)
    expect(result).toContain("npm publish")
    expect(result).not.toContain("content")
  })

  it("preserves non-heredoc text", () => {
    expect(stripHeredocBodies("npm publish")).toBe("npm publish")
  })

  it("handles heredoc with dash", () => {
    const cmd = `cat <<-EOF\n  indented\nEOF`
    const result = stripHeredocBodies(cmd)
    expect(result).not.toContain("indented")
    expect(result).toContain("cat <<-EOF")
  })
})

// ─── splitTopLevelSegments ─────────────────────────────────────────────

describe("splitTopLevelSegments", () => {
  it("splits on &&", () => {
    const segs = splitTopLevelSegments("python3 check.py && npm publish")
    expect(segs).toHaveLength(2)
    expect(segs[0]).toContain("python3")
    expect(segs[1]).toContain("npm publish")
  })

  it("splits on ;", () => {
    const segs = splitTopLevelSegments("python3 check.py ; npm publish")
    expect(segs).toHaveLength(2)
    expect(segs[1]).toContain("npm publish")
  })

  it("splits on ||", () => {
    const segs = splitTopLevelSegments("python3 check.py || npm publish")
    expect(segs).toHaveLength(2)
    expect(segs[1]).toContain("npm publish")
  })

  it("splits on |", () => {
    const segs = splitTopLevelSegments("cat file | python3")
    expect(segs).toHaveLength(2)
    expect(segs[0]).toContain("cat file")
    expect(segs[1]).toContain("python3")
  })

  it("does not split inside quotes", () => {
    const segs = splitTopLevelSegments("echo 'hello && world'")
    expect(segs).toHaveLength(1)
  })

  it("returns single segment for simple command", () => {
    expect(splitTopLevelSegments("npm publish")).toEqual(["npm publish"])
  })
})

// ─── classifyCommand: simple commands (single segment) ─────────────────

describe("classifyCommand - simple local scripting (never blocked)", () => {
  it("python3 is local", () => {
    expect(classifyCommand("python3 script.py").category).toBe("local")
  })
  it("cat is local", () => {
    expect(classifyCommand("cat <<EOF > file.txt\ncontent\nEOF").category).toBe("local")
  })
  it("sed is local", () => expect(classifyCommand("sed -i 's/old/new/g' file.txt").category).toBe("local"))
  it("awk is local", () => expect(classifyCommand("awk '{print $1}' file.txt").category).toBe("local"))
  it("grep is local", () => expect(classifyCommand("grep pattern file.txt").category).toBe("local"))
  it("tee is local", () => expect(classifyCommand("echo content | tee file.txt").category).toBe("local"))
  it("cp is local", () => expect(classifyCommand("cp source.txt dest.txt").category).toBe("local"))
  it("mv is local", () => expect(classifyCommand("mv old.txt new.txt").category).toBe("local"))
  it("echo is local", () => expect(classifyCommand("echo hello").category).toBe("local"))
  it("npm install is local", () => expect(classifyCommand("npm install").category).toBe("local"))
  it("npm ci is local", () => expect(classifyCommand("npm ci").category).toBe("local"))
  it("npm test is local", () => expect(classifyCommand("npm test").category).toBe("local"))
  it("bun install is local", () => expect(classifyCommand("bun install").category).toBe("local"))
  it("git push is local", () => expect(classifyCommand("git push origin main").category).toBe("local"))
  it("pip install is local", () => expect(classifyCommand("pip install requests").category).toBe("local"))
  it("docker build is local", () => expect(classifyCommand("docker build -t myapp .").category).toBe("local"))
  it("node script is local", () => expect(classifyCommand("node scripts/generate-config.js").category).toBe("local"))
  it("bash script is local", () => expect(classifyCommand("bash scripts/analysis.sh").category).toBe("local"))
  it("ls is local", () => expect(classifyCommand("ls -la").category).toBe("local"))
  it("python3 heredoc with npm publish text is local", () => {
    const cmd = "python3 <<'PYEOF'\nos.system('npm publish')\nPYEOF"
    expect(classifyCommand(cmd).category).toBe("local")
  })
})

describe("classifyCommand - build (informational, no approval)", () => {
  it("npm run build", () => expect(classifyCommand("npm run build").category).toBe("build"))
  it("bun run build", () => expect(classifyCommand("bun run build").category).toBe("build"))
  it("make", () => expect(classifyCommand("make").category).toBe("build"))
})

describe("classifyCommand - publish (requires approval)", () => {
  it("npm publish", () => {
    const r = classifyCommand("npm publish")
    expect(r.category).toBe("publish")
    expect(r.reason).toContain("npm publish")
  })
  it("npm publish --tag next", () => expect(classifyCommand("npm publish --tag next").category).toBe("publish"))
  it("bun publish", () => expect(classifyCommand("bun publish").category).toBe("publish"))
  it("cargo publish", () => expect(classifyCommand("cargo publish").category).toBe("publish"))
})

describe("classifyCommand - deploy (requires approval)", () => {
  it("docker push", () => expect(classifyCommand("docker push myapp:latest").category).toBe("deploy"))
  it("docker compose up", () => expect(classifyCommand("docker compose up").category).toBe("deploy"))
  it("kubectl apply", () => expect(classifyCommand("kubectl apply -f k8s/deploy.yaml").category).toBe("deploy"))
  it("terraform apply", () => expect(classifyCommand("terraform apply -auto-approve").category).toBe("deploy"))
  it("gh release create", () => expect(classifyCommand("gh release create v1.0.0").category).toBe("deploy"))
  it("helm upgrade", () => expect(classifyCommand("helm upgrade myapp ./chart").category).toBe("deploy"))
  it("deploy script", () => expect(classifyCommand("./scripts/deploy.sh").category).toBe("deploy"))
})

// ─── classifyCommand: compound commands ─────────────────────────────────

describe("classifyCommand - compound commands", () => {
  it("python3 check.py && npm publish → publish", () => {
    const r = classifyCommand("python3 check.py && npm publish")
    expect(r.category).toBe("publish")
  })

  it("python3 check.py ; npm publish → publish", () => {
    const r = classifyCommand("python3 check.py ; npm publish")
    expect(r.category).toBe("publish")
  })

  it("python3 check.py || npm publish → publish", () => {
    const r = classifyCommand("python3 check.py || npm publish")
    expect(r.category).toBe("publish")
  })

  it("npm test && npm run build → build", () => {
    const r = classifyCommand("npm test && npm run build")
    expect(r.category).toBe("build")
  })

  it("publish + deploy in sequence → publish (highest risk)", () => {
    const r = classifyCommand("npm publish && docker push myapp:latest")
    expect(r.category).toBe("publish")
  })

  it("three segments with local first → publish wins", () => {
    const r = classifyCommand("python3 setup.py && npm test && npm publish")
    expect(r.category).toBe("publish")
  })

  it("pipe is not compound but each segment classified", () => {
    const r = classifyCommand("cat data.txt | python3 process.py")
    expect(r.category).toBe("local")
  })

  it("compound with deploy → deploy wins", () => {
    const r = classifyCommand("npm run build && kubectl apply -f k8s/")
    expect(r.category).toBe("deploy")
  })
})

describe("classifyCommand - shell wrappers", () => {
  it("bash deploy.sh → deploy", () => {
    const r = classifyCommand("bash deploy.sh")
    expect(r.category).toBe("deploy")
  })

  it("sh deploy.sh → deploy", () => {
    const r = classifyCommand("sh deploy.sh")
    expect(r.category).toBe("deploy")
  })

  it("bash analysis.sh → local", () => {
    const r = classifyCommand("bash analysis.sh")
    expect(r.category).toBe("local")
  })

  it("cat file | bash → local (not a script with deploy name)", () => {
    const r = classifyCommand("cat file | bash")
    expect(r.category).toBe("local")
  })
})

describe("classifyCommand - script paths", () => {
  it("./scripts/deploy.sh → deploy", () => {
    expect(classifyCommand("./scripts/deploy.sh").category).toBe("deploy")
  })

  it("./publish.sh → publish", () => {
    expect(classifyCommand("./publish.sh").category).toBe("publish")
  })

  it("./build.sh → build", () => {
    expect(classifyCommand("./build.sh").category).toBe("build")
  })

  it("./scripts/test.sh → local", () => {
    expect(classifyCommand("./scripts/test.sh").category).toBe("local")
  })
})

describe("classifyCommand - heredoc content immunity", () => {
  it("python3 heredoc containing npm publish text is local", () => {
    const cmd = `python3 <<'PYEOF'\n# This is a script that publishes\nprint("npm publish")\nPYEOF`
    expect(classifyCommand(cmd).category).toBe("local")
  })

  it("python3 heredoc containing docker push text is local", () => {
    const cmd = `python3 <<'PYEOF'\nprint("docker push myapp:latest")\nPYEOF`
    expect(classifyCommand(cmd).category).toBe("local")
  })

  it("node heredoc with build command is local", () => {
    const cmd = `node <<'EOF'\nconsole.log("npm run build")\nEOF`
    expect(classifyCommand(cmd).category).toBe("local")
  })
})

describe("classifyCommand - diagnostics", () => {
  it("includes executable in result", () => {
    expect(classifyCommand("npm publish").executable).toBe("npm")
  })

  it("compound result includes segment details", () => {
    const r = classifyCommand("python3 setup.py && npm publish") as any
    expect(r.segments).toBeDefined()
    expect(r.segments.length).toBeGreaterThanOrEqual(2)
  })

  it("returns reason describing the match", () => {
    expect(classifyCommand("npm publish").reason).toBeTruthy()
  })
})
