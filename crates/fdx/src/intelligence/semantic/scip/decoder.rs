//! Minimal, bounded protobuf wire decoder for the SCIP index format.
//!
//! Deliberately dependency-free: a standards-compatible reader for the exact
//! messages FDX ingests, with hard limits enforced during decode. A malformed
//! or malicious SCIP file can never OOM FDX: every message, string, document
//! and occurrence is bounded and every failure fails closed (no partial
//! structures are returned).
//!
//! Wire types: varint=0, 64-bit=1, length-delimited=2, 32-bit=5. Groups (3,4)
//! are rejected. Unknown field numbers are skipped for forward compatibility.

use crate::intelligence::semantic::limits::{
    MAX_SCIP_DOCUMENTS, MAX_SCIP_OCCURRENCES, MAX_SCIP_STRING_BYTES, MAX_SCIP_SYMBOL_INFOS,
};
use crate::intelligence::semantic::scip::model::{
    ScipDocument, ScipIndex, ScipMetadata, ScipOccurrence, ScipRange, ScipRelationship,
    ScipSymbolInformation, ScipToolInfo, SymbolRoles,
};
use thiserror::Error;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum ScipDecodeError {
    #[error("truncated protobuf payload")]
    Truncated,
    #[error("unsupported protobuf wire type {0}")]
    UnsupportedWireType(u8),
    #[error("protobuf groups are not supported")]
    UnsupportedGroup,
    #[error("string exceeds limit ({0} bytes)")]
    StringTooLong(usize),
    #[error("invalid UTF-8 in string field")]
    InvalidUtf8,
    #[error("document limit exceeded ({0})")]
    DocumentLimit(usize),
    #[error("occurrence limit exceeded ({0})")]
    OccurrenceLimit(usize),
    #[error("symbol limit exceeded ({0})")]
    SymbolLimit(usize),
    #[error("invalid range in occurrence")]
    InvalidRange,
    #[error("negative varint value not allowed here")]
    NegativeValue,
}

/// A reader over a byte slice with strict bounds.
struct WireReader<'a> {
    buf: &'a [u8],
    pos: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WireType {
    Varint = 0,
    I64 = 1,
    Len = 2,
    I32 = 5,
}

impl WireType {
    fn from_u8(v: u8) -> Option<WireType> {
        match v {
            0 => Some(WireType::Varint),
            1 => Some(WireType::I64),
            2 => Some(WireType::Len),
            5 => Some(WireType::I32),
            _ => None,
        }
    }
}

struct Field<'a> {
    number: u32,
    wire: WireType,
    varint: u64,
    bytes: &'a [u8],
}

impl<'a> WireReader<'a> {
    fn new(buf: &'a [u8]) -> Self {
        WireReader { buf, pos: 0 }
    }

    fn remaining(&self) -> usize {
        self.buf.len() - self.pos
    }

    fn read_u8(&mut self) -> Result<u8, ScipDecodeError> {
        if self.pos >= self.buf.len() {
            return Err(ScipDecodeError::Truncated);
        }
        let v = self.buf[self.pos];
        self.pos += 1;
        Ok(v)
    }

    fn read_varint(&mut self) -> Result<u64, ScipDecodeError> {
        let mut result: u64 = 0;
        let mut shift: u32 = 0;
        loop {
            let byte = self.read_u8()?;
            if shift >= 64 {
                return Err(ScipDecodeError::Truncated);
            }
            result |= u64::from(byte & 0x7f) << shift;
            if byte & 0x80 == 0 {
                return Ok(result);
            }
            shift += 7;
        }
    }

