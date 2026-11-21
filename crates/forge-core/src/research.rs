use std::{borrow::Cow, collections::HashSet};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{
    AssetFormat, AssetRef, Content, Error, Result, data_links::is_image, model::validate_label,
    site,
};

pub(crate) const TYPE_ID: &str = "forge.research";
const MAX_SOURCES: usize = 64;
const MAX_VERSIONS: usize = 16;
pub const MAX_TEXT: usize = 64 * 1024;
pub const MAX_PDF_BYTES: u64 = 8 * 1024 * 1024;
pub(crate) const MAX_TRANSCRIPTION_BYTES: u64 = 16 * 1024 * 1024;
const MAX_CITATIONS: usize = 256;
const MAX_CONCLUSIONS: usize = 128;
const MAX_TRANSCRIPT_SEGMENTS: usize = 1024;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Action {
    Capture {
        link_id: Uuid,
        asset_id: Option<Uuid>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pdf_text: Option<ManualPdfText>,
    },
    Refresh {
        source_id: Uuid,
        #[serde(skip_serializing_if = "Option::is_none")]
        pdf_text: Option<ManualPdfText>,
    },
    Manual {
        source_id: Option<Uuid>,
        title: String,
        text: String,
    },
    Cite {
        source_id: Uuid,
        revision: String,
        start: usize,
        end: usize,
    },
    Conclude {
        text: String,
        citation_ids: Vec<Uuid>,
    },
    SetTranscript {
        source_id: Uuid,
        revision: String,
        segments: Vec<TranscriptSegment>,
    },
    SetProviderTranscript {
        source_id: Uuid,
        revision: String,
        segments: Vec<TranscriptSegment>,
        origin: TranscriptOrigin,
    },
    SetProjectOnly {
        source_id: Uuid,
        project_only: bool,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ManualPdfText {
    pub version_id: Uuid,
    pub text: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Document {
    pub sources: Vec<Source>,
    pub citations: Vec<Citation>,
    pub conclusions: Vec<Conclusion>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum Origin {
    Manual,
    Linked {
        link_id: Uuid,
        node_id: Uuid,
        asset_id: Option<Uuid>,
    },
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Source {
    pub id: Uuid,
    pub origin: Origin,
    pub active_revision: String,
    pub versions: Vec<Version>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub project_only: bool,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Version {
    pub revision: String,
    pub upstream_revision: Option<String>,
    pub title: String,
    pub material: Material,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum Material {
    Text {
        text: String,
    },
    Site {
        reference: site::Reference,
    },
    File {
        asset: AssetRef,
        text: Option<String>,
    },
    Pdf {
        asset: AssetRef,
        text: String,
        extraction: PdfExtraction,
    },
    Audio {
        asset: AssetRef,
        duration_ms: u64,
        segments: Vec<TranscriptSegment>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        transcript_origin: Option<TranscriptOrigin>,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TranscriptSegment {
    start_ms: u64,
    end_ms: u64,
    text: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TranscriptOrigin {
    pub(crate) provider: String,
    pub(crate) source_revision: String,
    requested_language: String,
    detected_language: String,
    completed_at: u64,
    response_sha256: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TranscriptionRequest {
    pub(crate) project_id: Uuid,
    pub(crate) target_id: Uuid,
    pub(crate) source_id: Uuid,
    pub(crate) revision: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptionSource {
    pub(crate) asset: AssetRef,
    pub(crate) duration_ms: u64,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum PdfExtraction {
    TextLayerV1,
    Manual,
}

pub type PdfExtractor = fn(&[u8]) -> Result<String>;

impl Material {
    pub fn upstream_revision(&self) -> Result<String> {
        match self {
            Self::Text { text } => text_revision(text),
            Self::Site { reference } => site_revision(reference),
            Self::File { asset, .. } | Self::Pdf { asset, .. } | Self::Audio { asset, .. } => {
                file_revision(asset)
            }
        }
    }

    pub fn text(&self) -> Option<Cow<'_, str>> {
        match self {
            Self::Text { text } | Self::Pdf { text, .. } => Some(Cow::Borrowed(text)),
            Self::Site { reference } => Some(Cow::Borrowed(&reference.quote)),
            Self::File { text, .. } => text.as_deref().map(Cow::Borrowed),
            Self::Audio { segments, .. } if !segments.is_empty() => Some(Cow::Owned(
                segments
                    .iter()
                    .map(|segment| segment.text.as_str())
                    .collect::<Vec<_>>()
                    .join("\n"),
            )),
            Self::Audio { .. } => None,
        }
    }

    pub fn asset(&self) -> Option<&AssetRef> {
        match self {
            Self::File { asset, .. } | Self::Pdf { asset, .. } | Self::Audio { asset, .. } => {
                Some(asset)
            }
            _ => None,
        }
    }

    fn validate(&self) -> Result<()> {
        match self {
            Self::Site { reference } => site::Site::validate_reference(reference)?,
            Self::File { asset, text } => {
                asset.validate()?;
                let valid = match asset.format {
                    AssetFormat::Txt | AssetFormat::Md => text.is_some(),
                    format => is_image(format) && text.is_none(),
                };
                if !valid {
                    return Err(Error::Invalid("Unsupported Research file"));
                }
            }
            Self::Pdf {
                asset, extraction, ..
            } => {
                asset.validate()?;
                if asset.format != AssetFormat::Pdf
                    || (matches!(extraction, PdfExtraction::TextLayerV1)
                        && asset.bytes > MAX_PDF_BYTES)
                {
                    return Err(Error::Invalid("Invalid Research PDF attachment"));
                }
            }
            Self::Audio {
                asset,
                duration_ms,
                segments,
                transcript_origin,
            } => {
                asset.validate()?;
                if asset.format != AssetFormat::Wav
                    || !(1..=crate::wav::MAX_DURATION_MS).contains(duration_ms)
                {
                    return Err(Error::Invalid("Invalid Research audio attachment"));
                }
                if let Some(origin) = transcript_origin
                    && (segments.is_empty()
                        || asset.bytes > MAX_TRANSCRIPTION_BYTES
                        || origin.provider != "whisper.cpp"
                        || !matches!(origin.requested_language.as_str(), "auto" | "en" | "ru")
                        || origin.detected_language.is_empty()
                        || origin.detected_language.len() > 64
                        || !origin
                            .detected_language
                            .bytes()
                            .all(|byte| byte.is_ascii_alphabetic() || matches!(byte, b' ' | b'-'))
                        || !(1..=253_402_300_799_999).contains(&origin.completed_at)
                        || !valid_hash(&origin.source_revision)
                        || !valid_hash(&origin.response_sha256))
                {
                    return Err(Error::Invalid("Invalid automatic transcript provenance"));
                }
                return validate_transcript(*duration_ms, segments);
            }
            Self::Text { .. } => {}
        }
        if let Some(text) = self.text() {
            validate_text(&text, MAX_TEXT)?;
        }
        Ok(())
    }
}

fn validate_transcript(duration_ms: u64, segments: &[TranscriptSegment]) -> Result<()> {
    if segments.len() > MAX_TRANSCRIPT_SEGMENTS {
        return Err(Error::Link(
            "RESEARCH_LIMIT",
            "An audio transcript supports up to 1024 segments",
        ));
    }
    let mut previous_end = 0;
    let mut bytes = segments.len().saturating_sub(1);
    for segment in segments {
        if segment.start_ms < previous_end
            || segment.start_ms >= segment.end_ms
            || segment.end_ms > duration_ms
        {
            return Err(Error::Link(
                "TRANSCRIPT_TIMESTAMPS",
                "Transcript timestamps must be ordered, non-overlapping and within the recording",
            ));
        }
        validate_text(&segment.text, MAX_TEXT)?;
        bytes += segment.text.len();
        if bytes > MAX_TEXT {
            return Err(Error::Link(
                "RESEARCH_LIMIT",
                "Transcript text exceeds 64 KiB",
            ));
        }
        previous_end = segment.end_ms;
    }
    Ok(())
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Citation {
    pub id: Uuid,
    pub source_id: Uuid,
    pub revision: String,
    pub start: usize,
    pub end: usize,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Conclusion {
    id: Uuid,
    text: String,
    citation_ids: Vec<Uuid>,
    context_revision: String,
}

pub(crate) fn fingerprint(value: &impl Serialize) -> Result<String> {
    Ok(format!("{:x}", Sha256::digest(serde_json::to_vec(value)?)))
}

pub(crate) fn text_revision(text: &str) -> Result<String> {
    fingerprint(&("text", text))
}

pub(crate) fn site_revision(reference: &site::Reference) -> Result<String> {
    fingerprint(&("site", reference))
}

pub(crate) fn file_revision(asset: &AssetRef) -> Result<String> {
    fingerprint(&("file", asset))
}

fn valid_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn validate_text(text: &str, limit: usize) -> Result<()> {
    if text.len() > limit {
        return Err(Error::Link(
            "RESEARCH_LIMIT",
            "Research text exceeds its byte limit",
        ));
    }
    if text.trim().is_empty()
        || text
            .chars()
            .any(|c| c.is_control() && !matches!(c, '\r' | '\n' | '\t'))
    {
        return Err(Error::Invalid("Research requires non-empty plain text"));
    }
    Ok(())
}

impl Version {
    pub fn new(
        title: String,
        material: Material,
        upstream_revision: Option<String>,
    ) -> Result<Self> {
        let revision = fingerprint(&(&title, &material, &upstream_revision))?;
        Ok(Self {
            revision,
            upstream_revision,
            title,
            material,
        })
    }
}

impl Document {
    pub fn decode(payload: &str) -> Result<Self> {
        let value: Self = serde_json::from_str(payload)
            .map_err(|_| Error::Invalid("Invalid Research payload"))?;
        value.validate()?;
        Ok(value)
    }

    pub fn from_content(content: &Content) -> Result<Self> {
        match content {
            Content::Portal {
                type_id,
                schema_version: 1,
                payload,
                ..
            } if type_id == TYPE_ID => Self::decode(payload),
            _ => Err(Error::Invalid("Open a Research card in this project")),
        }
    }

    pub fn store(&self, content: &mut Content) -> Result<()> {
        if let Content::Portal {
            type_id,
            schema_version: 1,
            payload,
            ..
        } = content
            && type_id == TYPE_ID
        {
            self.validate()?;
            *payload = serde_json::to_string(self)?;
            return Ok(());
        }
        Err(Error::Invalid("Open a Research card in this project"))
    }

    pub fn source(&self, id: Uuid) -> Result<&Source> {
        self.sources
            .iter()
            .find(|source| source.id == id)
            .ok_or(Error::Invalid("That Research source is unavailable"))
    }

    pub fn save_version(
        &mut self,
        id: Option<Uuid>,
        origin: Origin,
        version: Version,
    ) -> Result<()> {
        if let Some(id) = id {
            let source = self
                .sources
                .iter_mut()
                .find(|source| source.id == id && source.origin == origin)
                .ok_or(Error::Invalid(
                    "That Research source cannot be edited this way",
                ))?;
            if source.active_revision == version.revision {
                return Err(Error::Link(
                    "RESEARCH_CURRENT",
                    "This source version is already current",
                ));
            }
            source.active_revision = version.revision.clone();
            if source
                .versions
                .iter()
                .all(|previous| previous.revision != version.revision)
            {
                source.versions.push(version);
            }
        } else {
            if origin != Origin::Manual && self.sources.iter().any(|source| source.origin == origin)
            {
                return Err(Error::Invalid(
                    "This source is already captured. Refresh the saved source instead.",
                ));
            }
            self.sources.push(Source {
                id: Uuid::new_v4(),
                origin,
                active_revision: version.revision.clone(),
                versions: vec![version],
                project_only: false,
            });
        }
        Ok(())
    }

    pub fn context_revision(&self) -> Result<String> {
        fingerprint(
            &self
                .sources
                .iter()
                .map(|source| (source.id, &source.active_revision))
                .collect::<Vec<_>>(),
        )
    }

    pub fn cite(&mut self, source_id: Uuid, revision: String, start: usize, end: usize) {
        self.citations.push(Citation {
            id: Uuid::new_v4(),
            source_id,
            revision,
            start,
            end,
        });
    }

    pub fn conclude(&mut self, text: String, citation_ids: Vec<Uuid>) -> Result<()> {
        self.conclusions.push(Conclusion {
            id: Uuid::new_v4(),
            text,
            citation_ids,
            context_revision: self.context_revision()?,
        });
        Ok(())
    }

    fn validate(&self) -> Result<()> {
        if self.sources.len() > MAX_SOURCES
            || self.citations.len() > MAX_CITATIONS
            || self.conclusions.len() > MAX_CONCLUSIONS
        {
            return Err(Error::Limit);
        }
        let mut source_ids = HashSet::new();
        for source in &self.sources {
            if source.id.is_nil()
                || !source_ids.insert(source.id)
                || source.versions.is_empty()
                || source.versions.len() > MAX_VERSIONS
            {
                return Err(Error::Invalid("Invalid Research version history"));
            }
            if let Origin::Linked {
                link_id,
                node_id,
                asset_id,
            } = source.origin
                && (link_id.is_nil() || node_id.is_nil() || asset_id.is_some_and(|id| id.is_nil()))
            {
                return Err(Error::Invalid("Invalid Research source identity"));
            }
            let mut versions = HashSet::new();
            for version in &source.versions {
                validate_label(&version.title)?;
                version.material.validate()?;
                if let Material::Audio {
                    asset,
                    transcript_origin: Some(origin),
                    ..
                } = &version.material
                    && (!versions.contains(origin.source_revision.as_str())
                        || !source.versions.iter().any(|prior| {
                            prior.revision == origin.source_revision
                                && prior.material.asset() == Some(asset)
                        }))
                {
                    return Err(Error::Invalid(
                        "Automatic transcript source revision is unavailable",
                    ));
                }
                let expected_upstream = match source.origin {
                    Origin::Manual if matches!(version.material, Material::Text { .. }) => None,
                    Origin::Linked { asset_id, .. }
                        if asset_id.is_none()
                            || version.material.asset().map(|asset| asset.asset_id) == asset_id =>
                    {
                        Some(version.material.upstream_revision()?)
                    }
                    _ => return Err(Error::Invalid("Invalid Research source material")),
                };
                if !versions.insert(version.revision.as_str())
                    || version.upstream_revision != expected_upstream
                    || fingerprint(&(
                        &version.title,
                        &version.material,
                        &version.upstream_revision,
                    ))? != version.revision
                {
                    return Err(Error::Invalid("Invalid Research source revision"));
                }
            }
            if !versions.contains(source.active_revision.as_str()) {
                return Err(Error::Invalid("The active Research version is missing"));
            }
        }
        let mut citations = HashSet::new();
        for citation in &self.citations {
            let valid_quote = self
                .source(citation.source_id)?
                .versions
                .iter()
                .find(|version| version.revision == citation.revision)
                .and_then(|version| version.material.text())
                .is_some_and(|text| {
                    text.get(citation.start..citation.end)
                        .is_some_and(|quote| !quote.trim().is_empty() && quote.len() <= 8192)
                });
            if citation.id.is_nil() || !citations.insert(citation.id) || !valid_quote {
                return Err(Error::Invalid(
                    "A citation must select text in a saved Research version",
                ));
            }
        }
        let mut conclusions = HashSet::new();
        for conclusion in &self.conclusions {
            validate_text(&conclusion.text, 16 * 1024)?;
            let mut seen = HashSet::new();
            if conclusion.id.is_nil()
                || !conclusions.insert(conclusion.id)
                || !valid_hash(&conclusion.context_revision)
                || conclusion
                    .citation_ids
                    .iter()
                    .any(|id| !citations.contains(id) || !seen.insert(id))
            {
                return Err(Error::Invalid("Invalid Research conclusion or citations"));
            }
        }
        Ok(())
    }
}
