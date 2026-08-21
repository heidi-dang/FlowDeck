const response = await fetch("http://127.0.0.1:4096/api/v1/sessions", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    title: "live test",
    provider: "anthropic",
    model: "claude-3-5-sonnet-latest"
  })
});
const data = await response.json();
const sessionId = data.id;
console.log("Session ID:", sessionId);

const promptRes = await fetch(`http://127.0.0.1:4096/api/v1/sessions/${sessionId}/prompt`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    message: `Conduct a deep code review of crates/fdx/. In parallel:
    - Have a reviewer check crates/fdx/src/reader/impact.rs for logical bugs.
    - Have a mapper outline the entire crates/fdx/src directory.
    - Have a security-auditor look for unsafe blocks in crates/fdx/src/.
    While they are working, directly list the files in crates/fdx/src yourself without waiting for them.`
  })
});
const p = await promptRes.json();
console.log("Prompt started:", p);
