use std::{collections::HashSet, io};

use super::*;
use crate::{
    intelligent::{self, Citation, Context, ContextRequest, Kind, ManifestItem, Material, Pick},
    research::{self as saved, PdfExtraction},
};

const MAX_RAW_BYTES: usize = 16 * 1024 * 1024;

struct Builder {
    materials: Vec<Material>,
    bytes: usize,
    raw_bytes: usize,
}

struct TextSource {
    item_id: Option<Uuid>,
    kind: Kind,
    revision: String,
    extraction: String,
    citations: Vec<Citation>,
    text: String,
}

impl TextSource {
    fn plain(kind: Kind, revision: String, extraction: impl Into<String>, text: String) -> Self {
        Self {
            item_id: None,
            kind,
            revision,
            extraction: extraction.into(),
            citations: Vec::new(),
            text,
        }
    }
}

impl Builder {
    fn charge_input(&mut self, bytes: usize) -> Result<()> {
        self.raw_bytes = self
            .raw_bytes
            .checked_add(bytes)
            .ok_or_else(intelligent::quota)?;
        if self.raw_bytes > MAX_RAW_BYTES {
            return Err(intelligent::quota());
        }
        Ok(())
    }

    fn add(&mut self, node: &Node, link_id: Uuid, source: TextSource) -> Result<()> {
        intelligent::check_material(&source.text)?;
        self.bytes += source.text.len();
        if self.bytes > intelligent::MAX_CONTEXT_BYTES
            || self.materials.len() >= intelligent::MAX_SOURCES
        {
            return Err(intelligent::quota());
        }
        self.materials.push(Material {
            manifest: ManifestItem {
                link_id,
                node_id: node.id,
                item_id: source.item_id,
                title: node.label.clone(),
                kind: source.kind,
                revision: source.revision,
                extraction: source.extraction,
                bytes: source.text.len(),
                content_sha256: intelligent::sha(&source.text),
                citations: source.citations,
            },
            text: source.text,
        });
        Ok(())
    }
}

impl Project {
    pub fn model_context(&self, request: ContextRequest) -> Result<Context> {
        if request.project_id != self.id {
            return Err(Error::Link(
                "PROJECT_CHANGED",
                "Open the project again before preparing model context",
            ));
        }
        if request.selections.is_empty() || request.selections.len() > intelligent::MAX_SOURCES {
            return Err(intelligent::quota());
        }
        let (space, _, _) = self.read_head()?;
        if !space.nodes.iter().any(|node| {
            node.id == request.target_id
                && matches!(&node.content,
            Content::Portal { type_id, schema_version: 1, .. } if type_id == intelligent::TYPE_ID)
        }) {
            return Err(Error::Invalid("Open an Intelligent card in this project"));
        }
        let mut builder = Builder {
            materials: Vec::new(),
            bytes: 0,
            raw_bytes: 0,
        };
        let mut used = HashSet::new();
        for selection in request.selections {
            if !used.insert(selection.link_id) {
                return Err(Error::Invalid("Select each context link once"));
            }
            let (node, link) = linked_source(&space, request.target_id, selection.link_id)?;
            if node.id != selection.node_id {
                return Err(Error::Link(
                    "SOURCE_CHANGED",
                    "The selected link points to a different source",
                ));
            }
            let source = match selection.pick {
                Pick::Palette if link.data_type == DataType::ColorPalette => {
                    let status = self.palette_status(node.id)?;
                    let latest =
                        status
                            .latest
                            .filter(|_| status.state == "current")
                            .ok_or(Error::Link(
                                "SOURCE_CHANGED",
                                "Calculate a current Palette before sending it",
                            ))?;
                    let (id, revision, extraction, text) = latest.model_material()?;
                    builder.charge_input(text.len())?;
                    let mut source = TextSource::plain(Kind::Palette, revision, extraction, text);
                    source.item_id = Some(id);
                    source
                }
                Pick::Dataset { offset, limit } if link.data_type == DataType::TabularData => {
                    let payload = Dataset::payload(&node.content)?;
                    builder.charge_input(payload.len())?;
                    let data = Dataset::decode(payload)?;
                    TextSource::plain(
                        Kind::DatasetRows,
                        intelligent::sha(payload),
                        "dataset-rows-v1",
                        data.model_rows(offset, limit)?,
                    )
                }
                Pick::Site
                    if link.data_type == DataType::TextContent
                        && link.source.port_id == "quote" =>
                {
                    let Content::Portal {
                        type_id, payload, ..
                    } = &node.content
                    else {
                        return Err(unsupported());
                    };
                    if type_id != crate::site::TYPE_ID {
                        return Err(unsupported());
                    }
                    let reference =
                        crate::site::Site::decode(payload)?
                            .reference
                            .ok_or(Error::Link(
                                "MODEL_CONTEXT_EMPTY",
                                "Save an explicit Site quote first",
                            ))?;
                    let revision = saved::site_revision(&reference)?;
                    builder.charge_input(reference.quote.len())?;
                    TextSource::plain(Kind::SiteQuote, revision, "site-quote-v1", reference.quote)
                }
                Pick::Text
                    if link.data_type == DataType::TextContent && link.source.port_id == "text" =>
                {
                    let text = if let Content::Asset { asset } = &node.content {
                        builder.charge_input(asset.bytes as usize)?;
                        validate_asset_ref(
                            &mut self.connection.prepare(ASSET_METADATA_QUERY)?,
                            asset,
                        )?;
                        AssetStore::open(&self.root, false)?.read_text(asset)?
                    } else {
                        let text =
                            data_links::inline_text(&node.content)?.ok_or_else(unsupported)?;
                        builder.charge_input(text.len())?;
                        text.into_owned()
                    };
                    TextSource::plain(Kind::Text, intelligent::sha(&text), "literal-text-v1", text)
                }
                Pick::Research { source_ids } if link.data_type == DataType::ResearchSources => {
                    if source_ids.is_empty()
                        || source_ids.len() > intelligent::MAX_SOURCES - builder.materials.len()
                    {
                        return Err(intelligent::quota());
                    }
                    let document = saved::Document::from_content(&node.content)?;
                    let mut seen = HashSet::new();
                    for id in source_ids {
                        if !seen.insert(id) {
                            return Err(Error::Invalid("Select each captured source once"));
                        }
                        let material =
                            self.model_research(&space, node.id, &document, id, &mut builder)?;
                        builder.add(node, link.id, material)?;
                    }
                    continue;
                }
                _ => return Err(unsupported()),
            };
            builder.add(node, link.id, source)?;
        }
        let bindings = builder
            .materials
            .iter()
            .map(|material| {
                let item = &material.manifest;
                (
                    item.link_id,
                    item.node_id,
                    item.item_id,
                    item.kind,
                    &item.revision,
                    &item.extraction,
                    &item.content_sha256,
                )
            })
            .collect::<Vec<_>>();
        let digest = saved::fingerprint(&(self.id, request.target_id, bindings))?;
        Ok(Context {
            materials: builder.materials,
            bytes: builder.bytes,
            digest,
        })
    }

