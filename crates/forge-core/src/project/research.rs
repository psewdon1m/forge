use std::{borrow::Cow, io};

use super::*;
use crate::{
    research::{
        Action, Document, MAX_PDF_BYTES, MAX_TRANSCRIPTION_BYTES, ManualPdfText, Material, Origin,
        PdfExtraction, PdfExtractor, Source, TranscriptOrigin, TranscriptSegment,
        TranscriptionRequest, TranscriptionSource, Version, file_revision, site_revision,
        text_revision,
    },
    site,
};

pub(super) enum Upstream<'a> {
    Text(Cow<'a, str>),
    Site(site::Reference),
    File(AssetRef),
}

impl Upstream<'_> {
    pub(super) fn revision(&self) -> Result<String> {
        match self {
            Self::Text(text) => text_revision(text),
            Self::Site(reference) => site_revision(reference),
            Self::File(asset) => file_revision(asset),
        }
    }

    fn capture(
        self,
        root: &Dir,
        title: String,
        pdf_text: Option<ManualPdfText>,
        extract_pdf: PdfExtractor,
    ) -> Result<Version> {
        if pdf_text.is_some()
            && !matches!(&self, Self::File(asset) if asset.format == AssetFormat::Pdf)
        {
            return Err(Error::Invalid("Manual PDF text requires a linked PDF"));
        }
        let revision = self.revision()?;
        let title = match &self {
            Self::File(asset) => asset.name.clone(),
            Self::Site(reference) => reference.title.clone(),
            Self::Text(_) => title,
        };
        let material = match self {
            Self::Text(text) => Material::Text {
                text: text.into_owned(),
            },
            Self::Site(reference) => Material::Site { reference },
            Self::File(asset) if asset.format == AssetFormat::Wav => {
                let duration_ms = AssetStore::open(root, false)?.wav_duration(&asset)?;
                Material::Audio {
                    asset,
                    duration_ms,
                    segments: Vec::new(),
                    transcript_origin: None,
                }
            }
            Self::File(asset) if asset.format == AssetFormat::Pdf => {
                let store = AssetStore::open(root, false)?;
                let (text, extraction) = if let Some(draft) = pdf_text {
                    if asset.version_id != draft.version_id {
                        return Err(Error::Link(
                            "SOURCE_CHANGED",
                            "The PDF changed since manual text entry began",
                        ));
                    }
                    store.copy_verified_with_checkpoint(&asset, &mut io::sink(), || Ok(()))?;
                    (draft.text, PdfExtraction::Manual)
                } else {
                    if asset.bytes > MAX_PDF_BYTES {
                        return Err(Error::Link(
                            "PDF_LIMIT",
                            "PDF text extraction supports files up to 8 MiB",
                        ));
                    }
                    let mut original = Vec::with_capacity(asset.bytes as usize);
                    store.copy_verified_with_checkpoint(&asset, &mut original, || Ok(()))?;
                    (extract_pdf(&original)?, PdfExtraction::TextLayerV1)
                };
                Material::Pdf {
                    asset,
                    text,
                    extraction,
                }
            }
            Self::File(asset) => {
                let store = AssetStore::open(root, false)?;
                let text = if matches!(asset.format, AssetFormat::Txt | AssetFormat::Md) {
                    Some(store.read_text(&asset)?)
                } else {
                    store.copy_verified_with_checkpoint(&asset, &mut io::sink(), || Ok(()))?;
                    None
                };
                Material::File { asset, text }
            }
        };
        Version::new(title, material, Some(revision))
    }
}

