/**
 * Clock port.
 *
 * Abstracts time so that domain logic is testable without wall-clock dependency.
 */

export interface Clock {
  /** Returns the current date/time. */
  now(): Date
}
