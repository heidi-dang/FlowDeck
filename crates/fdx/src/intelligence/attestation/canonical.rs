//! RFC 8785 JSON Canonicalization Scheme (JCS) and digest utilities.

use crate::intelligence::runtime::sha256_bytes;
use serde::Serialize;
use serde_json::Value;

/// Maximum safe integer in IEEE-754 double precision (2^53 - 1).
pub const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

/// Validate that no numbers in the JSON structure exceed JavaScript safe integer bounds.
pub fn validate_safe_integers(val: &Value) -> Result<(), String> {
    match val {
        Value::Number(n) => {
            if let Some(u) = n.as_u64() {
                if u > MAX_SAFE_INTEGER {
                    return Err(format!(
                        "number {} exceeds IEEE-754 / ECMAScript safe integer limit (2^53 - 1)",
                        u
                    ));
                }
            }
            if let Some(i) = n.as_i64() {
                if i > (MAX_SAFE_INTEGER as i64) || i < -(MAX_SAFE_INTEGER as i64) {
                    return Err(format!(
                        "number {} exceeds IEEE-754 / ECMAScript safe integer limit (2^53 - 1)",
                        i
                    ));
                }
            }
            Ok(())
        }
        Value::Array(arr) => {
            for item in arr {
                validate_safe_integers(item)?;
            }
            Ok(())
        }
        Value::Object(obj) => {
            for v in obj.values() {
                validate_safe_integers(v)?;
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

/// Convert any serializable data structure into RFC 8785 canonical JSON bytes.
pub fn canonicalize_to_vec<T: Serialize>(value: &T) -> Result<Vec<u8>, String> {
    let json_val = serde_json::to_value(value)
        .map_err(|e| format!("failed to serialize to json value: {}", e))?;
    validate_safe_integers(&json_val)?;
    serde_json_canonicalizer::to_vec(&json_val)
        .map_err(|e| format!("JCS canonicalization failed: {}", e))
}

/// Convert any serializable data structure into RFC 8785 canonical JSON string.
pub fn canonicalize_to_string<T: Serialize>(value: &T) -> Result<String, String> {
    let bytes = canonicalize_to_vec(value)?;
    String::from_utf8(bytes).map_err(|e| format!("canonical json was not valid utf8: {}", e))
}

/// Compute SHA-256 hex digest of RFC 8785 canonical representation of any serializable value.
pub fn compute_canonical_sha256<T: Serialize>(value: &T) -> Result<String, String> {
    let bytes = canonicalize_to_vec(value)?;
    Ok(sha256_bytes(&bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_jcs_key_sorting() {
        let v = json!({
            "b": 2,
            "a": 1,
            "z": 26,
            "aa": "nested"
        });
        let canonical = canonicalize_to_string(&v).unwrap();
        assert_eq!(canonical, r#"{"a":1,"aa":"nested","b":2,"z":26}"#);
    }

    #[test]
    fn test_jcs_safe_integer_limits() {
        let safe = json!({ "count": MAX_SAFE_INTEGER });
        assert!(canonicalize_to_vec(&safe).is_ok());

        let unsafe_int = json!({ "count": MAX_SAFE_INTEGER + 1 });
        let res = canonicalize_to_vec(&unsafe_int);
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("safe integer limit"));
    }
}
