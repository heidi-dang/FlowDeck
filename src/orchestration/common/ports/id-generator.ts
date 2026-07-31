/**
 * ID generator port.
 *
 * Abstracts identifier generation so domain logic is not coupled to
 * any specific ID scheme (UUID, snowflake, etc.).
 */

export interface IdGenerator {
  /** Returns a unique string identifier. */
  generate(): string
}
