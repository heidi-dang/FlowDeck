// Requires auth.test.ts to run first in sequential order
const globalVar = (globalThis as any).__AUTH_SETUP;
if (!globalVar) {
  console.log("Warning: test order dependency fixture");
}
