/**
 * Build/Deploy Guard Classifier Tests
 *
 * Verifies:
 * - python3 and heredocs are classified as local scripting
 * - cat and file operations are not deployment
 * - npm publish is correctly classified as publish
 * - docker push is correctly classified as deploy
 * - kubectl apply is correctly classified as deploy
 * - Build commands (npm run build) are classified as build
 * - Diagnostics report the matched category and rule
 */

import { describe, it, expect } from "vitest"
import { extractExecutable, classifyCommand } from "../src/hooks/guard-rails"

describe("extractExecutable", () => {
  it("extracts python3 from python3 <<EOF", () => {
    expect(extractExecutable("python3 <<EOF\n...\nEOF")).toBe("python3")
  })

  it("extracts python3 from python3 <<'PYEOF'", () => {
    expect(extractExecutable("python3 <<'PYEOF'\nprint('hello')\nPYEOF")).toBe("python3")
  })

  it("extracts cat from cat <<EOF", () => {
    expect(extractExecutable("cat <<EOF > file.txt\ncontent\nEOF")).toBe("cat")
  })

  it("strips sudo prefix", () => {
    expect(extractExecutable("sudo npm publish")).toBe("npm")
  })

  it("strips env vars", () => {
    expect(extractExecutable("NODE_ENV=production npm run build")).toBe("npm")
  })

  it("strips path prefix", () => {
    expect(extractExecutable("/usr/local/bin/node script.js")).toBe("node")
  })

  it("handles simple commands", () => {
    expect(extractExecutable("node script.js")).toBe("node")
    expect(extractExecutable("npm test")).toBe("npm")
    expect(extractExecutable("bash script.sh")).toBe("bash")
  })
})

describe("classifyCommand - local scripting (never blocked)", () => {
  it("python3 with heredoc is local", () => {
    const result = classifyCommand("python3 <<'PYEOF'\nimport sys\nprint('hello')\nPYEOF")
    expect(result.category).toBe("local")
    expect(result.executable).toBe("python3")
  })

  it("python3 script is local", () => {
    const result = classifyCommand("python3 script.py")
    expect(result.category).toBe("local")
  })

  it("cat heredoc is local", () => {
    const result = classifyCommand("cat <<EOF > file.txt\ncontent\nEOF")
    expect(result.category).toBe("local")
    expect(result.executable).toBe("cat")
  })

  it("sed is local", () => {
    const result = classifyCommand("sed -i 's/old/new/g' file.txt")
    expect(result.category).toBe("local")
  })

  it("awk is local", () => {
    const result = classifyCommand("awk '{print $1}' file.txt")
    expect(result.category).toBe("local")
  })

  it("grep is local", () => {
    const result = classifyCommand("grep pattern file.txt")
    expect(result.category).toBe("local")
  })

  it("tee is local", () => {
    const result = classifyCommand("echo 'content' | tee file.txt")
    expect(result.category).toBe("local")
  })

  it("cp is local", () => {
    const result = classifyCommand("cp source.txt dest.txt")
    expect(result.category).toBe("local")
  })

  it("mv is local", () => {
    const result = classifyCommand("mv old.txt new.txt")
    expect(result.category).toBe("local")
  })

  it("echo is local", () => {
    const result = classifyCommand("echo 'hello world'")
    expect(result.category).toBe("local")
  })

  it("npm install is local (not publish)", () => {
    const result = classifyCommand("npm install")
    expect(result.category).toBe("local")
  })

  it("npm ci is local", () => {
    const result = classifyCommand("npm ci")
    expect(result.category).toBe("local")
  })

  it("npm test is local", () => {
    const result = classifyCommand("npm test")
    expect(result.category).toBe("local")
  })

  it("bun install is local", () => {
    const result = classifyCommand("bun install")
    expect(result.category).toBe("local")
  })

  it("git push is local (source control, not deployment)", () => {
    const result = classifyCommand("git push origin main")
    expect(result.category).toBe("local")
  })

  it("pip install is local", () => {
    const result = classifyCommand("pip install requests")
    expect(result.category).toBe("local")
  })

  it("docker build is local (not deployment)", () => {
    const result = classifyCommand("docker build -t myapp:latest .")
    expect(result.category).toBe("local")
  })

  it("docker run is local", () => {
    const result = classifyCommand("docker run -it alpine sh")
    expect(result.category).toBe("local")
  })

  it("node script is local", () => {
    const result = classifyCommand("node scripts/generate-config.js")
    expect(result.category).toBe("local")
  })

  it("bash script is local", () => {
    const result = classifyCommand("bash scripts/deploy.sh")
    expect(result.category).toBe("local")
  })

  it("file reading is local", () => {
    const result = classifyCommand("head -n 100 file.txt")
    expect(result.category).toBe("local")
  })

  it("JSON generation is local", () => {
    const result = classifyCommand("node -e \"console.log(JSON.stringify({a:1}))\"")
    expect(result.category).toBe("local")
  })

  it("ls is local", () => {
    const result = classifyCommand("ls -la")
    expect(result.category).toBe("local")
  })
})

