// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       X.clearing-rs
// @phase      3
// @status     DONE
// @spec       docs/DESIGN-V2.md#9 L1 <- "ONE fixture file, read by every side"
// @rules      G10
// @depends    nothing — a LEAF.
// @facts      WHY HAND-WRITTEN: `clearing/tests/golden.rs` must read
// @facts        `sdk/fixtures/clearing.golden.json` — the SAME file the TypeScript suite and
// @facts        the Move generator read. A fixture copied into this crate would drift, which is
// @facts        the whole failure this crate exists to catch. Reading it needs a JSON parser;
// @facts        pulling serde_json in for that would put a 4-crate dependency tree behind a
// @facts        parity check that must be trivially auditable, and would need network to build.
// @facts      SCOPE: exactly the subset the fixture file uses — objects, arrays, strings with
// @facts        \" \\ \/ \b \f \n \r \t \uXXXX escapes, integers, true/false/null. NUMBERS ARE
// @facts        KEPT AS THEIR SOURCE TEXT and never converted to f64 — the fixture carries u128
// @facts        values as decimal STRINGS for exactly this reason, and a float conversion here
// @facts        would silently round them. This is not a general-purpose JSON library.
// @implements pub enum Json · pub fn parse(&str) -> Result<Json, JsonError>
//             pub fn write(&Json) -> String
//             Json::get / as_str / as_array / as_object / as_bool / as_usize
// @forbidden  f32/f64 anywhere in the number path — see above
// @invariant  1. parse(write(v)) == v for every value this module can produce.
// @invariant  2. A number is preserved as its exact source text.
// @ac         cargo test -p clearing json
// @verify     cd clearing-rs; cargo test
// └── END CONTRACT ───────────────────────────────────────────────────────────

use core::fmt;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Json {
    Null,
    Bool(bool),
    /// The number's EXACT source text. Never parsed to a float.
    Number(String),
    Str(String),
    Array(Vec<Json>),
    /// Insertion-ordered, so `write` round-trips key order.
    Object(Vec<(String, Json)>),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct JsonError {
    pub at: usize,
    pub msg: String,
}

impl fmt::Display for JsonError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "json error at byte {}: {}", self.at, self.msg)
    }
}

impl std::error::Error for JsonError {}

impl Json {
    pub fn get(&self, key: &str) -> Option<&Json> {
        match self {
            Json::Object(kv) => kv.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            Json::Str(s) => Some(s),
            _ => None,
        }
    }

    /// A scalar as text, whether the fixture wrote it as a string or a bare number.
    pub fn as_scalar_text(&self) -> Option<&str> {
        match self {
            Json::Str(s) | Json::Number(s) => Some(s),
            _ => None,
        }
    }

    pub fn as_array(&self) -> Option<&[Json]> {
        match self {
            Json::Array(a) => Some(a),
            _ => None,
        }
    }

    pub fn as_object(&self) -> Option<&[(String, Json)]> {
        match self {
            Json::Object(o) => Some(o),
            _ => None,
        }
    }

    pub fn as_bool(&self) -> Option<bool> {
        match self {
            Json::Bool(b) => Some(*b),
            _ => None,
        }
    }

    pub fn as_usize(&self) -> Option<usize> {
        self.as_scalar_text()?.parse::<usize>().ok()
    }

    pub fn is_null(&self) -> bool {
        matches!(self, Json::Null)
    }
}

struct Parser<'a> {
    b: &'a [u8],
    i: usize,
}

pub fn parse(s: &str) -> Result<Json, JsonError> {
    let mut p = Parser {
        b: s.as_bytes(),
        i: 0,
    };
    p.ws();
    let v = p.value()?;
    p.ws();
    if p.i != p.b.len() {
        return Err(p.err("trailing input"));
    }
    Ok(v)
}

impl<'a> Parser<'a> {
    fn err(&self, msg: &str) -> JsonError {
        JsonError {
            at: self.i,
            msg: msg.to_string(),
        }
    }

    fn peek(&self) -> Option<u8> {
        self.b.get(self.i).copied()
    }