pub(super) fn resolve<'a>(
    db: &Connection,
    space: &'a Space,
    target: Uuid,
    link_id: Uuid,
    selected_asset: Option<Uuid>,
) -> Result<(&'a Node, Upstream<'a>)> {
    let (node, link) = linked_source(space, target, link_id)?;
    let resource = match &node.content {
        Content::Asset { asset } if selected_asset.is_none() => {
            if !(is_image(asset.format)
                || matches!(
                    asset.format,
                    AssetFormat::Txt | AssetFormat::Md | AssetFormat::Pdf | AssetFormat::Wav
                ))
            {
                return Err(Error::Link(
                    "RESEARCH_UNSUPPORTED",
                    "This linked file format is unavailable to Research",
                ));
            }
            validate_asset_ref(&mut db.prepare(ASSET_METADATA_QUERY)?, asset)?;
            Upstream::File(asset.clone())
        }
        Content::Portal {
            type_id,
            schema_version: 1,
            ..
        } if type_id == GALLERY => {
            let gallery = gallery(node)?;
            let selected =
                selected_asset.ok_or(Error::Invalid("Select a linked image to capture"))?;
            let item = gallery
                .items
                .iter()
                .find(|item| item.asset_id == selected)
                .ok_or(Error::AssetUnavailable)?;
            let asset = gallery_asset(&mut db.prepare(ASSET_METADATA_QUERY)?, item)?;
            if !is_image(asset.format) {
                return Err(Error::Link(
                    "RESEARCH_UNSUPPORTED",
                    "Choose a still image from this Gallery",
                ));
            }
            Upstream::File(asset)
        }
        Content::Portal {
            type_id,
            schema_version: 1,
            payload,
            ..
        } if type_id == site::TYPE_ID && selected_asset.is_none() => {
            let reference = site::Site::decode(payload)?.reference.ok_or(Error::Link(
                "SOURCE_NOT_FOUND",
                "Save a Site reference and quote before capturing it",
            ))?;
            Upstream::Site(reference)
        }
        content if selected_asset.is_none() && link.data_type == DataType::TextContent => {
            Upstream::Text(data_links::inline_text(content)?.ok_or(Error::Link(
                "SOURCE_NOT_FOUND",
                "The linked text is unavailable",
            ))?)
        }
        _ => {
            return Err(Error::Link(
                "RESEARCH_UNSUPPORTED",
                "Select a supported linked source",
            ));
        }
    };
    Ok((node, resource))
}

fn card(space: &Space, target: Uuid) -> Result<&Node> {
    space
        .nodes
        .iter()
        .find(|node| node.id == target)
        .ok_or(Error::Invalid("That Research card is unavailable"))
}

pub(super) fn check_shareable(
    db: &Connection,
    space: &Space,
    target: Uuid,
    source: &Source,
    version: &Version,
) -> Result<()> {
    if source.project_only {
        return Err(crate::intelligent::sensitive());
    }
    if let Origin::Linked {
        link_id,
        node_id,
        asset_id,
    } = source.origin
    {
        let (node, input) = resolve(db, space, target, link_id, asset_id).map_err(|_| {
            Error::Link(
                "SOURCE_NOT_FOUND",
                "A selected Research source has lost its upstream link",
            )
        })?;
        if node.id != node_id || version.upstream_revision.as_deref() != Some(&input.revision()?) {
            return Err(Error::Link(
                "SOURCE_CHANGED",
                "Refresh the changed Research source before sending it",
            ));
        }
    }
    Ok(())
}

fn current_audio<'a>(
    document: &'a Document,
    id: Uuid,
    revision: &str,
) -> Result<(&'a Source, &'a Version)> {
    let source = document.source(id)?;
    if source.active_revision != revision {
        return Err(Error::Link(
            "SOURCE_CHANGED",
            "The saved recording or transcript has changed",
        ));
    }
    let version = source
        .versions
        .iter()
        .find(|version| version.revision == revision)
        .ok_or(Error::AssetUnavailable)?;
    if !matches!(version.material, Material::Audio { .. }) {
        return Err(Error::Invalid("Choose a saved audio recording"));
    }
    Ok((source, version))
}