    /// Read a field header and its payload; returns None at end of message.
    fn next_field(&mut self) -> Result<Option<Field<'a>>, ScipDecodeError> {
        if self.pos >= self.buf.len() {
            return Ok(None);
        }
        let tag = self.read_varint()?;
        let wire_raw = (tag & 0x07) as u8;
        let number = (tag >> 3) as u32;
        let wire =
            WireType::from_u8(wire_raw).ok_or(ScipDecodeError::UnsupportedWireType(wire_raw))?;
        match wire {
            WireType::Varint => {
                let varint = self.read_varint()?;
                Ok(Some(Field {
                    number,
                    wire,
                    varint,
                    bytes: &[],
                }))
            }
            WireType::Len => {
                let len = self.read_varint()?;
                let len = usize::try_from(len).map_err(|_| ScipDecodeError::Truncated)?;
                if self.pos + len > self.buf.len() {
                    return Err(ScipDecodeError::Truncated);
                }
                let bytes = &self.buf[self.pos..self.pos + len];
                self.pos += len;
                Ok(Some(Field {
                    number,
                    wire,
                    varint: 0,
                    bytes,
                }))
            }
            WireType::I64 => {
                if self.pos + 8 > self.buf.len() {
                    return Err(ScipDecodeError::Truncated);
                }
                self.pos += 8;
                Ok(Some(Field {
                    number,
                    wire,
                    varint: 0,
                    bytes: &[],
                }))
            }
            WireType::I32 => {
                if self.pos + 4 > self.buf.len() {
                    return Err(ScipDecodeError::Truncated);
                }
                self.pos += 4;
                Ok(Some(Field {
                    number,
                    wire,
                    varint: 0,
                    bytes: &[],
                }))
            }
        }
    }

    /// Decode repeated int32 values that may be packed (length-delimited) or
    /// unpacked (repeated varint fields).
    fn read_int32_values(&mut self, field: Field<'a>) -> Result<Vec<i32>, ScipDecodeError> {
        if field.wire == WireType::Len {
            let mut reader = WireReader::new(field.bytes);
            let mut values = Vec::new();
            while reader.remaining() > 0 {
                let v = reader.read_varint()?;
                values.push(i32_from_varint(v)?);
            }
            Ok(values)
        } else if field.wire == WireType::Varint {
            Ok(vec![i32_from_varint(field.varint)?])
        } else {
            Err(ScipDecodeError::UnsupportedWireType(field.wire as u8))
        }
    }
}

fn i32_from_varint(v: u64) -> Result<i32, ScipDecodeError> {
    if v > i32::MAX as u64 {
        // int32 negative values are encoded as 10-byte varints; SCIP ranges
        // are never negative, so reject them (fail closed).
        return Err(ScipDecodeError::NegativeValue);
    }
    Ok(v as i32)
}

fn u32_from_varint(v: u64) -> Result<u32, ScipDecodeError> {
    if v > u32::MAX as u64 {
        return Err(ScipDecodeError::NegativeValue);
    }
    Ok(v as u32)
}

fn read_string(bytes: &[u8], _what: &str) -> Result<String, ScipDecodeError> {
    if bytes.len() > MAX_SCIP_STRING_BYTES {
        return Err(ScipDecodeError::StringTooLong(bytes.len()));
    }
    match std::str::from_utf8(bytes) {
        Ok(s) => Ok(s.to_string()),
        Err(_) => Err(ScipDecodeError::InvalidUtf8),
    }
}

/// Decode a complete SCIP index with hard bounds. Fails closed on any error:
/// no partial index is ever returned.
pub fn decode_index(bytes: &[u8]) -> Result<ScipIndex, ScipDecodeError> {
    let mut reader = WireReader::new(bytes);
    let mut documents: Vec<ScipDocument> = Vec::new();
    let mut external_symbols: Vec<ScipSymbolInformation> = Vec::new();
    let mut metadata: Option<ScipMetadata> = None;
    let mut total_occurrences: usize = 0;

    while let Some(field) = reader.next_field()? {
        match field.number {
            1 if field.wire == WireType::Len => {
                metadata = Some(decode_metadata(field.bytes)?);
            }
            2 if field.wire == WireType::Len => {
                if documents.len() >= MAX_SCIP_DOCUMENTS {
                    return Err(ScipDecodeError::DocumentLimit(MAX_SCIP_DOCUMENTS));
                }
                let doc = decode_document(field.bytes, &mut total_occurrences)?;
                documents.push(doc);
            }
            3 if field.wire == WireType::Len => {
                if external_symbols.len() >= MAX_SCIP_SYMBOL_INFOS {
                    return Err(ScipDecodeError::SymbolLimit(MAX_SCIP_SYMBOL_INFOS));
                }
                external_symbols.push(decode_symbol_information(field.bytes)?);
            }
            _ => {}
        }
    }

    Ok(ScipIndex {
        metadata,
        documents,
        external_symbols,
    })
}

