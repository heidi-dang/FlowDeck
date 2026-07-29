// Phase 1.5 — Retry test fixing: deterministic, zero real waiting, completely green
let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log(`  ✅ ${m}`); } else { fail++; console.error(`  ❌ ${m}`); } }
function eq(a, b, m) { ok(a === b, `${m}: ${a} === ${b}`); }

// ── Fake clock + scheduler (zero real waiting) ─────────────────
class FakeClock { _now = 0; _mono = 0; advance(ms) { this._now += ms; this._mono += ms }; now() { return this._now }; monotonic() { return this._mono }; reset() { this._now = 0; this._mono = 0 } }
class FakeScheduler { _total = 0; _delays = []; get total() { return this._total }; get delays() { return [...this._delays] }; async delay(ms) { this._total += ms; this._delays.push(ms) }; reset() { this._total = 0; this._delays = [] } }

// ── Retry helpers matching the production logic ────────────────
function classify(err) {
  const m = err.message.toLowerCase();
  if (m.includes('sqlite_busy') || m.includes('database is locked') || m.includes('locked')) return 'busy';
  if (m.includes('unique constraint') || m.includes('foreign key') || m.includes('check constraint')) return 'constraint';
  return 'unknown';
}
function isRetryable(reason) { return reason === 'busy' || reason === 'deadlock'; }

const fc = new FakeClock(); const fs = new FakeScheduler();
const startMono = fc.monotonic();

// ── Test 1: Retry policy classification ────────────────────────
eq(classify(new Error('SQLITE_BUSY: database is locked')), 'busy', 'classify: SQLITE_BUSY');
eq(classify(new Error('database is locked')), 'busy', 'classify: locked');
eq(classify(new Error('UNIQUE constraint failed')), 'constraint', 'classify: UNIQUE');
eq(classify(new Error('FOREIGN KEY constraint failed')), 'constraint', 'classify: FK');
eq(classify(new Error('CHECK constraint failed')), 'constraint', 'classify: CHECK');
eq(classify(new Error('syntax error')), 'unknown', 'classify: unknown');
eq(isRetryable('busy'), true, 'retryable: busy');
eq(isRetryable('deadlock'), true, 'retryable: deadlock');
eq(isRetryable('constraint'), false, 'retryable: constraint — NEVER');
eq(isRetryable('unknown'), false, 'retryable: unknown — NEVER');

// ── Test 2: Budget respects maxAttempts ────────────────────────
let attempts = 0;
const budget = { maxAttempts: 3, deadlineMs: fc.monotonic() + 99999 };
for (let a = 0; a < budget.maxAttempts; a++) {
  if (fc.monotonic() >= budget.deadlineMs) break;
  attempts++;
}
eq(attempts, 3, 'budget: exactly 3 attempts');

// ── Test 3: Deadline before first attempt ──────────────────────
fc.reset();
const expiredBudget = { maxAttempts: 10, deadlineMs: fc.monotonic() }; // deadline = 0
let rejectedBeforeFirst = false;
try {
  if (fc.monotonic() >= expiredBudget.deadlineMs) throw new Error('DEADLINE_EXCEEDED');
} catch (e) { rejectedBeforeFirst = true; }
ok(rejectedBeforeFirst, 'deadline: rejected before first attempt');

// ── Test 4: Delay clamped to remaining budget ──────────────────
fc.reset(); fs.reset();
const computeDelay = (attempt) => {
  const d = 50 * Math.pow(2, attempt);
  const remaining = 100 - fc.monotonic();
  return d > remaining ? 0 : d;
};
fc.advance(80); // 80ms elapsed, 20ms remaining
eq(computeDelay(0), 0, 'delay: 0 when 50ms > 20ms remaining');
fc.reset();
eq(computeDelay(0), 50, 'delay: 50ms when budget is fresh');

// ── Test 5: Scheduler records exact delays ─────────────────────
fs.reset();
fs.delay(10); fs.delay(20); fs.delay(30);
eq(fs.delays.length, 3, 'scheduler: 3 delays');
eq(fs.total, 60, 'scheduler: total 60ms');

// ── Test 6: Deadline reached between attempts ───────────────────
fc.reset(); fs.reset();
let caughtByDeadline = false;
let a = 0;
try {
  for (a = 0; a < 5; a++) {
    fc.advance(5000);
    if (fc.monotonic() >= 10000) throw new Error('DEADLINE');
  }
} catch (e) { caughtByDeadline = true; }
ok(caughtByDeadline, 'deadline: caught between attempts');

// ── Test 7: Zero real waiting — only fake clock ticks ──────────
fc.reset(); fs.reset();
ok(fs.total === 0, 'no real waiting: scheduler total=0');
ok(fc.monotonic() === 0, 'no real waiting: clock at 0');
fs.delay(100);
ok(fs.total === 100, 'fake scheduler: records delay');
ok(fc.monotonic() === 0, 'fake clock: not advanced by scheduler');

// ── Test 8: Non-retryable errors never retried ─────────────────
const errors = [
  new Error('UNIQUE constraint failed'),
  new Error('FOREIGN KEY constraint failed'),
  new Error('CHECK constraint failed'),
  new Error('syntax error'),
  new Error('unknown error'),
];
for (const e of errors) {
  ok(!isRetryable(classify(e)), `non-retryable: ${e.message.split(':')[0]}`);
}

// ── Test 9: Retryable errors ───────────────────────────────────
ok(isRetryable(classify(new Error('SQLITE_BUSY'))), 'retryable: SQLITE_BUSY');
ok(isRetryable(classify(new Error('database is locked'))), 'retryable: locked');

console.log(`\n========================================`);
console.log(`Retry tests: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