describe("classifyCommand - heredoc content should NOT trigger", () => {
  it("heredoc containing npm publish text is still local", () => {
    const cmd = `python3 <<'PYEOF'
# This script runs npm publish
import os
os.system("npm publish")
PYEOF`
    const result = classifyCommand(cmd)
    // The executable is python3, so it's local
    expect(result.category).toBe("local")
    expect(result.executable).toBe("python3")
  })

  it("heredoc containing docker push is still local", () => {
    const cmd = `cat <<EOF
To deploy: docker push myapp:latest
Then: kubectl apply -f k8s/
EOF`
    const result = classifyCommand(cmd)
    expect(result.category).toBe("local")
    expect(result.executable).toBe("cat")
  })
})

describe("classifyCommand - build (informational)", () => {
  it("npm run build is build category", () => {
    const result = classifyCommand("npm run build")
    expect(result.category).toBe("build")
  })

  it("bun run build is build", () => {
    const result = classifyCommand("bun run build")
    expect(result.category).toBe("build")
  })

  it("npm run build --production is build", () => {
    const result = classifyCommand("npm run build -- --production")
    expect(result.category).toBe("build")
  })
})

describe("classifyCommand - publish (requires approval)", () => {
  it("npm publish is publish category", () => {
    const result = classifyCommand("npm publish")
    expect(result.category).toBe("publish")
    expect(result.reason).toContain("npm publish")
  })

  it("npm publish --tag next is publish", () => {
    const result = classifyCommand("npm publish --tag next")
    expect(result.category).toBe("publish")
  })

  it("bun publish is publish", () => {
    const result = classifyCommand("bun publish")
    expect(result.category).toBe("publish")
  })

  it("cargo publish is publish", () => {
    const result = classifyCommand("cargo publish")
    expect(result.category).toBe("publish")
  })
})

describe("classifyCommand - deploy (requires approval)", () => {
  it("docker push is deploy", () => {
    const result = classifyCommand("docker push myapp:latest")
    expect(result.category).toBe("deploy")
  })

  it("kubectl apply is deploy", () => {
    const result = classifyCommand("kubectl apply -f k8s/deployment.yaml")
    expect(result.category).toBe("deploy")
  })

  it("terraform apply is deploy", () => {
    const result = classifyCommand("terraform apply -auto-approve")
    expect(result.category).toBe("deploy")
  })

  it("gh release create is deploy", () => {
    const result = classifyCommand("gh release create v1.0.0")
    expect(result.category).toBe("deploy")
  })

  it("helm upgrade is deploy", () => {
    const result = classifyCommand("helm upgrade myapp ./chart")
    expect(result.category).toBe("deploy")
  })
})

describe("classifyCommand - diagnostics", () => {
  it("includes executable in report", () => {
    const result = classifyCommand("npm publish")
    expect(result.executable).toBe("npm")
  })

  it("includes reason describing the match", () => {
    const result = classifyCommand("npm publish")
    expect(result.reason).toBeTruthy()
  })

  it("local commands have a reason", () => {
    const result = classifyCommand("python3 script.py")
    expect(result.reason).toContain("local operation")
  })
})
