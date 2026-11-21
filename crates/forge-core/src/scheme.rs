use std::{collections::HashSet, io::Read, path::Path};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{
    Content, Error, Position, Result, Viewport,
    assets::{open_source, source_name},
};

pub(crate) const TYPE_ID: &str = "forge.scheme";
const FILE_FORMAT: &str = "forge-scheme";
const VERSION: u32 = 1;
const MAX_PAYLOAD: usize = 512 * 1024;
const MAX_FILE: usize = 1024 * 1024;
const MAX_ELEMENTS: usize = 500;
const MAX_CONNECTIONS: usize = 1_000;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ShapeKind {
    Rectangle,
    Ellipse,
    Diamond,
    Text,
    Line,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Element {
    pub id: Uuid,
    pub kind: ShapeKind,
    pub position: Position,
    pub width: u16,
    pub height: u16,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub angle: Option<u16>,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Route {
    Straight,
    Orthogonal,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Connection {
    pub id: Uuid,
    pub from: Uuid,
    pub to: Uuid,
    pub route: Route,
    pub text: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Document {
    pub elements: Vec<Element>,
    pub lines: Vec<Connection>,
    pub viewport: Viewport,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphData {
    pub source_revision: String,
    pub elements: Vec<Element>,
    pub lines: Vec<Connection>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Portable {
    format: String,
    schema_version: u32,
    document: Document,
}

#[derive(Debug, Serialize)]
pub struct InputFile {
    pub name: String,
    pub document: Document,
}

fn plain_text(value: &str) -> bool {
    value.len() <= 4_096
        && !value
            .chars()
            .any(|ch| ch.is_control() && !matches!(ch, '\n' | '\r' | '\t'))
}

impl Document {
    pub(crate) fn payload(content: &Content) -> Result<&str> {
        match content {
            Content::Portal {
                type_id,
                schema_version: VERSION,
                payload,
                ..
            } if type_id == TYPE_ID => Ok(payload),
            _ => Err(Error::Invalid("That object is not a supported Scheme")),
        }
    }

    pub(crate) fn decode(payload: &str) -> Result<Self> {
        if payload.len() > MAX_PAYLOAD {
            return Err(Error::Link(
                "SCHEME_LIMIT",
                "The Scheme exceeds the 512 KiB Plain limit",
            ));
        }
        let document: Self = serde_json::from_str(payload)
            .map_err(|_| Error::Link("SCHEME_INVALID", "Invalid Scheme document"))?;
        document.validate()?;
        Ok(document)
    }

    fn validate(&self) -> Result<()> {
        if self.elements.len() > MAX_ELEMENTS || self.lines.len() > MAX_CONNECTIONS {
            return Err(Error::Link(
                "SCHEME_LIMIT",
                "A Scheme supports up to 500 elements and 1,000 connections",
            ));
        }
        self.viewport.validate()?;
        let mut ids = HashSet::new();
        let mut endpoints = HashSet::new();
        for element in &self.elements {
            element.position.validate()?;
            if element.id.is_nil()
                || !ids.insert(element.id)
                || !(16..=2048).contains(&element.width)
                || !(16..=2048).contains(&element.height)
                || !plain_text(&element.text)
                || element
                    .angle
                    .is_some_and(|angle| angle >= 360 || element.kind != ShapeKind::Line)
            {
                return Err(Error::Link(
                    "SCHEME_INVALID",
                    "An element has an invalid identity, size, angle or label",
                ));
            }
            if element.kind != ShapeKind::Line {
                endpoints.insert(element.id);
            }
        }
        let mut pairs = HashSet::new();
        for line in &self.lines {
            let pair = (line.from.min(line.to), line.from.max(line.to));
            if line.id.is_nil()
                || !ids.insert(line.id)
                || line.from == line.to
                || !endpoints.contains(&line.from)
                || !endpoints.contains(&line.to)
                || !pairs.insert(pair)
                || !plain_text(&line.text)
            {
                return Err(Error::Link(
                    "SCHEME_INVALID",
                    "A connection has an invalid identity, endpoint or label",
                ));
            }
        }
        Ok(())
    }

    fn encode(&self) -> Result<String> {
        self.validate()?;
        let payload = serde_json::to_string(self)?;
        if payload.len() > MAX_PAYLOAD {
            return Err(Error::Link(
                "SCHEME_LIMIT",
                "The Scheme exceeds the 512 KiB Plain limit",
            ));
        }
        Ok(payload)
    }

    pub(crate) fn store(self, content: &mut Content) -> Result<()> {
        Self::payload(content)?;
        let Content::Portal { payload, .. } = content else {
            unreachable!()
        };
        *payload = self.encode()?;
        Ok(())
    }

    pub(crate) fn copy_elements(content: &mut Content) -> Result<()> {
        if let Ok(payload) = Self::payload(content) {
            use std::collections::HashMap;
            let mut copy = Self::decode(payload)?;
            let ids: HashMap<_, _> = copy
                .elements
                .iter_mut()
                .map(|element| {
                    let old = element.id;
                    element.id = Uuid::new_v4();
                    (old, element.id)
                })
                .collect();
            for line in &mut copy.lines {
                line.id = Uuid::new_v4();
                line.from = ids[&line.from];
                line.to = ids[&line.to];
            }
            copy.store(content)?;
        }
        Ok(())
    }

    pub(crate) fn text(&self) -> String {
        self.elements
            .iter()
            .map(|item| item.text.as_str())
            .chain(self.lines.iter().map(|item| item.text.as_str()))
            .filter(|text| !text.is_empty())
            .collect::<Vec<_>>()
            .join("\n")
    }

    pub(crate) fn portable(self) -> Result<Vec<u8>> {
        let export = Portable {
            format: FILE_FORMAT.into(),
            schema_version: VERSION,
            document: self,
        };
        Ok(serde_json::to_vec(&export)?)
    }
}

pub fn read_input(path: &Path) -> Result<InputFile> {
    if !path
        .extension()
        .and_then(|part| part.to_str())
        .is_some_and(|part| part.eq_ignore_ascii_case("json"))
    {
        return Err(Error::Invalid("Choose a Scheme JSON file"));
    }
    let name = source_name(path)?;
    let mut bytes = Vec::new();
    open_source(path)?
        .take(MAX_FILE as u64 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > MAX_FILE {
        return Err(Error::Link(
            "SCHEME_LIMIT",
            "Scheme JSON input is limited to 1 MiB",
        ));
    }
    Ok(InputFile {
        name,
        document: decode_file(&bytes)?,
    })
}

fn decode_file(bytes: &[u8]) -> Result<Document> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Header {
        format: String,
        schema_version: u32,
    }
    let bytes = bytes.strip_prefix(b"\xef\xbb\xbf").unwrap_or(bytes);
    let invalid = || Error::Link("SCHEME_INVALID", "Invalid Scheme JSON file");
    let header: Header = serde_json::from_slice(bytes).map_err(|_| invalid())?;
    if header.format != FILE_FORMAT {
        return Err(invalid());
    }
    if header.schema_version != VERSION {
        return Err(Error::Link(
            "SCHEME_VERSION_UNSUPPORTED",
            "Unsupported Scheme schema version",
        ));
    }
    let portable: Portable = serde_json::from_slice(bytes).map_err(|_| invalid())?;
    portable.document.encode()?;
    Ok(portable.document)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn example() -> Document {
        let first = Uuid::new_v4();
        let second = Uuid::new_v4();
        Document {
            elements: [
                (first, ShapeKind::Rectangle, "План"),
                (second, ShapeKind::Ellipse, "Light"),
            ]
            .into_iter()
            .map(|(id, kind, text)| Element {
                id,
                kind,
                position: Position { x: 36.25, y: -6.5 },
                width: 146,
                height: 76,
                text: text.into(),
                angle: None,
            })
            .collect(),
            lines: vec![Connection {
                id: Uuid::new_v4(),
                from: first,
                to: second,
                route: Route::Orthogonal,
                text: "Key".into(),
            }],
            viewport: Viewport {
                x: -2.0,
                y: 8.0,
                zoom: 0.75,
            },
        }
    }

    #[test]
    fn portable_round_trip_preserves_graph_camera_and_labels() {
        let document = example();
        assert_eq!(document.text(), "План\nLight\nKey");
        let bytes = document.clone().portable().unwrap();
        assert_eq!(decode_file(&bytes).unwrap(), document);
        let with_bom = [b"\xef\xbb\xbf".as_slice(), &bytes].concat();
        assert_eq!(decode_file(&with_bom).unwrap(), document);

        let mut content = Content::Portal {
            plain_id: Uuid::new_v4(),
            type_id: TYPE_ID.into(),
            schema_version: VERSION,
            payload: document.encode().unwrap(),
        };
        Document::copy_elements(&mut content).unwrap();
        let copy = Document::decode(Document::payload(&content).unwrap()).unwrap();
        assert_ne!(copy.elements[0].id, document.elements[0].id);
        assert_ne!(copy.lines[0].id, document.lines[0].id);
        assert_eq!(copy.lines[0].from, copy.elements[0].id);
        assert_eq!(copy.lines[0].to, copy.elements[1].id);
        assert_eq!(copy.text(), document.text());
    }

    #[test]
    fn malformed_version_geometry_and_connections_are_rejected() {
        let document = example();
        let mut envelope =
            json!({ "format": FILE_FORMAT, "schemaVersion": 2, "document": document });
        let read = |value: &serde_json::Value| {
            decode_file(&serde_json::to_vec(value).unwrap())
                .unwrap_err()
                .code()
        };
        assert_eq!(read(&envelope), "SCHEME_VERSION_UNSUPPORTED");
        envelope["schemaVersion"] = json!(1);
        envelope["document"]["elements"][0]["url"] = json!("https://example.invalid");
        assert_eq!(read(&envelope), "SCHEME_INVALID");

        let mut malformed = document.clone();
        malformed.lines[0].to = Uuid::new_v4();
        assert_eq!(malformed.encode().unwrap_err().code(), "SCHEME_INVALID");
        malformed.lines[0].to = malformed.elements[1].id;
        malformed.elements[1].kind = ShapeKind::Line;
        assert_eq!(malformed.encode().unwrap_err().code(), "SCHEME_INVALID");
        let mut repeated = document.lines[0].clone();
        repeated.id = Uuid::new_v4();
        std::mem::swap(&mut repeated.from, &mut repeated.to);
        malformed = document.clone();
        malformed.lines.push(repeated);
        assert_eq!(malformed.encode().unwrap_err().code(), "SCHEME_INVALID");
        malformed = document;
        malformed.elements[0].width = 0;
        assert_eq!(malformed.encode().unwrap_err().code(), "SCHEME_INVALID");
    }
}
