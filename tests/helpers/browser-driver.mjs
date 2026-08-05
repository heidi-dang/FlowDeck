/**
 * Browser driver for the real Playwright E2E suite.
 *
 * Runs under NODE, not Bun: Bun's child-process pipe implementation on
 * Windows does not complete Playwright's `--remote-debugging-pipe` CDP
 * handshake (oven-sh/bun#31105, #27977), so `chromium.launch()` hangs forever
 * under `bun test` on Windows while succeeding under Node on the same
 * machine. The E2E test spawns this driver with `node` and drives it with
 * line-delimited JSON commands over stdin/stdout.
 *
 * Protocol (one JSON object per line):
 *   in:  {"id":N,"cmd":"launch"}
 *        {"id":N,"cmd":"open","url":U,"readySelector":S,"timeout":ms}
 *        {"id":N,"cmd":"waitForSelector","selector":S,"timeout":ms}
 *        {"id":N,"cmd":"textContent","selector":S}
 *        {"id":N,"cmd":"innerText","selector":S}
 *        {"id":N,"cmd":"count","selector":S}
 *        {"id":N,"cmd":"evaluate","expr":JS}
 *        {"id":N,"cmd":"emulateMedia","reducedMotion":"reduce"}
 *        {"id":N,"cmd":"setViewport","width":W,"height":H}
 *        {"id":N,"cmd":"press","key":K}
 *        {"id":N,"cmd":"closePage"}
 *        {"id":N,"cmd":"close"}
 *   out: {"id":N,"ok":true,"value":...} | {"id":N,"ok":false,"error":"..."}
 *
 * On exit (including SIGTERM) the browser process tree is closed, so no
 * orphan chromium remains after the test tears the driver down.
 */

import { chromium } from "playwright";

let browser = null;
let page = null;

async function closeAllBounded() {
  try {
    if (page) {
      await Promise.race([page.close().catch(() => {}), new Promise((r) => setTimeout(r, 2000))]);
      page = null;
    }
  } catch { /* ignore */ }
  try {
    if (browser) {
      await Promise.race([browser.close().catch(() => {}), new Promise((r) => setTimeout(r, 3000))]);
      browser = null;
    }
  } catch { /* ignore */ }
}

async function handleLaunch() {
  browser = await chromium.launch({
    headless: true,
    args: ["--disable-gpu", "--no-sandbox", "--disable-dev-shm-usage"],
  });
  return { value: true };
}

async function handleOpen(cmd) {
  if (!browser) throw new Error("browser not launched");
  await handleClosePage();
  const ctx = browser.contexts()[0] ?? (await browser.newContext());
  page = await ctx.newPage();
  await page.goto(cmd.url, { timeout: cmd.timeout ?? 15000, waitUntil: "domcontentloaded" });
  if (cmd.readySelector) {
    await page.waitForSelector(cmd.readySelector, { timeout: cmd.timeout ?? 10000 });
  }
  return { value: true };
}

async function handleWaitForSelector(cmd) {
  if (!page) throw new Error("no open page");
  await page.waitForSelector(cmd.selector, { timeout: cmd.timeout ?? 10000 });
  return { value: true };
}

async function handleTextContent(cmd) {
  if (!page) throw new Error("no open page");
  return { value: await page.locator(cmd.selector).textContent() };
}

async function handleInnerText(cmd) {
  if (!page) throw new Error("no open page");
  if (cmd.selector) {
    return { value: await page.locator(cmd.selector).innerText() };
  }
  return { value: await page.evaluate(() => document.body.innerText) };
}

async function handleCount(cmd) {
  if (!page) throw new Error("no open page");
  return { value: await page.locator(cmd.selector).count() };
}

async function handleVisible(cmd) {
  if (!page) throw new Error("no open page");
  return { value: await page.locator(cmd.selector).isVisible() };
}

async function handleEvaluate(cmd) {
  if (!page) throw new Error("no open page");
  return { value: await page.evaluate(cmd.expr) };
}

async function handleEmulateMedia(cmd) {
  if (!page) throw new Error("no open page");
  await page.emulateMedia({ reducedMotion: cmd.reducedMotion });
  return { value: true };
}

async function handleSetViewport(cmd) {
  if (!page) throw new Error("no open page");
  await page.setViewportSize({ width: cmd.width, height: cmd.height });
  return { value: true };
}

async function handlePress(cmd) {
  if (!page) throw new Error("no open page");
  await page.keyboard.press(cmd.key);
  return { value: true };
}

async function handleClosePage() {
  if (page) {
    await page.close().catch(() => {});
    page = null;
  }
  return { value: true };
}

async function handleClose() {
  await closeAllBounded();
  return { value: true };
}

const HANDLERS = {
  launch: handleLaunch,
  open: handleOpen,
  waitForSelector: handleWaitForSelector,
  textContent: handleTextContent,
  innerText: handleInnerText,
  count: handleCount,
  visible: handleVisible,
  evaluate: handleEvaluate,
  emulateMedia: handleEmulateMedia,
  setViewport: handleSetViewport,
  press: handlePress,
  closePage: handleClosePage,
  close: handleClose,
};

function respond(id, payload) {
  process.stdout.write(JSON.stringify({ id, ...payload }) + "\n");
}

process.stdin.setEncoding("utf-8");
let buffer = "";
process.stdin.on("data", async (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf("\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    newline = buffer.indexOf("\n");
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      respond(-1, { ok: false, error: "malformed command" });
      continue;
    }
    try {
      const handler = HANDLERS[msg.cmd];
      if (!handler) throw new Error(`unknown command: ${msg.cmd}`);
      const result = await handler(msg);
      respond(msg.id, { ok: true, ...result });
    } catch (err) {
      respond(msg.id, { ok: false, error: err?.message ?? String(err) });
    }
  }
});

process.on("SIGTERM", async () => {
  await closeAllBounded();
  process.exit(0);
});

process.on("exit", () => {
  // Last-resort cleanup if the process is killed before 'close' arrives.
  if (browser) {
    browser.close().catch(() => {});
  }
});

// Heartbeat so a wedged driver is detectable by the test.
const heartbeat = setInterval(() => {
  process.stdout.write(":hb\n");
}, 5000);
process.stdin.on("end", () => {
  clearInterval(heartbeat);
});
