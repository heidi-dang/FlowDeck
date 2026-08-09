export type ProviderFailureClass = "schema_compatibility" | "rate_limit" | "server_transient" | "transport_transient" | "non_retryable"

export type ProviderFailureClassification = {
  category: ProviderFailureClass
  retryable: boolean
  rotateCredentials: boolean
  message: string
}

const GEMINI_SCHEMA_MARKERS = /GenerateContentRequest\.tools|function_declarations|functionDeclarations|(?:parameters|schema|properties|items|any_of|anyOf)/i

/**
 * Classify provider failures before generic retry/account-health logic sees
 * them. Gemini schema 400s are deterministic FlowDeck compatibility failures,
 * never transient transport failures.
 */
export function classifyProviderFailure(status: number | undefined, rawMessage: string): ProviderFailureClassification {
  const message = rawMessage.slice(0, 4000)
  if (status === 400 && GEMINI_SCHEMA_MARKERS.test(message)) {
    return {
      category: "schema_compatibility",
      retryable: false,
      rotateCredentials: false,
      message: "Provider rejected a tool schema; normalize and validate the Gemini declaration before retrying",
    }
  }
  if (status === 429) return { category: "rate_limit", retryable: true, rotateCredentials: false, message: "Provider rate limit" }
  if (status !== undefined && [500, 502, 503].includes(status)) return { category: "server_transient", retryable: true, rotateCredentials: false, message: "Provider server failure" }
  if (/timeout|timed out|connection reset|ECONNRESET|ETIMEDOUT/i.test(message)) return { category: "transport_transient", retryable: true, rotateCredentials: false, message: "Transient provider transport failure" }
  return { category: "non_retryable", retryable: false, rotateCredentials: false, message: "Non-retryable provider failure" }
}
