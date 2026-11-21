use serde::{Deserialize, Serialize};

use super::*;
use crate::{
    data_links::PALETTE,
    palette::{self, Histogram, Swatch},
};

mod comparison;
mod document_text;
mod metadata;
mod records;
mod text_diff;

pub use self::comparison::{ComparisonRequest, ComparisonSide};
pub use self::metadata::{MetadataRequest, MetadataSummary};
use self::records::{AnalysisKind, AnalysisRecords};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PaletteRequest {
    pub operation_id: Uuid,
    pub base_revision: i64,
    pub target_id: Uuid,
    pub colors: u8,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AnalysisPhase {
    Working,
    Committing,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct AnalysisSource {
    link_id: Uuid,
    node_id: Uuid,
    port_id: String,
    contract_version: u32,
    revision: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Provenance {
    id: Uuid,
    source: AnalysisSource,
    project_revision: i64,
    calculated_at: String,
    algorithm: String,
    result_digest: String,
}

impl Provenance {
    fn new(
        db: &Connection,
        id: Uuid,
        source: AnalysisSource,
        project_revision: i64,
        algorithm: &str,
        result: &[u8],
    ) -> Result<Self> {
        Ok(Self {
            id,
            source,
            project_revision,
            calculated_at: database_time(db)?,
            algorithm: algorithm.into(),
            result_digest: digest(result),
        })
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaletteSummary {
    #[serde(flatten)]
    provenance: Provenance,
    colors: u8,
    aggregate: Vec<Swatch>,
    item_count: usize,
    transparent_count: usize,
    #[serde(default, skip_serializing_if = "super::sources::is_zero")]
    skipped_videos: usize,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PaletteFile {
    asset: AssetRef,
    swatches: Vec<Swatch>,
}

#[derive(Serialize, Deserialize)]
struct PaletteResult {
    aggregate: Vec<Swatch>,
    files: Vec<PaletteFile>,
    #[serde(default, skip_serializing_if = "super::sources::is_zero")]
    skipped_videos: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PalettePage {
    pub total: usize,
    pub next_offset: Option<usize>,
    files: Vec<PaletteFile>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisHistoryItem<T> {
    cursor: i64,
    summary: T,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisStatus<T> {
    pub state: &'static str,
    pub message: Option<String>,
    pub checked_at: String,
    pub latest: Option<T>,
}

pub type PaletteStatus = AnalysisStatus<PaletteSummary>;

impl PaletteSummary {
    pub(super) fn model_material(&self) -> Result<(Uuid, String, String, String)> {
        let body = serde_json::to_string(
            &serde_json::json!({ "swatches": self.aggregate, "itemCount": self.item_count }),
        )?;
        Ok((
            self.provenance.id,
            self.provenance.result_digest.clone(),
            self.provenance.algorithm.clone(),
            body,
        ))
    }
}

fn source_status<T>(
    db: &Connection,
    input: Result<AnalysisSource>,
    latest: Option<T>,
    origin: impl Fn(&T) -> &Provenance,
    algorithm: &str,
    connect_message: &str,
) -> Result<AnalysisStatus<T>> {
    analysis_status(
        db,
        input,
        latest,
        |source, record| {
            let provenance = origin(record);
            &provenance.source == source && provenance.algorithm == algorithm
        },
        connect_message,
    )
}

fn analysis_status<T, S>(
    db: &Connection,
    input: Result<S>,
    latest: Option<T>,
    is_current: impl FnOnce(&S, &T) -> bool,
    connect_message: &str,
) -> Result<AnalysisStatus<T>> {
    let (state, message) = match (input, &latest) {
        (Ok(source), Some(record)) => {
            if is_current(&source, record) {
                ("current", None)
            } else {
                ("stale", None)
            }
        }
        (Err(Error::Link("SOURCE_NOT_FOUND", _)), None) => {
            ("notCalculated", Some(connect_message.into()))
        }
        (Err(error), _) => ("sourceUnavailable", Some(error.to_string())),
        (Ok(_), None) => ("notCalculated", None),
    };
    Ok(AnalysisStatus {
        state,
        message,
        checked_at: database_time(db)?,
        latest,
    })
}

impl Project {
    pub fn run_palette(
        &self,
        request: &PaletteRequest,
        mut observe: impl FnMut(AnalysisPhase) -> Result<()>,
    ) -> Result<PaletteSummary> {
        if request.operation_id.is_nil() || !matches!(request.colors, 4 | 8 | 16) {
            return Err(Error::Invalid(
                "Choose 4, 8 or 16 colors and a valid operation ID",
            ));
        }
        let records =
            AnalysisRecords::new(&self.connection, AnalysisKind::Palette, request.target_id);
        let fingerprint = digest(&encode(request)?);
        if let Some(summary) = records.replay(request.operation_id, &fingerprint)? {
            return Ok(summary);
        }
        observe(AnalysisPhase::Working)?;
        let (space, revision, _) = self.read_head()?;
        if revision != request.base_revision {
            return Err(Error::StaleRevision { current: revision });
        }
        let input = AnalysisInput::resolve(self, &space, request.target_id, AnalysisKind::Palette)?;
        let collection = input.assets(&self.connection)?;
        let skipped_videos = match &input.collection {
            LinkedCollection::Managed(collection) => collection.skipped_videos(),
            LinkedCollection::Directory(_) => 0,
        };
        let mut combined = Histogram::default();
        let mut files = Vec::with_capacity(collection.len());
        let mut transparent_count = 0;
        if !collection.is_empty() {
            let store = AssetStore::open(&self.root, false).map_err(|_| Error::AssetIntegrity)?;
            let mut checkpoint = || observe(AnalysisPhase::Working);
            for asset in collection {
                checkpoint()?;
                let (image, profile) = store.analysis_image(&asset, &mut checkpoint)?;
                let swatches = palette::image_palette(
                    image,
                    &profile,
                    request.colors,
                    &mut combined,
                    &mut checkpoint,
                )?;
                if swatches.is_empty() {
                    transparent_count += 1;
                }
                files.push(PaletteFile { asset, swatches });
            }
        }
        let result = PaletteResult {
            aggregate: combined.colors(request.colors),
            files,
            skipped_videos,
        };
        let encoded = encode(&result)?;
        let summary = PaletteSummary {
            provenance: Provenance::new(
                &self.connection,
                request.operation_id,
                input.source,
                revision,
                palette::ALGORITHM,
                &encoded,
            )?,
            colors: request.colors,
            item_count: result.files.len(),
            aggregate: result.aggregate,
            transparent_count,
            skipped_videos,
        };
        records.commit(
            &summary.provenance,
            &fingerprint,
            &summary,
            encoded,
            &mut observe,
        )?;
        Ok(summary)
    }

    pub fn palette_status(&self, target_id: Uuid) -> Result<PaletteStatus> {
        let (space, _, _) = self.read_head()?;
        let kind = AnalysisKind::Palette;
        kind.check_target(&space, target_id)?;
        let latest =
            AnalysisRecords::new(&self.connection, kind, target_id).latest::<PaletteSummary>()?;
        let input = AnalysisInput::resolve(self, &space, target_id, kind)
            .and_then(|input| input.check_available(self));
        source_status(
            &self.connection,
            input,
            latest,
            |record| &record.provenance,
            palette::ALGORITHM,
            "Connect an image or Gallery in Space.",
        )
    }

    pub fn palette_history(
        &self,
        target_id: Uuid,
        before: Option<i64>,
    ) -> Result<Vec<AnalysisHistoryItem<PaletteSummary>>> {
        let (space, _, _) = self.read_head()?;
        let kind = AnalysisKind::Palette;
        kind.check_target(&space, target_id)?;
        AnalysisRecords::new(&self.connection, kind, target_id).history(before)
    }

    pub fn palette_files(
        &self,
        target_id: Uuid,
        result_id: Uuid,
        offset: usize,
        limit: usize,
    ) -> Result<PalettePage> {
        let (space, _, _) = self.read_head()?;
        let kind = AnalysisKind::Palette;
        kind.check_target(&space, target_id)?;
        let result: PaletteResult =
            AnalysisRecords::new(&self.connection, kind, target_id).result(result_id)?;
        let total = result.files.len();
        let end = page_bounds(offset, limit, total)?;
        let files = result
            .files
            .into_iter()
            .skip(offset)
            .take(end - offset)
            .collect();
        Ok(PalettePage {
            total,
            next_offset: (end < total).then_some(end),
            files,
        })
    }
}

fn database_time(db: &Connection) -> Result<String> {
    Ok(
        db.query_row("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now')", [], |row| {
            row.get(0)
        })?,
    )
}

struct AnalysisInput<'a> {
    source: AnalysisSource,
    collection: LinkedCollection<'a>,
}

impl<'a> AnalysisInput<'a> {
    fn resolve(
        project: &Project,
        space: &'a Space,
        target: Uuid,
        kind: AnalysisKind,
    ) -> Result<Self> {
        kind.check_target(space, target)?;
        let link = space
            .links
            .iter()
            .find(|link| link.target.node_id == target)
            .ok_or(Error::Link(
                "SOURCE_NOT_FOUND",
                "The connected file source is unavailable",
            ))?;
        let (node, link) = linked_source(space, target, link.id)?;
        let collection = LinkedCollection::from_link(project, node, link)?;
        let source = AnalysisSource {
            link_id: link.id,
            node_id: node.id,
            port_id: link.source.port_id.clone(),
            contract_version: link.contract_version,
            revision: collection.revision(),
        };
        Ok(Self { source, collection })
    }

    fn assets(&self, db: &Connection) -> Result<Vec<AssetRef>> {
        match &self.collection {
            LinkedCollection::Managed(collection) => collection.assets(db, 0..collection.len()),
            LinkedCollection::Directory(_) => {
                Err(Error::Invalid("Palette requires a managed image source"))
            }
        }
    }

    fn check_available(self, project: &Project) -> Result<AnalysisSource> {
        if let LinkedCollection::Managed(collection) = &self.collection
            && collection.len() != 0
        {
            let store =
                AssetStore::open(&project.root, false).map_err(|_| Error::AssetIntegrity)?;
            for asset in self.assets(&project.connection)? {
                store.check_blob(&asset)?;
            }
        }
        Ok(self.source)
    }
}