fn verified_provider_audio(
    db: &Connection,
    space: &Space,
    target: Uuid,
    source: &Source,
    version: &Version,
) -> Result<TranscriptionSource> {
    check_shareable(db, space, target, source, version)?;
    let Material::Audio {
        asset, duration_ms, ..
    } = &version.material
    else {
        return Err(Error::AssetUnavailable);
    };
    if asset.bytes > MAX_TRANSCRIPTION_BYTES {
        return Err(Error::Link(
            "TRANSCRIPTION_LIMIT",
            "Automatic transcription accepts WAV recordings up to 16 MiB",
        ));
    }
    validate_asset_ref(&mut db.prepare(ASSET_METADATA_QUERY)?, asset)?;
    Ok(TranscriptionSource {
        asset: asset.clone(),
        duration_ms: *duration_ms,
    })
}

fn save_transcript(
    document: &mut Document,
    root: &Dir,
    id: Uuid,
    revision: &str,
    segments: Vec<TranscriptSegment>,
    transcript_origin: Option<TranscriptOrigin>,
) -> Result<()> {
    let (source, previous) = current_audio(document, id, revision)?;
    let Material::Audio {
        asset, duration_ms, ..
    } = &previous.material
    else {
        return Err(Error::AssetUnavailable);
    };
    if AssetStore::open(root, false)?.wav_duration(asset)? != *duration_ms {
        return Err(Error::AssetIntegrity);
    }
    let version = Version::new(
        previous.title.clone(),
        Material::Audio {
            asset: asset.clone(),
            duration_ms: *duration_ms,
            segments,
            transcript_origin,
        },
        previous.upstream_revision.clone(),
    )?;
    document.save_version(Some(id), source.origin, version)
}