    fn ws(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            self.i += 1;
        }
    }

    fn expect(&mut self, c: u8) -> Result<(), JsonError> {
        if self.peek() == Some(c) {
            self.i += 1;
            Ok(())
        } else {
            Err(self.err(&format!("expected '{}'", c as char)))
        }
    }

    fn lit(&mut self, word: &str, v: Json) -> Result<Json, JsonError> {
        if self.b[self.i..].starts_with(word.as_bytes()) {
            self.i += word.len();
            Ok(v)
        } else {
            Err(self.err("bad literal"))
        }
    }

    fn value(&mut self) -> Result<Json, JsonError> {
        match self.peek() {
            None => Err(self.err("unexpected end of input")),
            Some(b'{') => self.object(),
            Some(b'[') => self.array(),
            Some(b'"') => Ok(Json::Str(self.string()?)),
            Some(b't') => self.lit("true", Json::Bool(true)),
            Some(b'f') => self.lit("false", Json::Bool(false)),
            Some(b'n') => self.lit("null", Json::Null),
            Some(_) => self.number(),
        }
    }

    fn object(&mut self) -> Result<Json, JsonError> {
        self.expect(b'{')?;
        let mut out = Vec::new();
        self.ws();
        if self.peek() == Some(b'}') {
            self.i += 1;
            return Ok(Json::Object(out));
        }
        loop {
            self.ws();
            let k = self.string()?;
            self.ws();
            self.expect(b':')?;
            self.ws();
            let v = self.value()?;
            out.push((k, v));
            self.ws();
            match self.peek() {
                Some(b',') => self.i += 1,
                Some(b'}') => {
                    self.i += 1;
                    return Ok(Json::Object(out));
                }
                _ => return Err(self.err("expected ',' or '}'")),
            }
        }
    }

    fn array(&mut self) -> Result<Json, JsonError> {
        self.expect(b'[')?;
        let mut out = Vec::new();
        self.ws();
        if self.peek() == Some(b']') {
            self.i += 1;
            return Ok(Json::Array(out));
        }
        loop {
            self.ws();
            out.push(self.value()?);
            self.ws();
            match self.peek() {
                Some(b',') => self.i += 1,
                Some(b']') => {
                    self.i += 1;
                    return Ok(Json::Array(out));
                }
                _ => return Err(self.err("expected ',' or ']'")),
            }
        }
    }

    fn string(&mut self) -> Result<String, JsonError> {
        self.expect(b'"')?;
        let mut out = String::new();
        loop {
            let c = self.peek().ok_or_else(|| self.err("unterminated string"))?;
            self.i += 1;
            match c {
                b'"' => return Ok(out),
                b'\\' => {
                    let e = self.peek().ok_or_else(|| self.err("unterminated escape"))?;
                    self.i += 1;
                    match e {
                        b'"' => out.push('"'),
                        b'\\' => out.push('\\'),
                        b'/' => out.push('/'),
                        b'b' => out.push('\u{08}'),
                        b'f' => out.push('\u{0c}'),
                        b'n' => out.push('\n'),
                        b'r' => out.push('\r'),
                        b't' => out.push('\t'),
                        b'u' => {
                            let hex = self
                                .b
                                .get(self.i..self.i + 4)
                                .ok_or_else(|| self.err("short \\u escape"))?;
                            let cp = u32::from_str_radix(
                                core::str::from_utf8(hex).map_err(|_| self.err("bad \\u"))?,
                                16,
                            )
                            .map_err(|_| self.err("bad \\u"))?;
                            self.i += 4;
                            out.push(char::from_u32(cp).ok_or_else(|| self.err("bad codepoint"))?);
                        }
                        _ => return Err(self.err("unknown escape")),
                    }
                }
                _ => {
                    // Copy the raw UTF-8 byte run through untouched.
                    let start = self.i - 1;
                    while let Some(n) = self.peek() {
                        if n == b'"' || n == b'\\' {
                            break;
                        }
                        self.i += 1;
                    }
                    out.push_str(
                        core::str::from_utf8(&self.b[start..self.i])
                            .map_err(|_| self.err("invalid utf-8"))?,
                    );
                }
            }
        }
    }

    /// Kept as SOURCE TEXT. No float conversion — see the contract banner.
    fn number(&mut self) -> Result<Json, JsonError> {
        let start = self.i;
        if self.peek() == Some(b'-') {
            self.i += 1;
        }
        let digits_start = self.i;
        while matches!(self.peek(), Some(c) if c.is_ascii_digit() || c == b'.' || c == b'e' || c == b'E' || c == b'+' || c == b'-')
        {
            self.i += 1;
        }
        if self.i == digits_start {
            return Err(self.err("expected a number"));
        }
        Ok(Json::Number(
            core::str::from_utf8(&self.b[start..self.i])
                .map_err(|_| self.err("invalid utf-8"))?
                .to_string(),
        ))
    }
}

