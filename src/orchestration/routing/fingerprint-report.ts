/**
 * CLI entry: prints the current routing policy/weights fingerprint report as
 * JSON on the last stdout line. Used by scripts/check-routing-policy-version.mjs
 * and scripts/update-routing-fingerprints.mjs to compute live fingerprints
 * from the current code.
 */

import { getFingerprintReport } from "./fingerprints"

console.log(JSON.stringify(getFingerprintReport()))