    fn model_research(
        &self,
        space: &Space,
        target: Uuid,
        document: &saved::Document,
        id: Uuid,
        builder: &mut Builder,
    ) -> Result<TextSource> {
        let source = document.source(id)?;
        let version = source
            .versions
            .iter()
            .find(|item| item.revision == source.active_revision)
            .ok_or(Error::Corrupt("Missing captured source version"))?;
        research::check_shareable(&self.connection, space, target, source, version)?;
        let (kind, extraction) = match &version.material {
            saved::Material::Site { .. } => (Kind::SiteQuote, "site-quote-v1"),
            saved::Material::Pdf {
                extraction: PdfExtraction::Manual,
                ..
            } => (Kind::PdfText, "manual-pdf-v1"),
            saved::Material::Pdf { .. } => (Kind::PdfText, "pdf-text-layer-v1"),
            saved::Material::Audio {
                transcript_origin: Some(_),
                ..
            } => (Kind::AudioTranscript, "whisper-cpp-transcript-v1"),
            saved::Material::Audio { .. } => (Kind::AudioTranscript, "audio-transcript-v1"),
            _ => (Kind::Text, "literal-text-v1"),
        };
        let text = version.material.text().ok_or_else(unsupported)?;
        let bytes = version
            .material
            .asset()
            .map_or(text.len(), |asset| asset.bytes as usize);
        builder.charge_input(bytes)?;
        if let Some(asset) = version.material.asset() {
            AssetStore::open(&self.root, false)?.copy_verified_with_checkpoint(
                asset,
                &mut io::sink(),
                || Ok(()),
            )?;
        }
        let citations = document
            .citations
            .iter()
            .filter(|item| item.source_id == id && item.revision == version.revision)
            .map(|item| Citation {
                id: item.id,
                start: item.start,
                end: item.end,
            })
            .collect();
        Ok(TextSource {
            item_id: Some(id),
            kind,
            revision: version.revision.clone(),
            extraction: extraction.into(),
            citations,
            text: text.into_owned(),
        })
    }
}

fn unsupported() -> Error {
    Error::Link(
        "MODEL_CONTEXT_UNSUPPORTED",
        "This source has no supported model context on the selected link",
    )
}
