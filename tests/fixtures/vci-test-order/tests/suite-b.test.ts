const state = (globalThis as any).__SHARED_STATE;
if (!state?.initialized) {
  throw new Error("Suite B executed before Suite A: Order violation");
}