fn escape_into(s: &str, out: &mut String) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

/// Serialise, two-space indented. Used by `sim` to write its latency distribution.
pub fn write(v: &Json) -> String {
    let mut s = String::new();
    write_at(v, 0, &mut s);
    s.push('\n');
    s
}

fn write_at(v: &Json, depth: usize, out: &mut String) {
    let pad = "  ".repeat(depth);
    let pad1 = "  ".repeat(depth + 1);
    match v {
        Json::Null => out.push_str("null"),
        Json::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Json::Number(n) => out.push_str(n),
        Json::Str(s) => escape_into(s, out),
        Json::Array(a) => {
            if a.is_empty() {
                out.push_str("[]");
                return;
            }
            out.push_str("[\n");
            for (i, e) in a.iter().enumerate() {
                out.push_str(&pad1);
                write_at(e, depth + 1, out);
                if i + 1 < a.len() {
                    out.push(',');
                }
                out.push('\n');
            }
            out.push_str(&pad);
            out.push(']');
        }
        Json::Object(kv) => {
            if kv.is_empty() {
                out.push_str("{}");
                return;
            }
            out.push_str("{\n");
            for (i, (k, e)) in kv.iter().enumerate() {
                out.push_str(&pad1);
                escape_into(k, out);
                out.push_str(": ");
                write_at(e, depth + 1, out);
                if i + 1 < kv.len() {
                    out.push(',');
                }
                out.push('\n');
            }
            out.push_str(&pad);
            out.push('}');
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_shapes_the_fixture_uses() {
        let v = parse(r#"{"a":[1,"2",true,null],"b":{"c":-3}}"#).unwrap();
        assert_eq!(v.get("a").unwrap().as_array().unwrap().len(), 4);
        assert_eq!(v.get("a").unwrap().as_array().unwrap()[1].as_str(), Some("2"));
        assert_eq!(v.get("a").unwrap().as_array().unwrap()[2].as_bool(), Some(true));
        assert!(v.get("a").unwrap().as_array().unwrap()[3].is_null());
        assert_eq!(
            v.get("b").unwrap().get("c").unwrap().as_scalar_text(),
            Some("-3")
        );
    }

    /// @invariant 2 — the exact reason serde_json's f64 number path is unacceptable here.
    #[test]
    fn a_u128_number_survives_verbatim() {
        let big = "340282366920938463463374607431768211455";
        let v = parse(&format!(r#"{{"p":{big}}}"#)).unwrap();
        assert_eq!(v.get("p").unwrap().as_scalar_text(), Some(big));
    }

    /// @invariant 1.
    #[test]
    fn round_trips() {
        let src = r#"{"s":"a\"b\\c\nd","n":[0,1,2],"o":{},"e":[],"t":true}"#;
        let v = parse(src).unwrap();
        let again = parse(&write(&v)).unwrap();
        assert_eq!(v, again);
    }

    #[test]
    fn rejects_garbage() {
        assert!(parse("{").is_err());
        assert!(parse("[1,]").is_err());
        assert!(parse(r#"{"a" 1}"#).is_err());
        assert!(parse("{} x").is_err());
    }

    #[test]
    fn handles_unicode_escapes_and_raw_utf8() {
        let v = parse(r#"{"k":"é— café — ok"}"#).unwrap();
        assert_eq!(v.get("k").unwrap().as_str(), Some("é— café — ok"));
    }
}
