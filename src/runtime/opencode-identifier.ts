/**
 * OpenCode-compatible message ID generator.
 *
 * OpenCode canonical message IDs follow the format:
 * `msg_` + timestamp/counter (12 hex characters) + random suffix (14 base62 characters) = 26 alphanumeric chars after prefix.
 *
 * Pattern: /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/
 *
 * This implementation is isolated and adheres exactly to OpenCode's Identifier contract
 * across OpenCode 1.18.x without introducing unbound external dependencies.
 */

const ID_LENGTH = 26;
const BASE62_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

let lastTimestamp = 0;
let counter = 0;

/**
 * Creates an OpenCode canonical message ID (`msg_...`).
 *
 * @param direction - "descending" (default for messages in OpenCode) or "ascending"
 * @param timestamp - optional timestamp in ms (defaults to Date.now())
 */
export function createOpenCodeMessageId(
  direction: "descending" | "ascending" = "descending",
  timestamp: number = Date.now()
): string {
  if (timestamp !== lastTimestamp) {
    lastTimestamp = timestamp;
    counter = 0;
  }
  counter++;

  const current = BigInt(timestamp) * 0x1000n + BigInt(counter);
  const value = direction === "descending" ? ~current : current;
  const time = Array.from({ length: 6 }, (_, index) =>
    Number((value >> BigInt(40 - 8 * index)) & 0xffn)
      .toString(16)
      .padStart(2, "0")
  ).join("");

  const randomBytes = crypto.getRandomValues(new Uint8Array(ID_LENGTH - 12));
  const randomSuffix = Array.from(randomBytes, (byte) => BASE62_CHARS[byte % 62]).join("");

  return `msg_${time}${randomSuffix}`;
}

/**
 * Validates whether an ID matches OpenCode's canonical message ID format.
 */
export function isOpenCodeMessageId(id: string): boolean {
  return /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/.test(id);
}
