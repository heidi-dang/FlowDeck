#!/usr/bin/env node
/**
 * Run the doctor service with full CLI support.
 *
 * @param {string} directory - Package root directory
 * @param {object} options
 * @param {boolean} [options.json] - Output JSON (default false)
 * @param {boolean} [options.strict] - Fail on warnings (default false)
 * @param {boolean} [options.verbose] - Include additional detail (default false)
 * @param {boolean} [options.applyRecommended] - Apply safe auto-fixes (default false)
 * @param {string} [options.profile] - Named profile to use (default null)
 * @returns {Promise<{ report: object, exitCode: number, stdout: string, stderr: string }>}
 */
export function runDoctorService(directory: string, options?: {
    json?: boolean | undefined;
    strict?: boolean | undefined;
    verbose?: boolean | undefined;
    applyRecommended?: boolean | undefined;
    profile?: string | undefined;
}): Promise<{
    report: object;
    exitCode: number;
    stdout: string;
    stderr: string;
}>;
export const SCHEMA_VERSION: 1;
export const EXIT_HEALTHY: 0;
export const EXIT_FAILURE: 1;
export const EXIT_ERROR: 2;
//# sourceMappingURL=doctor-service.d.mts.map