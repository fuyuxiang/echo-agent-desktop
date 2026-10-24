//! Provider transport normalization for declared numeric parameters only.
//! No text, references, booleans, or execution authority is inferred here.
use serde_json::{Number, Value};

pub(super) fn number(value: &Value) -> Option<Number> {
    if let Some(number) = value.as_number() {
        return Some(number.clone());
    }
    let text = value.as_str()?;
    if text.is_empty() || text.len() > 64 || text.trim() != text {
        return None;
    }
    serde_json::from_str::<Number>(text).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn numeric_transport_strings_preserve_coordinates_signs_and_integer_ranges() {
        for (raw, expected) in [
            ("261", 261.0),
            ("261.0", 261.0),
            ("-12.5", -12.5),
            ("1e2", 100.0),
        ] {
            assert_eq!(number(&json!(raw)).and_then(|n| n.as_f64()), Some(expected));
        }
        assert_eq!(number(&json!(261)).unwrap().as_f64(), Some(261.0));
        assert_eq!(
            number(&json!("18446744073709551615")).unwrap().as_u64(),
            Some(u64::MAX)
        );
        assert!(number(&json!("1.5")).unwrap().as_u64().is_none());
        assert!(number(&json!("-1")).unwrap().as_u64().is_none());
    }
    #[test]
    fn malformed_nonfinite_and_non_numeric_transport_values_stay_invalid() {
        for raw in [
            json!(true),
            json!(null),
            json!({"item":"261"}),
            json!([261]),
            json!("NaN"),
            json!("Infinity"),
            json!("1e999"),
            json!(""),
            json!(" 2"),
            json!("2px"),
            json!("0x20"),
            json!("+2"),
            json!("01"),
            json!("2;open"),
        ] {
            assert!(number(&raw).is_none(), "{raw}");
        }
    }
}