fn decode_metadata(bytes: &[u8]) -> Result<ScipMetadata, ScipDecodeError> {
    let mut reader = WireReader::new(bytes);
    let mut version: u32 = 0;
    let mut tool_info: Option<ScipToolInfo> = None;
    let mut project_root: Option<String> = None;
    while let Some(field) = reader.next_field()? {
        match (field.number, field.wire) {
            (1, WireType::Varint) => version = u32_from_varint(field.varint)?,
            (2, WireType::Len) => tool_info = Some(decode_tool_info(field.bytes)?),
            (3, WireType::Len) => project_root = Some(read_string(field.bytes, "project_root")?),
            _ => {}
        }
    }
    Ok(ScipMetadata {
        version,
        tool_info,
        project_root,
    })
}

fn decode_tool_info(bytes: &[u8]) -> Result<ScipToolInfo, ScipDecodeError> {
    let mut reader = WireReader::new(bytes);
    let mut name = String::new();
    let mut version: Option<String> = None;
    let mut arguments: Vec<String> = Vec::new();
    while let Some(field) = reader.next_field()? {
        match (field.number, field.wire) {
            (1, WireType::Len) => name = read_string(field.bytes, "tool name")?,
            (2, WireType::Len) => version = Some(read_string(field.bytes, "tool version")?),
            (3, WireType::Len) => arguments.push(read_string(field.bytes, "tool argument")?),
            _ => {}
        }
    }
    Ok(ScipToolInfo {
        name,
        version,
        arguments,
    })
}

fn decode_document(
    bytes: &[u8],
    total_occurrences: &mut usize,
) -> Result<ScipDocument, ScipDecodeError> {
    let mut reader = WireReader::new(bytes);
    let mut language = String::new();
    let mut relative_path = String::new();
    let mut occurrences: Vec<ScipOccurrence> = Vec::new();
    let mut symbols: Vec<ScipSymbolInformation> = Vec::new();
    while let Some(field) = reader.next_field()? {
        match (field.number, field.wire) {
            (1, WireType::Len) => relative_path = read_string(field.bytes, "relative_path")?,
            (2, WireType::Len) => {
                if *total_occurrences >= MAX_SCIP_OCCURRENCES {
                    return Err(ScipDecodeError::OccurrenceLimit(MAX_SCIP_OCCURRENCES));
                }
                *total_occurrences += 1;
                occurrences.push(decode_occurrence(field.bytes)?);
            }
            (3, WireType::Len) => {
                if symbols.len() >= MAX_SCIP_SYMBOL_INFOS {
                    return Err(ScipDecodeError::SymbolLimit(MAX_SCIP_SYMBOL_INFOS));
                }
                symbols.push(decode_symbol_information(field.bytes)?);
            }
            (4, WireType::Len) => language = read_string(field.bytes, "language")?,
            _ => {}
        }
    }
    Ok(ScipDocument {
        language,
        relative_path,
        occurrences,
        symbols,
    })
}

