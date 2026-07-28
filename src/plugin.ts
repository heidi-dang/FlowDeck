/**
 * FlowDeck Plugin Entry — dedicated export for OpenCode plugin loading.
 *
 * This file exports ONLY the OpenCode-compatible plugin object.
 * It does NOT export library utilities, diagnostic functions, or any
 * named exports that could confuse the plugin loader.
 *
 * Library consumers should import from the root barrel (src/index.ts)
 * or the @heidi-dang/flowdeck/api subpath.
 */

export { default } from "./index";
