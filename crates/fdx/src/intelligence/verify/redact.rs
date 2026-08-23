//! Secret redaction before storing or serializing verification output.
//!
//! Redaction occurs before output is persisted to disk or emitted in reports.

use regex::Regex;
use std::sync::LazyLock;

static BEARER_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\bBearer\s+[A-Za-z0-9_\-\.]{8,}").expect("valid bearer regex")
});

static KV_SECRET_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)\b(api[_-]?key|access[_-]?key|secret[_-]?key|token|password|passwd|auth[_-]?token)\s*([:=])\s*(["']?)([^\s"',;]+)(["']?)"#)
        .expect("valid kv secret regex")
});

static OPENAI_KEY_REGEX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\bsk-[A-Za-z0-9]{20,}\b").expect("valid openai regex"));

static GITHUB_TOKEN_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b").expect("valid github regex")
});

static AWS_KEY_REGEX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\bAKIA[0-9A-Z]{16}\b").expect("valid aws key regex"));

static PRIVATE_KEY_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"-----BEGIN [A-Z ]+ PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+ PRIVATE KEY-----")
        .expect("valid private key regex")
});

/// Redact sensitive secrets from a string before persistence or display.
pub fn redact_secrets(input: &str) -> String {
    if input.is_empty() {
        return String::new();
    }

    let mut redacted = input.to_string();

    // 1. Private keys
    redacted = PRIVATE_KEY_REGEX
        .replace_all(&redacted, "[REDACTED PRIVATE KEY]")
        .into_owned();

    // 2. Bearer tokens
    redacted = BEARER_REGEX
        .replace_all(&redacted, "Bearer [REDACTED]")
        .into_owned();

    // 3. Known token formats (OpenAI, GitHub, AWS)
    redacted = OPENAI_KEY_REGEX
        .replace_all(&redacted, "sk-[REDACTED]")
        .into_owned();
    redacted = GITHUB_TOKEN_REGEX
        .replace_all(&redacted, "${1}_[REDACTED]")
        .into_owned();
    redacted = AWS_KEY_REGEX
        .replace_all(&redacted, "AKIA[REDACTED]")
        .into_owned();

    // 4. Key-value secrets (e.g. password = "xyz", API_KEY=abc)
    redacted = KV_SECRET_REGEX
        .replace_all(&redacted, "$1$2$3[REDACTED]$5")
        .into_owned();

    redacted
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_redact_bearer_token() {
        let text = "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9";
        let redacted = redact_secrets(text);
        assert_eq!(redacted, "Authorization: Bearer [REDACTED]");
    }

    #[test]
    fn test_redact_kv_secrets() {
        let text =
            "OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz123456\npassword: 'supersecretpassword'";
        let redacted = redact_secrets(text);
        assert!(redacted.contains("[REDACTED]"));
        assert!(!redacted.contains("supersecretpassword"));
        assert!(!redacted.contains("abcdefghijklmnopqrstuvwxyz123456"));
    }

    #[test]
    fn test_redact_github_and_aws() {
        let text = "ghp_1234567890abcdefghijklmnopqrstuv and AKIAIOSFODNN7EXAMPLE";
        let redacted = redact_secrets(text);
        assert!(!redacted.contains("1234567890abcdefghijklmnopqrstuv"));
        assert!(!redacted.contains("IOSFODNN7EXAMPLE"));
        assert!(redacted.contains("ghp_[REDACTED]"));
        assert!(redacted.contains("AKIA[REDACTED]"));
    }
}