fn decode_symbol_information(bytes: &[u8]) -> Result<ScipSymbolInformation, ScipDecodeError> {
    let mut reader = WireReader::new(bytes);
    let mut symbol = String::new();
    let mut kind: u32 = 0;
    let mut display_name: Option<String> = None;
    let mut enclosing_symbol: Option<String> = None;
    let mut relationships: Vec<ScipRelationship> = Vec::new();
    while let Some(field) = reader.next_field()? {
        match (field.number, field.wire) {
            (1, WireType::Len) => symbol = read_string(field.bytes, "symbol")?,
            (4, WireType::Len) => relationships.push(decode_relationship(field.bytes)?),
            (5, WireType::Varint) => kind = u32_from_varint(field.varint)?,
            (6, WireType::Len) => display_name = Some(read_string(field.bytes, "display_name")?),
            (8, WireType::Len) => {
                enclosing_symbol = Some(read_string(field.bytes, "enclosing_symbol")?)
            }
            _ => {}
        }
    }
    Ok(ScipSymbolInformation {
        symbol,
        kind,
        display_name,
        relationships,
        enclosing_symbol,
    })
}

fn decode_relationship(bytes: &[u8]) -> Result<ScipRelationship, ScipDecodeError> {
    let mut reader = WireReader::new(bytes);
    let mut symbol = String::new();
    let mut is_reference = false;
    let mut is_implementation = false;
    let mut is_definition = false;
    while let Some(field) = reader.next_field()? {
        match (field.number, field.wire) {
            (1, WireType::Len) => symbol = read_string(field.bytes, "relationship symbol")?,
            (2, WireType::Varint) => is_reference = field.varint != 0,
            (3, WireType::Varint) => is_implementation = field.varint != 0,
            (5, WireType::Varint) => is_definition = field.varint != 0,
            _ => {}
        }
    }
    Ok(ScipRelationship {
        symbol,
        is_reference,
        is_implementation,
        is_definition,
    })
}

fn decode_occurrence(bytes: &[u8]) -> Result<ScipOccurrence, ScipDecodeError> {
    let mut reader = WireReader::new(bytes);
    let mut symbol = String::new();
    let mut symbol_roles: u32 = 0;
    let mut range: Option<ScipRange> = None;
    let mut typed_range: Option<ScipRange> = None;
    while let Some(field) = reader.next_field()? {
        match (field.number, field.wire) {
            (1, WireType::Len) | (1, WireType::Varint) => {
                let values = reader.read_int32_values(field)?;
                range = Some(range_from_int32s(&values)?);
            }
            (2, WireType::Len) => symbol = read_string(field.bytes, "occurrence symbol")?,
            (3, WireType::Varint) => symbol_roles = u32_from_varint(field.varint)?,
            (8, WireType::Len) => {
                typed_range = Some(decode_single_line_range(field.bytes)?);
            }
            (9, WireType::Len) => {
                typed_range = Some(decode_multi_line_range(field.bytes)?);
            }
            _ => {}
        }
    }
    // Typed range takes precedence when both encodings are present.
    let final_range = typed_range.or(range);
    Ok(ScipOccurrence {
        symbol,
        symbol_roles: SymbolRoles(symbol_roles),
        range: final_range,
    })
}

fn decode_single_line_range(bytes: &[u8]) -> Result<ScipRange, ScipDecodeError> {
    let mut reader = WireReader::new(bytes);
    let (mut line, mut start_char, mut end_char) = (0u32, 0u32, 0u32);
    while let Some(field) = reader.next_field()? {
        match (field.number, field.wire) {
            (1, WireType::Varint) => line = i32_from_varint(field.varint)? as u32,
            (2, WireType::Varint) => start_char = i32_from_varint(field.varint)? as u32,
            (3, WireType::Varint) => end_char = i32_from_varint(field.varint)? as u32,
            _ => {}
        }
    }
    Ok(ScipRange {
        start_line: line,
        start_character: start_char,
        end_line: line,
        end_character: end_char,
    })
}

