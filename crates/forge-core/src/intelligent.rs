use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{Content, Error, Result, model::validate_label};

pub(crate) const TYPE_ID: &str = "forge.intelligent";
pub(crate) const MAX_SOURCES: usize = 10;
pub(crate) const MAX_CONTEXT_BYTES: usize = 16_000;
const MAX_RESULTS: usize = 12;
const MAX_RESULT_BYTES: usize = 16_384;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContextRequest {
    pub(crate) project_id: Uuid,
    pub(crate) target_id: Uuid,
    pub(crate) selections: Vec<Selection>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Selection {
    pub link_id: Uuid,
    pub node_id: Uuid,
    pub pick: Pick,
}

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum Pick {
    Palette,
    Research { source_ids: Vec<Uuid> },
    Dataset { offset: usize, limit: usize },
    Site,
    Text,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Kind {
    Palette,
    DatasetRows,
    Text,
    PdfText,
    AudioTranscript,
    SiteQuote,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Citation {
    pub id: Uuid,
    pub start: usize,
    pub end: usize,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ManifestItem {
    pub link_id: Uuid,
    pub node_id: Uuid,
    pub item_id: Option<Uuid>,
    pub title: String,
    pub kind: Kind,
    pub revision: String,
    pub extraction: String,
    pub bytes: usize,
    pub content_sha256: String,
    pub citations: Vec<Citation>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Material {
    pub manifest: ManifestItem,
    pub text: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Context {
    pub(crate) materials: Vec<Material>,
    pub(crate) bytes: usize,
    pub(crate) digest: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SavedResult {
    id: Uuid,
    occurred_at: u64,
    provider: String,
    model: String,
    digest: String,
    response_sha256: String,
    text: String,
    materials: Vec<ManifestItem>,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Document {
    results: Vec<SavedResult>,
}

pub(crate) fn sha(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))
}

pub(crate) fn quota() -> Error {
    Error::Link(
        "MODEL_CONTEXT_LIMIT",
        "Choose at most ten sources and narrow the prepared text to fit the model context",
    )
}

pub(crate) fn sensitive() -> Error {
    Error::Link(
        "MODEL_CONTEXT_PROTECTED",
        "The selected material is restricted to this project or contains credential fields",
    )
}

pub(crate) fn credential_label(value: &str) -> bool {
    let name: String = value
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .flat_map(char::to_lowercase)
        .collect();
    matches!(
        name.as_str(),
        "password"
            | "passphrase"
            | "apikey"
            | "accesstoken"
            | "refreshtoken"
            | "clientsecret"
            | "secretkey"
            | "privatekey"
            | "authorization"
            | "credential"
            | "credentials"
            | "secret"
    )
}

pub(crate) fn check_material(text: &str) -> Result<()> {
    if text.trim().is_empty() {
        return Err(Error::Link(
            "MODEL_CONTEXT_EMPTY",
            "The selected material has no text to send",
        ));
    }
    if text.len() > MAX_CONTEXT_BYTES {
        return Err(quota());
    }
    if contains_credentials(text) {
        return Err(sensitive());
    }
    Ok(())
}

pub(crate) fn contains_credentials(text: &str) -> bool {
    text.lines().any(|line| {
        let line = line.trim();
        (line.starts_with("-----BEGIN ") && line.contains("PRIVATE KEY-----"))
            || line
                .split_once(['=', ':'])
                .is_some_and(|(key, value)| credential_label(key) && !value.trim().is_empty())
            || line.split_ascii_whitespace().any(|part| {
                ["ghp_", "github_pat_", "sk-proj-", "xoxb-"]
                    .iter()
                    .any(|prefix| part.starts_with(prefix) && part.len() >= prefix.len() + 20)
            })
    })
}

fn hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

fn identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 120
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-_./:".contains(&byte))
}

impl SavedResult {
    fn validate(&self) -> Result<()> {
        if self.id.is_nil()
            || !(1..=253_402_300_799_999).contains(&self.occurred_at)
            || !identifier(&self.provider)
            || !identifier(&self.model)
            || !hash(&self.digest)
            || self.text.trim().is_empty()
            || self.text.len() > MAX_RESULT_BYTES
            || sha(&self.text) != self.response_sha256
            || self.materials.is_empty()
            || self.materials.len() > MAX_SOURCES
        {
            return Err(Error::Invalid("Invalid saved Intelligent result"));
        }
        let mut total = 0;
        for item in &self.materials {
            validate_label(&item.title)?;
            if item.link_id.is_nil()
                || item.node_id.is_nil()
                || item.item_id.is_some_and(|id| id.is_nil())
                || !hash(&item.revision)
                || !hash(&item.content_sha256)
                || !identifier(&item.extraction)
                || !(1..=MAX_CONTEXT_BYTES).contains(&item.bytes)
                || item.citations.len() > 256
                || item.citations.iter().any(|citation| {
                    citation.id.is_nil()
                        || citation.start >= citation.end
                        || citation.end > item.bytes
                })
            {
                return Err(Error::Invalid("Invalid Intelligent source provenance"));
            }
            total += item.bytes;
        }
        if total > MAX_CONTEXT_BYTES {
            return Err(quota());
        }
        Ok(())
    }
}

impl Document {
    pub fn decode(payload: &str) -> Result<Self> {
        let document: Self = serde_json::from_str(payload)
            .map_err(|_| Error::Invalid("Invalid Intelligent payload"))?;
        if document.results.len() > MAX_RESULTS {
            return Err(Error::Limit);
        }
        let mut ids = HashSet::new();
        for result in &document.results {
            result.validate()?;
            if !ids.insert(result.id) {
                return Err(Error::Invalid("Duplicate Intelligent result"));
            }
        }
        Ok(document)
    }

    pub fn save(content: &mut Content, result: SavedResult) -> Result<()> {
        let Content::Portal {
            type_id,
            schema_version: 1,
            payload,
            ..
        } = content
        else {
            return Err(Error::Invalid("Open an Intelligent card in this project"));
        };
        if type_id != TYPE_ID {
            return Err(Error::Invalid("Open an Intelligent card in this project"));
        }
        let mut document = Self::decode(payload)?;
        result.validate()?;
        if document.results.len() >= MAX_RESULTS {
            return Err(Error::Limit);
        }
        if document.results.iter().any(|record| record.id == result.id) {
            return Err(Error::Invalid("This Intelligent result is already saved"));
        }
        document.results.push(result);
        *payload = serde_json::to_string(&document)?;
        Ok(())
    }
}