pub(super) fn apply(
    db: &Connection,
    root: &Dir,
    space: &mut Space,
    target: Uuid,
    action: Action,
    extract_pdf: PdfExtractor,
) -> Result<()> {
    let mut document = Document::from_content(&card(space, target)?.content)?;
    match action {
        Action::Capture {
            link_id,
            asset_id,
            pdf_text,
        } => {
            let (node, input) = resolve(db, space, target, link_id, asset_id)?;
            let origin = Origin::Linked {
                link_id,
                node_id: node.id,
                asset_id,
            };
            document.save_version(
                None,
                origin,
                input.capture(root, node.label.clone(), pdf_text, extract_pdf)?,
            )?;
        }
        Action::Refresh {
            source_id,
            pdf_text,
        } => {
            let origin = document.source(source_id)?.origin;
            let Origin::Linked {
                link_id,
                node_id,
                asset_id,
            } = origin
            else {
                return Err(Error::Invalid("Edit a manual source to save a new version"));
            };
            let (node, input) = resolve(db, space, target, link_id, asset_id)?;
            if node.id != node_id {
                return Err(Error::Link(
                    "SOURCE_CHANGED",
                    "The link now points to a different source",
                ));
            }
            document.save_version(
                Some(source_id),
                origin,
                input.capture(root, node.label.clone(), pdf_text, extract_pdf)?,
            )?;
        }
        Action::Manual {
            source_id,
            title,
            text,
        } => {
            document.save_version(
                source_id,
                Origin::Manual,
                Version::new(title, Material::Text { text }, None)?,
            )?;
        }
        Action::Cite {
            source_id,
            revision,
            start,
            end,
        } => document.cite(source_id, revision, start, end),
        Action::Conclude { text, citation_ids } => document.conclude(text, citation_ids)?,
        Action::SetTranscript {
            source_id,
            revision,
            segments,
        } => save_transcript(&mut document, root, source_id, &revision, segments, None)?,
        Action::SetProviderTranscript {
            source_id,
            revision,
            segments,
            origin,
        } => {
            if origin.source_revision != revision {
                return Err(Error::Invalid(
                    "The transcript belongs to another recording revision",
                ));
            }
            let (source, version) = current_audio(&document, source_id, &revision)?;
            verified_provider_audio(db, space, target, source, version)?;
            save_transcript(
                &mut document,
                root,
                source_id,
                &revision,
                segments,
                Some(origin),
            )?;
        }
        Action::SetProjectOnly {
            source_id,
            project_only,
        } => {
            let source = document
                .sources
                .iter_mut()
                .find(|source| source.id == source_id)
                .ok_or(Error::Invalid("That Research source is unavailable"))?;
            source.project_only = project_only;
        }
    }
    let node = space
        .nodes
        .iter_mut()
        .find(|node| node.id == target)
        .ok_or(Error::Invalid("That Research card is unavailable"))?;
    document.store(&mut node.content)?;
    space.validate()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResearchStatus {
    context_revision: String,
    sources: Vec<SourceStatus>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SourceStatus {
    id: Uuid,
    state: &'static str,
}

impl Project {
    pub fn research_transcription(
        &self,
        request: &TranscriptionRequest,
        destination: Option<&Path>,
        mut checkpoint: impl FnMut() -> Result<()>,
    ) -> Result<TranscriptionSource> {
        checkpoint()?;
        if self.id != request.project_id {
            return Err(Error::Link(
                "PROJECT_CHANGED",
                "Open the project again before transcribing audio",
            ));
        }
        let (space, _, _) = self.read_head()?;
        let document = Document::from_content(&card(&space, request.target_id)?.content)?;
        let (source, version) = current_audio(&document, request.source_id, &request.revision)?;
        let prepared =
            verified_provider_audio(&self.connection, &space, request.target_id, source, version)?;
        let store = AssetStore::open(&self.root, false)?;
        if let Some(path) = destination {
            store.export_with_checkpoint(&prepared.asset, path, checkpoint)?;
        } else {
            store.check_blob(&prepared.asset)?;
        }
        Ok(prepared)
    }

    pub fn research_status(&self, target: Uuid) -> Result<ResearchStatus> {
        let (space, _, _) = self.read_head()?;
        let document = Document::from_content(&card(&space, target)?.content)?;
        let mut sources = Vec::with_capacity(document.sources.len());
        for source in &document.sources {
            let state = match source.origin {
                Origin::Manual => "current",
                Origin::Linked {
                    link_id,
                    node_id,
                    asset_id,
                } => match resolve(&self.connection, &space, target, link_id, asset_id) {
                    Ok((node, input)) if node.id == node_id => {
                        let version = source
                            .versions
                            .iter()
                            .find(|version| version.revision == source.active_revision);
                        let current = input.revision()?;
                        if version.and_then(|version| version.upstream_revision.as_deref())
                            == Some(&current)
                        {
                            "current"
                        } else {
                            "changed"
                        }
                    }
                    _ => "unavailable",
                },
            };
            sources.push(SourceStatus {
                id: source.id,
                state,
            });
        }
        Ok(ResearchStatus {
            context_revision: document.context_revision()?,
            sources,
        })
    }

    pub fn research_preview(
        &self,
        target: Uuid,
        source_id: Uuid,
        revision: &str,
    ) -> Result<AssetPreview> {
        let asset = self.research_asset(target, source_id, revision)?;
        if !is_image(asset.format) {
            return Err(Error::AssetUnavailable);
        }
        AssetStore::open(&self.root, false)?.preview(&asset)
    }

    pub fn export_research_audio(
        &self,
        project_id: Uuid,
        target: Uuid,
        source_id: Uuid,
        revision: &str,
        destination: &Path,
    ) -> Result<()> {
        if self.id != project_id {
            return Err(Error::Link(
                "PROJECT_CHANGED",
                "Open the project again before playing its recording",
            ));
        }
        let asset = self.research_asset(target, source_id, revision)?;
        if asset.format != AssetFormat::Wav {
            return Err(Error::AssetUnavailable);
        }
        AssetStore::open(&self.root, false)?.export(&asset, destination)
    }

    fn research_asset(&self, target: Uuid, source_id: Uuid, revision: &str) -> Result<AssetRef> {
        let (space, _, _) = self.read_head()?;
        let document = Document::from_content(&card(&space, target)?.content)?;
        let asset = document
            .source(source_id)?
            .versions
            .iter()
            .find(|version| version.revision == revision)
            .and_then(|version| version.material.asset())
            .ok_or(Error::AssetUnavailable)?;
        validate_asset_ref(&mut self.connection.prepare(ASSET_METADATA_QUERY)?, asset)?;
        Ok(asset.clone())
    }
}
