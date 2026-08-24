//! RFC 8785 JSON Canonicalization Scheme (JCS) and digest utilities.

use crate::intelligence::runtime::sha256_bytes;
use serde::Serialize;
use serde_json::Value;

/// Convert any serializable data structure into RFC 8785 canonical JSON bytes.
pub fn canonicalize_to_vec<T: Serialize>(value: &T) -> Result<Vec<u8>, String> {
    let json_val = serde_json::to_value(value)
        .map_err(|e| format!("failed to serialize to json value: {}", e))?;
    let mut out = String::new();
    format_jcs_value(&json_val, &mut out)?;
    Ok(out.into_bytes())
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

/// Recursively format a serde_json::Value according to RFC 8785 JSON Canonicalization Scheme (JCS).
fn format_jcs_value(val: &Value, out: &mut String) -> Result<(), String> {
    match val {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(num) => {
            if let Some(i) = num.as_i64() {
                out.push_str(&i.to_string());
            } else if let Some(u) = num.as_u64() {
                out.push_str(&u.to_string());
            } else if let Some(f) = num.as_f64() {
                if f.is_nan() || f.is_infinite() {
                    return Err("NaN or Infinity cannot be serialized to JSON".to_string());
                }
                out.push_str(&f.to_string());
            } else {
                out.push_str(&num.to_string());
            }
        }
        Value::String(s) => {
            let json_str = serde_json::to_string(s)
                .map_err(|e| format!("failed to serialize string: {}", e))?;
            out.push_str(&json_str);
        }
        Value::Array(arr) => {
            out.push('[');
            for (i, elem) in arr.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                format_jcs_value(elem, out)?;
            }
            out.push(']');
        }
        Value::Object(obj) => {
            out.push('{');
            let mut keys: Vec<&String> = obj.keys().collect();
            // RFC 8785 section 3.2.3: Object keys MUST be sorted by UTF-16 code units
            keys.sort_by(|a, b| {
                let a_utf16: Vec<u16> = a.encode_utf16().collect();
                let b_utf16: Vec<u16> = b.encode_utf16().collect();
                a_utf16.cmp(&b_utf16)
            });
            for (i, k) in keys.into_iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                let k_str = serde_json::to_string(k)
                    .map_err(|e| format!("failed to serialize object key: {}", e))?;
                out.push_str(&k_str);
                out.push(':');
                format_jcs_value(obj.get(k).unwrap(), out)?;
            }
            out.push('}');
        }
    }
    Ok(())
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
    fn test_jcs_no_whitespace() {
        let v = json!({
            "array": [1, 2, 3],
            "obj": { "nested": true }
        });
        let canonical = canonicalize_to_string(&v).unwrap();
        assert_eq!(canonical, r#"{"array":[1,2,3],"obj":{"nested":true}}"#);
    }
}