fn decode_multi_line_range(bytes: &[u8]) -> Result<ScipRange, ScipDecodeError> {
    let mut reader = WireReader::new(bytes);
    let (mut start_line, mut start_char, mut end_line, mut end_char) = (0u32, 0u32, 0u32, 0u32);
    while let Some(field) = reader.next_field()? {
        match (field.number, field.wire) {
            (1, WireType::Varint) => start_line = i32_from_varint(field.varint)? as u32,
            (2, WireType::Varint) => start_char = i32_from_varint(field.varint)? as u32,
            (3, WireType::Varint) => end_line = i32_from_varint(field.varint)? as u32,
            (4, WireType::Varint) => end_char = i32_from_varint(field.varint)? as u32,
            _ => {}
        }
    }
    Ok(ScipRange {
        start_line,
        start_character: start_char,
        end_line,
        end_character: end_char,
    })
}

/// Normalize the deprecated 3/4-int32 range encoding.
fn range_from_int32s(values: &[i32]) -> Result<ScipRange, ScipDecodeError> {
    match values.len() {
        3 => {
            let (l, s, e) = (values[0], values[1], values[2]);
            if l < 0 || s < 0 || e < 0 {
                return Err(ScipDecodeError::InvalidRange);
            }
            Ok(ScipRange {
                start_line: l as u32,
                start_character: s as u32,
                end_line: l as u32,
                end_character: e as u32,
            })
        }
        4 => {
            let (sl, sc, el, ec) = (values[0], values[1], values[2], values[3]);
            if sl < 0 || sc < 0 || el < 0 || ec < 0 || el < sl {
                return Err(ScipDecodeError::InvalidRange);
            }
            Ok(ScipRange {
                start_line: sl as u32,
                start_character: sc as u32,
                end_line: el as u32,
                end_character: ec as u32,
            })
        }
        _ => Err(ScipDecodeError::InvalidRange),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Minimal protobuf encoder helpers for fixtures. The decoder is tested
    /// against bytes produced by this encoder only; real-indexer wire
    /// compatibility is additionally covered by the fixtures in
    /// crates/fdx/tests/fixtures/scip/.
    fn varint(mut v: u64) -> Vec<u8> {
        let mut out = Vec::new();
        loop {
            let b = (v & 0x7f) as u8;
            v >>= 7;
            if v == 0 {
                out.push(b);
                return out;
            }
            out.push(b | 0x80);
        }
    }

    fn tag(number: u32, wire: u8) -> Vec<u8> {
        varint(u64::from(number) << 3 | u64::from(wire))
    }

    fn len_field(number: u32, payload: &[u8]) -> Vec<u8> {
        let mut out = tag(number, 2);
        out.extend(varint(payload.len() as u64));
        out.extend(payload);
        out
    }

    fn varint_field(number: u32, v: u64) -> Vec<u8> {
        let mut out = tag(number, 0);
        out.extend(varint(v));
        out
    }

    fn string_field(number: u32, s: &str) -> Vec<u8> {
        len_field(number, s.as_bytes())
    }

    fn occurrence(symbol: &str, roles: u32, range: &[i32]) -> Vec<u8> {
        let mut out = Vec::new();
        // packed repeated int32 (field 1)
        let mut packed = Vec::new();
        for v in range {
            packed.extend(varint(*v as u64));
        }
        out.extend(len_field(1, &packed));
        out.extend(string_field(2, symbol));
        out.extend(varint_field(3, u64::from(roles)));
        out
    }

    fn document(path: &str, lang: &str, occs: &[Vec<u8>]) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend(string_field(1, path));
        for o in occs {
            out.extend(len_field(2, o));
        }
        out.extend(string_field(4, lang));
        out
    }

    fn index_with_documents(docs: &[Vec<u8>]) -> Vec<u8> {
        let mut out = Vec::new();
        for d in docs {
            out.extend(len_field(2, d));
        }
        out
    }

    #[test]
    fn decodes_single_document_index() {
        let idx = index_with_documents(&[document(
            "src/a.ts",
            "TypeScript",
            &[occurrence(
                "scip-typescript npm pkg 1.0.0 lib#",
                0x1,
                &[1, 0, 5],
            )],
        )]);
        let decoded = decode_index(&idx).unwrap();
        assert_eq!(decoded.document_count(), 1);
        assert_eq!(decoded.occurrence_count(), 1);
        let doc = &decoded.documents[0];
        assert_eq!(doc.relative_path, "src/a.ts");
        assert_eq!(doc.language, "TypeScript");
        let occ = &doc.occurrences[0];
        assert!(occ.symbol_roles.is_definition());
        assert_eq!(occ.range.unwrap().start_line, 1);
        assert_eq!(occ.range.unwrap().start_character, 0);
        assert_eq!(occ.range.unwrap().end_character, 5);
    }

    #[test]
    fn decodes_multiple_symbols_and_cross_file_references() {
        let doc1 = document(
            "src/a.ts",
            "TypeScript",
            &[occurrence(
                "scip-typescript npm pkg 1.0.0 lib#foo().",
                0x1,
                &[0, 0, 3],
            )],
        );
        let doc2 = document(
            "src/b.ts",
            "TypeScript",
            &[
                occurrence("scip-typescript npm pkg 1.0.0 lib#foo().", 0x8, &[2, 4, 7]),
                occurrence("scip-typescript npm pkg 1.0.0 lib#bar().", 0x1, &[5, 0, 3]),
            ],
        );
        let idx = index_with_documents(&[doc1, doc2]);
        let decoded = decode_index(&idx).unwrap();
        assert_eq!(decoded.documents.len(), 2);
        assert_eq!(decoded.occurrence_count(), 3);
        assert_eq!(
            decoded.documents[1].occurrences[0].symbol,
            "scip-typescript npm pkg 1.0.0 lib#foo()."
        );
        assert!(!decoded.documents[1].occurrences[0]
            .symbol_roles
            .is_definition());
    }

    #[test]
    fn rejects_truncated_payload() {
        let idx = index_with_documents(&[document("a.ts", "TypeScript", &[])]);
        let truncated = &idx[..idx.len() - 3];
        assert_eq!(
            decode_index(truncated).unwrap_err(),
            ScipDecodeError::Truncated
        );
    }

    fn occurrence_bytes(symbol: &str, roles: u32, packed_range: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend(len_field(1, packed_range));
        out.extend(string_field(2, symbol));
        out.extend(varint_field(3, u64::from(roles)));
        out
    }

    #[test]
    fn rejects_invalid_range_shapes() {
        // Occurrence range with only 2 packed ints -> invalid range.
        let mut packed = Vec::new();
        packed.extend(varint(0));
        packed.extend(varint(0));
        let occ = occurrence_bytes("sym", 0x8, &packed);
        let doc = document("a.ts", "TypeScript", &[occ]);
        assert_eq!(
            decode_index(&index_with_documents(&[doc])).unwrap_err(),
            ScipDecodeError::InvalidRange
        );
    }

    #[test]
    fn rejects_negative_range_values() {
        // 10-byte varint for -1 (int32 negative) must fail closed.
        let mut packed = Vec::new();
        packed.extend(varint(u64::MAX)); // -1 as 64-bit varint overflows int32
        let occ = occurrence_bytes("sym", 0x8, &packed);
        let doc = document("a.ts", "TypeScript", &[occ]);
        assert_eq!(
            decode_index(&index_with_documents(&[doc])).unwrap_err(),
            ScipDecodeError::NegativeValue
        );
    }

    #[test]
    fn unknown_fields_are_skipped() {
        let mut doc = document("a.ts", "TypeScript", &[]);
        // add an unknown string field 99
        doc.extend(len_field(99, b"future"));
        let decoded = decode_index(&index_with_documents(&[doc])).unwrap();
        assert_eq!(decoded.documents[0].relative_path, "a.ts");
    }

    #[test]
    fn unicode_fixture() {
        let doc = document("日本/ファイル.ts", "TypeScript", &[]);
        let decoded = decode_index(&index_with_documents(&[doc])).unwrap();
        assert_eq!(decoded.documents[0].relative_path, "日本/ファイル.ts");
    }
}
