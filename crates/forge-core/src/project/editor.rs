use image::{DynamicImage, RgbaImage};

use super::*;
use crate::{
    assets::encode_image_preview,
    editor::{
        self, Document, Graph, MAX_EXPORTS, MAX_INPUT_BYTES, OutputFormat, Recipe, Selection,
    },
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EditorPreviewRequest {
    pub operation_id: Uuid,
    base_revision: i64,
    target_id: Uuid,
    graph: Graph,
    selection: Option<Selection>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EditorExportRequest {
    pub operation_id: Uuid,
    base_revision: i64,
    target_id: Uuid,
    name: String,
    format: OutputFormat,
    repeat_version: Option<Uuid>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorPreview {
    width: u32,
    height: u32,
    image: AssetPreview,
}

fn node(space: &Space, id: Uuid) -> Result<&Node> {
    space
        .nodes
        .iter()
        .find(|node| node.id == id)
        .ok_or(Error::Invalid("Open an Editor card in this project"))
}

fn recipe(
    db: &Connection,
    space: &Space,
    id: Uuid,
    saved: &Document,
    selection: Option<&Selection>,
    graph: Graph,
) -> Result<Recipe> {
    let source = if let Some(selection) = selection {
        let (provider, link) = linked_source(space, id, selection.link_id)?;
        let collection = ManagedCollection::from_link(db, provider, link)?;
        check_source_revision(&collection.revision(), Some(&selection.source_revision))?;
        collection
            .version(db, selection.version_id)?
            .ok_or(Error::Link(
                "SOURCE_CHANGED",
                "The selected image is outside the connected source",
            ))?
    } else {
        saved
            .recipe
            .as_ref()
            .ok_or(Error::Invalid("Choose an input image"))?
            .source
            .clone()
    };
    let recipe = Recipe { source, graph };
    recipe.validate()?;
    Ok(recipe)
}

pub(super) fn apply(
    db: &Connection,
    space: &mut Space,
    id: Uuid,
    selection: Option<Selection>,
    graph: Graph,
) -> Result<()> {
    let mut doc = Document::from_content(&node(space, id)?.content)?;
    doc.recipe = Some(recipe(db, space, id, &doc, selection.as_ref(), graph)?);
    set_document(space, id, &doc)
}

fn set_document(space: &mut Space, id: Uuid, doc: &Document) -> Result<()> {
    let target = space
        .nodes
        .iter_mut()
        .find(|node| node.id == id)
        .ok_or(Error::Invalid("Open an Editor card in this project"))?;
    doc.save(&mut target.content)
}

fn render(
    store: &AssetStore,
    recipe: &Recipe,
    mut checkpoint: impl FnMut() -> Result<()>,
) -> Result<RgbaImage> {
    recipe.validate()?;
    let mut bytes = Vec::with_capacity(recipe.source.bytes.min(MAX_INPUT_BYTES) as usize);
    store.copy_verified_with_checkpoint(&recipe.source, &mut bytes, &mut checkpoint)?;
    editor::render(recipe, &bytes, checkpoint)
}

fn output_name(stem: &str, format: AssetFormat) -> Result<String> {
    let stem = stem.trim();
    let reserved = stem
        .split('.')
        .next()
        .unwrap_or_default()
        .trim_end()
        .to_ascii_uppercase();
    let device = matches!(
        reserved.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
    ) || (reserved.starts_with("COM") || reserved.starts_with("LPT"))
        && reserved[3..].chars().count() == 1
        && reserved[3..]
            .chars()
            .any(|ch| matches!(ch, '1'..='9' | '¹' | '²' | '³'));
    if stem.is_empty()
        || stem.chars().count() > 96
        || stem.ends_with('.')
        || device
        || stem.chars().any(char::is_control)
        || stem.contains(['<', '>', ':', '"', '/', '\\', '|', '?', '*'])
    {
        return Err(Error::Invalid("Enter a printable filename without a path"));
    }
    Ok(format!("{stem}.{}", format.suffix()))
}

impl Project {
    pub fn editor_preview(
        &self,
        request: &EditorPreviewRequest,
        mut observe: impl FnMut(AnalysisPhase) -> Result<()>,
    ) -> Result<EditorPreview> {
        if request.operation_id.is_nil() {
            return Err(Error::Invalid("Provide a valid preview operation ID"));
        }
        observe(AnalysisPhase::Working)?;
        let (space, revision, _) = self.read_head()?;
        if revision != request.base_revision {
            return Err(Error::StaleRevision { current: revision });
        }
        let doc = Document::from_content(&node(&space, request.target_id)?.content)?;
        let recipe = recipe(
            &self.connection,
            &space,
            request.target_id,
            &doc,
            request.selection.as_ref(),
            request.graph.clone(),
        )?;
        let store = AssetStore::open(&self.root, false).map_err(|_| Error::AssetIntegrity)?;
        let pixels = render(&store, &recipe, || observe(AnalysisPhase::Working))?;
        let (width, height) = pixels.dimensions();
        let image = encode_image_preview(DynamicImage::ImageRgba8(pixels))?;
        observe(AnalysisPhase::Committing)?;
        Ok(EditorPreview {
            width,
            height,
            image,
        })
    }

    pub fn editor_export(
        &mut self,
        request: &EditorExportRequest,
        mut observe: impl FnMut(AnalysisPhase) -> Result<()>,
    ) -> Result<ImportResult> {
        if request.operation_id.is_nil() || request.base_revision < 0 {
            return Err(Error::Invalid("Invalid Editor export request"));
        }
        let operation = request.operation_id.to_string();
        let fingerprint = digest(&encode(&("editorExport", request))?);
        if let Some(saved) = batch_replay(&self.connection, &operation, &fingerprint)? {
            return Ok(saved);
        }
        if self
            .connection
            .query_row(
                "SELECT 1 FROM revisions WHERE operation_id=?1",
                [&operation],
                |_| Ok(()),
            )
            .optional()?
            .is_some()
        {
            return Err(Error::Invalid(
                "Operation ID already used for another request",
            ));
        }
        let format = request.format.format();
        let name = output_name(&request.name, format)?;
        observe(AnalysisPhase::Working)?;
        let (mut space, head, _) = self.read_head()?;
        if head != request.base_revision {
            return Err(Error::StaleRevision { current: head });
        }
        let target = node(&space, request.target_id)?;
        let bottom = space
            .nodes
            .iter()
            .filter(|node| (node.position.x - target.position.x).abs() < 250.0)
            .fold(target.position.y, |bottom, node| {
                bottom.max(node.position.y)
            });
        let position = Position {
            x: target.position.x,
            y: (bottom + 155.0).min(1_000_000.0),
        };
        let mut doc = Document::from_content(&target.content)?;
        let recipe = match request.repeat_version {
            Some(version) => doc
                .exports
                .iter()
                .find(|entry| entry.asset.version_id == version)
                .map(|entry| entry.recipe.clone()),
            None => doc.recipe.clone(),
        }
        .ok_or(Error::Invalid(
            "Save a recipe or choose an available export",
        ))?;
        let store = AssetStore::open(&self.root, false).map_err(|_| Error::AssetIntegrity)?;
        store.recover(&self.connection)?;
        let pixels = render(&store, &recipe, || observe(AnalysisPhase::Working))?;
        let bytes =
            editor::encode_output(pixels, request.format, || observe(AnalysisPhase::Working))?;
        let asset =
            store.prepare_generated_image(&self.connection, name, format, &bytes, || {
                observe(AnalysisPhase::Working)
            })?;
        let finish = (|| {
            doc.exports.insert(
                0,
                editor::Export {
                    asset: asset.clone(),
                    recipe,
                },
            );
            doc.exports.truncate(MAX_EXPORTS);
            set_document(&mut space, request.target_id, &doc)?;
            let node_id = Uuid::new_v4();
            space.nodes.push(Node {
                id: node_id,
                label: asset.name.clone(),
                position,
                content: Content::Asset {
                    asset: asset.clone(),
                },
            });
            space.validate()?;
            observe(AnalysisPhase::Committing)?;
            let tx = self
                .connection
                .transaction_with_behavior(TransactionBehavior::Immediate)?;
            let current: i64 =
                tx.query_row("SELECT revision FROM head WHERE id=1", [], |row| row.get(0))?;
            if current != head {
                return Err(Error::StaleRevision { current });
            }
            record_asset_version(&tx, &asset)?;
            validate_asset_refs(&tx, &space)?;
            let revision = head.checked_add(1).ok_or(Error::Limit)?;
            append_revision(
                &tx,
                revision,
                &space,
                &operation,
                &fingerprint,
                "editorExport",
                Navigation {
                    undo: Some(head),
                    redo: None,
                },
            )?;
            let response = ImportResult {
                revision,
                items: vec![ImportItem {
                    name: asset.name.clone(),
                    asset: Some(asset),
                    node_id: Some(node_id),
                    error_code: None,
                    message: None,
                }],
            };
            tx.execute("INSERT INTO asset_import_batches(operation_id, request_digest, response) VALUES (?1, ?2, ?3)",
                params![operation, fingerprint, encode(&response)?])?;
            tx.commit()?;
            Ok(response)
        })();
        if finish.is_err() {
            store.recover(&self.connection)?;
        }
        finish
    }
}
