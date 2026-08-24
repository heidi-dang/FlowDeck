//! RFC 8785 (JCS) Conformance and Boundary Vectors Suite.

use fdx::intelligence::attestation::{
    canonicalize_to_string, canonicalize_to_vec, MAX_SAFE_INTEGER,
};
use serde_json::json;

#[test]
fn test_jcs_object_key_utf16_sorting() {
    let input = json!({
        "b": 2,
        "a": 1,
        "1": "one",
        "A": "capital",
        "aa": "double",
        "aA": "mixed",
        "\u{0080}": "latin1",
        "\u{00ff}": "high-latin",
        "z": 26
    });

    let canonical = canonicalize_to_string(&input).unwrap();
    assert_eq!(
        canonical,
        "{\"1\":\"one\",\"A\":\"capital\",\"a\":1,\"aA\":\"mixed\",\"aa\":\"double\",\"b\":2,\"z\":26,\"\u{0080}\":\"latin1\",\"\u{00ff}\":\"high-latin\"}"
    );
}

#[test]
fn test_jcs_utf16_non_bmp_sorting() {
    let input = json!({
        "\u{e000}": "bmp-private",
        "\u{10000}": "astral-plane"
    });

    let canonical = canonicalize_to_string(&input).unwrap();
    assert_eq!(
        canonical,
        "{\"\u{10000}\":\"astral-plane\",\"\u{e000}\":\"bmp-private\"}"
    );
}

#[test]
fn test_jcs_negative_zero() {
    let input = json!({ "val": -0.0 });
    let canonical = canonicalize_to_string(&input).unwrap();
    assert_eq!(canonical, "{\"val\":0}");
}

#[test]
fn test_jcs_number_exponential_boundaries() {
    let input1 = json!({ "val": 0.000001 });
    assert_eq!(
        canonicalize_to_string(&input1).unwrap(),
        "{\"val\":0.000001}"
    );

    let input2 = json!({ "val": 0.0000001 });
    assert_eq!(canonicalize_to_string(&input2).unwrap(), "{\"val\":1e-7}");

    let input3 = json!({ "val": 1e20 });
    assert_eq!(
        canonicalize_to_string(&input3).unwrap(),
        "{\"val\":100000000000000000000}"
    );

    let input4 = json!({ "val": 1e21 });
    assert_eq!(canonicalize_to_string(&input4).unwrap(), "{\"val\":1e+21}");
}

#[test]
fn test_jcs_control_and_quote_escaping() {
    let input = json!({
        "escapes": "\"\\\n\r\t"
    });
    let canonical = canonicalize_to_string(&input).unwrap();
    assert_eq!(canonical, "{\"escapes\":\"\\\"\\\\\\n\\r\\t\"}");
}

#[test]
fn test_jcs_fixed_point_idempotency() {
    let input = json!({
        "z": [3, 2, 1],
        "a": { "b": true, "a": null }
    });
    let c1 = canonicalize_to_string(&input).unwrap();
    let v_parsed: serde_json::Value = serde_json::from_str(&c1).unwrap();
    let c2 = canonicalize_to_string(&v_parsed).unwrap();
    assert_eq!(c1, c2);
}

#[test]
fn test_jcs_safe_integer_boundary_rejection() {
    let safe_obj = json!({ "count": MAX_SAFE_INTEGER });
    assert!(canonicalize_to_vec(&safe_obj).is_ok());

    let unsafe_obj = json!({ "count": MAX_SAFE_INTEGER + 1 });
    let res = canonicalize_to_vec(&unsafe_obj);
    assert!(res.is_err());
    let err = res.unwrap_err();
    assert!(err.contains("safe integer limit"));
}
