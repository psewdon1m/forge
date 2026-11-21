use std::{borrow::Cow, io::Cursor};

use image::{DynamicImage, GrayImage, RgbaImage};

use super::document_text::{MAX_DOCX_BYTES, docx_text};
use super::text_diff::{self, DiffLine, TextDiff};
use super::*;
use crate::{
    assets::{
        MAX_EDIT_TEXT_BYTES, MAX_FILE_BYTES, decode_image, encode_image_preview, image_reader,
        preview_image,
    },
    research::MAX_PDF_BYTES,
};

const ALGORITHM_V1: &str = "forge.comparison.lines-and-images.v1";
const ALGORITHM: &str = "forge.comparison.documents-and-pixels.v2";
const PIXEL_LIMIT: u64 = 4_000_000;
type PdfExtraction = fn(&[u8], &mut dyn FnMut() -> Result<()>) -> Result<String>;

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Selection {
    link_id: Uuid,
    source_revision: String,
    version_id: Option<Uuid>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ComparisonRequest {
    pub operation_id: Uuid,
    base_revision: i64,
    target_id: Uuid,
    left: Selection,
    right: Selection,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Choice {
    name: String,
    asset: Option<SourceFile>,
}

impl Choice {
    fn from_asset(asset: SourceFile) -> Self {
        Self {
            name: asset.name().into(),
            asset: Some(asset),
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComparisonChoices {
    source_revision: String,
    total: usize,
    next_offset: Option<usize>,
    items: Vec<Choice>,
    #[serde(skip_serializing_if = "super::super::sources::is_zero")]
    unavailable_count: usize,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ComparedInput {
    source: AnalysisSource,
    choice: Choice,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
enum ComparisonMode {
    Text,
    Images,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComparisonSummary {
    #[serde(flatten)]
    provenance: Provenance,
    pair: [ComparedInput; 2],
    mode: ComparisonMode,
    rows: usize,
    added: usize,
    removed: usize,
    alignment_limited: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pixel_comparison: Option<PixelComparison>,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(
    tag = "state",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
enum PixelComparison {
    Compared {
        width: u32,
        height: u32,
        changed_pixels: u32,
    },
    DimensionsDiffer,
    PixelLimit,
}

#[derive(Deserialize, Serialize)]
#[serde(
    tag = "mode",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
enum ComparisonData {
    Text {
        diff: TextDiff,
    },
    Images {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pixel_comparison: Option<PixelComparison>,
    },
}

#[derive(Deserialize, Serialize)]
struct ComparisonResult {
    pair: [ComparedInput; 2],
    data: ComparisonData,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComparisonPage {
    total: usize,
    next_offset: Option<usize>,
    lines: Vec<DiffLine>,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ComparisonSide {
    Left,
    Right,
    Difference,
}

enum InputKind<'a> {
    Note { name: &'a str, text: Cow<'a, str> },
    Files(LinkedCollection<'a>),
}

struct Input<'a> {
    source: AnalysisSource,
    kind: InputKind<'a>,
}

impl<'a> Input<'a> {
    fn resolve(project: &Project, space: &'a Space, target: Uuid, id: Uuid) -> Result<Self> {
        let (node, link) = linked_source(space, target, id)?;
        let (kind, revision) = match (&node.content, link.data_type) {
            (Content::Asset { asset }, DataType::TextContent) => (
                InputKind::Files(LinkedCollection::Managed(ManagedCollection::File(asset))),
                asset.version_id.to_string(),
            ),
            (content, DataType::TextContent) => {
                let text = crate::data_links::inline_text(content)?.ok_or(Error::Link(
                    "SOURCE_NOT_FOUND",
                    "The linked text is unavailable",
                ))?;
                let revision = digest(text.as_bytes());
                (
                    InputKind::Note {
                        name: &node.label,
                        text,
                    },
                    revision,
                )
            }
            _ => {
                let files = LinkedCollection::from_link(project, node, link)?;
                let revision = files.revision();
                (InputKind::Files(files), revision)
            }
        };
        Ok(Self {
            source: AnalysisSource {
                link_id: id,
                node_id: node.id,
                port_id: link.source.port_id.clone(),
                contract_version: link.contract_version,
                revision,
            },
            kind,
        })
    }

    fn choice(&self, db: &Connection, version: Option<Uuid>) -> Result<Choice> {
        match (&self.kind, version) {
            (InputKind::Note { name, .. }, None) => Ok(Choice {
                name: (*name).into(),
                asset: None,
            }),
            (InputKind::Files(files), Some(id)) => files
                .version(db, id)?
                .map(Choice::from_asset)
                .ok_or(Error::Link(
                    "SOURCE_CHANGED",
                    "The selected version is outside the connected files",
                )),
            _ => Err(Error::Invalid("Choose an item from the connected source")),
        }
    }

    fn same_provider(&self, saved: &AnalysisSource) -> bool {
        self.source.node_id == saved.node_id
            && self.source.port_id == saved.port_id
            && self.source.contract_version == saved.contract_version
    }

    fn verify_revision(&self, project: &Project) -> Result<()> {
        if let InputKind::Files(files) = &self.kind {
            files.verify_revision(project)?;
        }
        Ok(())
    }
}

impl Project {
    pub fn comparison_choices(
        &self,
        target: Uuid,
        link: Uuid,
        expected: Option<&str>,
        offset: usize,
        limit: usize,
    ) -> Result<ComparisonChoices> {
        let (space, _, _) = self.read_head()?;
        AnalysisKind::Comparison.check_target(&space, target)?;
        let input = Input::resolve(self, &space, target, link)?;
        check_source_revision(&input.source.revision, expected)?;
        let total = match &input.kind {
            InputKind::Note { .. } => 1,
            InputKind::Files(files) => files.len(),
        };
        let end = page_bounds(offset, limit, total)?;
        let unavailable_count = match &input.kind {
            InputKind::Note { .. } => 0,
            InputKind::Files(files) => files.unavailable_count(),
        };
        let items = match input.kind {
            InputKind::Note { name, .. } if offset == 0 => vec![Choice {
                name: name.into(),
                asset: None,
            }],
            InputKind::Note { .. } => vec![],
            InputKind::Files(files) => files
                .files(&self.connection, offset..end)?
                .into_iter()
                .map(Choice::from_asset)
                .collect(),
        };
        Ok(ComparisonChoices {
            source_revision: input.source.revision,
            total,
            next_offset: (end < total).then_some(end),
            items,
            unavailable_count,
        })
    }

    pub fn run_comparison(
        &self,
        request: &ComparisonRequest,
        observe: impl FnMut(AnalysisPhase) -> Result<()>,
    ) -> Result<ComparisonSummary> {
        self.run_comparison_with_pdf_extractor(request, observe, |_, _| {
            Err(Error::Link(
                "PDF_UNAVAILABLE",
                "PDF text extraction needs the desktop worker",
            ))
        })
    }

    pub fn run_comparison_with_pdf_extractor(
        &self,
        request: &ComparisonRequest,
        mut observe: impl FnMut(AnalysisPhase) -> Result<()>,
        extract_pdf: PdfExtraction,
    ) -> Result<ComparisonSummary> {
        if request.operation_id.is_nil() {
            return Err(Error::Invalid("Provide a valid analysis operation ID"));
        }
        let kind = AnalysisKind::Comparison;
        let records = AnalysisRecords::new(&self.connection, kind, request.target_id);
        let fingerprint = digest(&encode(request)?);
        if let Some(summary) = records.replay(request.operation_id, &fingerprint)? {
            return Ok(summary);
        }
        observe(AnalysisPhase::Working)?;
        let (space, revision, _) = self.read_head()?;
        if revision != request.base_revision {
            return Err(Error::StaleRevision { current: revision });
        }
        kind.check_target(&space, request.target_id)?;
        let left = Input::resolve(self, &space, request.target_id, request.left.link_id)?;
        let second = (request.left.link_id != request.right.link_id)
            .then(|| Input::resolve(self, &space, request.target_id, request.right.link_id))
            .transpose()?;
        let right = second.as_ref().unwrap_or(&left);
        check_source_revision(&left.source.revision, Some(&request.left.source_revision))?;
        check_source_revision(&right.source.revision, Some(&request.right.source_revision))?;
        let mut left_choice = left.choice(&self.connection, request.left.version_id)?;
        let mut right_choice = right.choice(&self.connection, request.right.version_id)?;
        let same_item = match (&left_choice.asset, &right_choice.asset) {
            (Some(left), Some(right)) => left.same_version(right),
            (None, None) => left.source.node_id == right.source.node_id,
            _ => false,
        };
        if same_item {
            return Err(Error::Invalid("Choose two different items to compare"));
        }
        let mode = choice_mode(&left_choice);
        if mode.is_none() || mode != choice_mode(&right_choice) {
            return Err(Error::Link(
                "COMPARISON_UNSUPPORTED",
                "Choose two text sources (note, TXT, Markdown, DOCX or PDF), or two images",
            ));
        }
        let mode = mode.expect("matching comparison formats");
        let mut checkpoint = || observe(AnalysisPhase::Working);
        let data = match mode {
            ComparisonMode::Text => {
                let a =
                    comparison_text(self, &left, &mut left_choice, &mut checkpoint, extract_pdf)?;
                let b =
                    comparison_text(self, right, &mut right_choice, &mut checkpoint, extract_pdf)?;
                ComparisonData::Text {
                    diff: text_diff::compare(&a, &b, &mut checkpoint)?,
                }
            }
            ComparisonMode::Images => {
                let left = image_input(
                    self,
                    left_choice.asset.as_mut().ok_or(Error::AssetUnavailable)?,
                    &mut checkpoint,
                )?;
                let right = image_input(
                    self,
                    right_choice.asset.as_mut().ok_or(Error::AssetUnavailable)?,
                    &mut checkpoint,
                )?;
                ComparisonData::Images {
                    pixel_comparison: Some(compare_pixels(&left, &right, &mut checkpoint, |_| {})?),
                }
            }
        };
        left.verify_revision(self)?;
        if second.is_some() {
            right.verify_revision(self)?;
        }
        let result = ComparisonResult {
            pair: [
                ComparedInput {
                    source: left.source.clone(),
                    choice: left_choice,
                },
                ComparedInput {
                    source: right.source.clone(),
                    choice: right_choice,
                },
            ],
            data,
        };
        let (rows, added, removed, alignment_limited, pixel_comparison) = match &result.data {
            ComparisonData::Text { diff } => (
                diff.rows,
                diff.added,
                diff.removed,
                diff.alignment_limited,
                None,
            ),
            ComparisonData::Images { pixel_comparison } => (0, 0, 0, false, *pixel_comparison),
        };
        let encoded = encode(&result)?;
        let summary = ComparisonSummary {
            provenance: Provenance::new(
                &self.connection,
                request.operation_id,
                result.pair[0].source.clone(),
                revision,
                ALGORITHM,
                &encoded,
            )?,
            pair: result.pair,
            mode,
            rows,
            added,
            removed,
            alignment_limited,
            pixel_comparison,
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

    pub fn comparison_status(&self, target: Uuid) -> Result<AnalysisStatus<ComparisonSummary>> {
        let (space, _, _) = self.read_head()?;
        let kind = AnalysisKind::Comparison;
        kind.check_target(&space, target)?;
        let latest =
            AnalysisRecords::new(&self.connection, kind, target).latest::<ComparisonSummary>()?;
        let current = match &latest {
            None if space.links.iter().any(|link| link.target.node_id == target) => Ok(false),
            None => Err(Error::Link(
                "SOURCE_NOT_FOUND",
                "There are no connected sources",
            )),
            Some(result) => self.check_comparison_inputs(&space, target, &result.pair),
        };
        analysis_status(
            &self.connection,
            current,
            latest,
            |current, record| {
                *current
                    && matches!(
                        record.provenance.algorithm.as_str(),
                        ALGORITHM | ALGORITHM_V1
                    )
            },
            "Connect a file, note, Gallery or Directory in Space.",
        )
    }

    fn check_comparison_inputs(
        &self,
        space: &Space,
        target: Uuid,
        pair: &[ComparedInput; 2],
    ) -> Result<bool> {
        let mut current = true;
        for saved in pair {
            let input = Input::resolve(self, space, target, saved.source.link_id)?;
            if input.source != saved.source {
                current = false;
                continue;
            }
            let choice = input.choice(
                &self.connection,
                saved.choice.asset.as_ref().map(SourceFile::version_id),
            )?;
            if let Some(SourceFile::Managed(asset)) = choice.asset {
                AssetStore::open(&self.root, false)
                    .map_err(|_| Error::AssetIntegrity)?
                    .check_blob(&asset)?;
            }
        }
        Ok(current)
    }

    pub fn comparison_history(
        &self,
        target: Uuid,
        before: Option<i64>,
    ) -> Result<Vec<AnalysisHistoryItem<ComparisonSummary>>> {
        let (space, _, _) = self.read_head()?;
        let kind = AnalysisKind::Comparison;
        kind.check_target(&space, target)?;
        AnalysisRecords::new(&self.connection, kind, target).history(before)
    }

    pub fn comparison_lines(
        &self,
        target: Uuid,
        result: Uuid,
        offset: usize,
        limit: usize,
    ) -> Result<ComparisonPage> {
        let kind = AnalysisKind::Comparison;
        let (space, _, _) = self.read_head()?;
        kind.check_target(&space, target)?;
        let saved: ComparisonResult =
            AnalysisRecords::new(&self.connection, kind, target).result(result)?;
        let ComparisonData::Text { diff } = saved.data else {
            return Err(Error::Invalid(
                "This result does not contain a text comparison",
            ));
        };
        let end = page_bounds(offset, limit, diff.rows)?;
        Ok(ComparisonPage {
            total: diff.rows,
            next_offset: (end < diff.rows).then_some(end),
            lines: diff.page(offset, end),
        })
    }

    pub fn comparison_preview(
        &self,
        target: Uuid,
        result: Uuid,
        side: ComparisonSide,
    ) -> Result<AssetPreview> {
        let kind = AnalysisKind::Comparison;
        let (space, _, _) = self.read_head()?;
        kind.check_target(&space, target)?;
        let saved: ComparisonResult =
            AnalysisRecords::new(&self.connection, kind, target).result(result)?;
        let ComparisonData::Images { pixel_comparison } = saved.data else {
            return Err(Error::Invalid("This result does not contain images"));
        };
        let index = match side {
            ComparisonSide::Left => 0,
            ComparisonSide::Right => 1,
            ComparisonSide::Difference => {
                let Some(expected @ PixelComparison::Compared { width, height, .. }) =
                    pixel_comparison
                else {
                    return Err(Error::Invalid(
                        "This result does not contain a pixel difference",
                    ));
                };
                let mut left = self
                    .comparison_image_source(&space, target, &saved.pair[0])?
                    .clone();
                let mut right = self
                    .comparison_image_source(&space, target, &saved.pair[1])?
                    .clone();
                let left = image_input(self, &mut left, &mut || Ok(()))?;
                let right = image_input(self, &mut right, &mut || Ok(()))?;
                if left.dimensions != (width, height)
                    || right.dimensions != (width, height)
                    || u64::from(width) * u64::from(height) > PIXEL_LIMIT
                {
                    return Err(Error::AssetIntegrity);
                }
                let mut mask = GrayImage::from_pixel(width, height, image::Luma([255]));
                let measured = compare_pixels(&left, &right, &mut || Ok(()), |index| {
                    mask.as_mut()[index] = 0
                })?;
                if measured != expected {
                    return Err(Error::AssetIntegrity);
                }
                return encode_image_preview(DynamicImage::ImageLuma8(mask));
            }
        };
        let asset = self.comparison_image_source(&space, target, &saved.pair[index])?;
        match asset {
            SourceFile::Managed(asset) => AssetStore::open(&self.root, false)
                .map_err(|_| Error::AssetIntegrity)?
                .preview(asset),
            SourceFile::Directory(_) => {
                let format = asset
                    .format()
                    .filter(|format| is_image(*format))
                    .ok_or(Error::AssetIntegrity)?;
                let mut bytes = Vec::new();
                asset
                    .clone()
                    .verify(self, &mut bytes, MAX_FILE_BYTES, || Ok(()))?;
                preview_image(bytes, format)
            }
        }
    }

    fn comparison_image_source<'a>(
        &self,
        space: &Space,
        target: Uuid,
        item: &'a ComparedInput,
    ) -> Result<&'a SourceFile> {
        let input = Input::resolve(self, space, target, item.source.link_id)?;
        if !input.same_provider(&item.source) {
            return Err(Error::Link(
                "SOURCE_CHANGED",
                "The original image source is unavailable",
            ));
        }
        let asset = item
            .choice
            .asset
            .as_ref()
            .ok_or(Error::Corrupt("An image comparison has no image version"))?;
        let live = input
            .choice(&self.connection, Some(asset.version_id()))?
            .asset
            .ok_or(Error::AssetUnavailable)?;
        if !asset.same_version(&live) {
            return Err(Error::AssetIntegrity);
        }
        Ok(asset)
    }
}

fn choice_mode(choice: &Choice) -> Option<ComparisonMode> {
    match choice.asset.as_ref().map(SourceFile::format) {
        None
        | Some(Some(AssetFormat::Txt | AssetFormat::Md | AssetFormat::Pdf | AssetFormat::Docx)) => {
            Some(ComparisonMode::Text)
        }
        Some(Some(format)) if is_image(format) => Some(ComparisonMode::Images),
        _ => None,
    }
}

fn comparison_text(
    project: &Project,
    input: &Input<'_>,
    choice: &mut Choice,
    checkpoint: &mut impl FnMut() -> Result<()>,
    extract_pdf: PdfExtraction,
) -> Result<String> {
    if let InputKind::Note { text, .. } = &input.kind {
        return Ok(text.as_ref().to_owned());
    }
    let asset = choice.asset.as_mut().ok_or(Error::AssetUnavailable)?;
    let format = asset.format().ok_or(Error::AssetUnavailable)?;
    let (limit, message) = match format {
        AssetFormat::Pdf => (
            MAX_PDF_BYTES,
            "PDF comparison supports up to 8 MiB per file",
        ),
        AssetFormat::Docx => (
            MAX_DOCX_BYTES,
            "DOCX comparison supports up to 8 MiB per file",
        ),
        _ => (
            MAX_EDIT_TEXT_BYTES as u64,
            "TXT and Markdown comparison supports up to 256 KiB per file",
        ),
    };
    if asset.bytes() > limit {
        return Err(Error::Link("LIMIT_EXCEEDED", message));
    }
    let mut bytes = Vec::new();
    asset.verify(project, &mut bytes, limit, &mut *checkpoint)?;
    match format {
        AssetFormat::Pdf => extract_pdf(&bytes, checkpoint).map_err(comparison_pdf_error),
        AssetFormat::Docx => docx_text(&bytes, checkpoint),
        _ => String::from_utf8(bytes)
            .map_err(|_| Error::Invalid("The linked text file is not valid UTF-8")),
    }
}

fn comparison_pdf_error(error: Error) -> Error {
    match error {
        Error::Link("NO_EXTRACTABLE_TEXT", _) => Error::Link(
            "NO_EXTRACTABLE_TEXT",
            "This PDF has no extractable text. Choose a PDF with a text layer.",
        ),
        Error::Link("PDF_LIMIT", _) => {
            Error::Link("PDF_LIMIT", "The PDF exceeds the text extraction limits")
        }
        Error::Link("PDF_UNREADABLE", _) => {
            Error::Link("PDF_UNREADABLE", "The PDF text layer could not be read")
        }
        Error::Link("PDF_TIMEOUT", _) => {
            Error::Link("PDF_TIMEOUT", "PDF text extraction timed out")
        }
        other => other,
    }
}

struct ImageInput {
    dimensions: (u32, u32),
    pixels: Option<RgbaImage>,
}

fn image_input(
    project: &Project,
    asset: &mut SourceFile,
    checkpoint: &mut impl FnMut() -> Result<()>,
) -> Result<ImageInput> {
    let format = asset
        .format()
        .filter(|format| is_image(*format))
        .ok_or(Error::AssetIntegrity)?;
    let mut bytes = Vec::new();
    asset.verify(project, &mut bytes, MAX_FILE_BYTES, &mut *checkpoint)?;
    let dimensions = image_reader(Cursor::new(&bytes), format)?
        .into_dimensions()
        .map_err(|_| Error::Invalid("Invalid image header"))?;
    let eligible = u64::from(dimensions.0) * u64::from(dimensions.1) <= PIXEL_LIMIT;
    checkpoint()?;
    let pixels = if eligible {
        Some(decode_image(Cursor::new(bytes), format)?.into_rgba8())
    } else {
        if matches!(asset, SourceFile::Directory(_)) {
            decode_image(Cursor::new(bytes), format)?;
        }
        None
    };
    checkpoint()?;
    Ok(ImageInput { dimensions, pixels })
}

fn compare_pixels(
    left: &ImageInput,
    right: &ImageInput,
    checkpoint: &mut impl FnMut() -> Result<()>,
    mut on_difference: impl FnMut(usize),
) -> Result<PixelComparison> {
    if left.dimensions != right.dimensions {
        return Ok(PixelComparison::DimensionsDiffer);
    }
    let (Some(a), Some(b)) = (&left.pixels, &right.pixels) else {
        return Ok(PixelComparison::PixelLimit);
    };
    let mut changed_pixels = 0;
    let pairs = a.pixels().zip(b.pixels());
    for (index, (left, right)) in pairs.enumerate() {
        if index % 4096 == 0 {
            checkpoint()?;
        }
        if left.0[3] != right.0[3] || (left.0[3] != 0 && left.0[..3] != right.0[..3]) {
            changed_pixels += 1;
            on_difference(index);
        }
    }
    let (width, height) = left.dimensions;
    Ok(PixelComparison::Compared {
        width,
        height,
        changed_pixels,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compares_alpha_and_ignores_rgb_in_fully_transparent_pixels() {
        let image = |bytes| ImageInput {
            dimensions: (3, 1),
            pixels: RgbaImage::from_raw(3, 1, bytes),
        };
        let left = image(vec![7, 0, 0, 0, 7, 0, 0, 120, 7, 0, 0, 121]);
        let right = image(vec![8, 0, 0, 0, 8, 0, 0, 120, 7, 0, 0, 110]);
        let mut positions = Vec::new();
        let comparison =
            compare_pixels(&left, &right, &mut || Ok(()), |index| positions.push(index)).unwrap();
        assert_eq!(positions, [1, 2]);
        assert_eq!(
            comparison,
            PixelComparison::Compared {
                width: 3,
                height: 1,
                changed_pixels: 2
            }
        );
        let large = ImageInput {
            dimensions: (3000, 3000),
            pixels: None,
        };
        assert_eq!(
            compare_pixels(&large, &large, &mut || Ok(()), |_| {}).unwrap(),
            PixelComparison::PixelLimit
        );
    }

    #[test]
    fn reads_and_preserves_legacy_image_result_shape() {
        let stored = r#"{"mode":"images"}"#;
        let old: ComparisonData = serde_json::from_str(stored).unwrap();
        assert!(matches!(
            old,
            ComparisonData::Images {
                pixel_comparison: None
            }
        ));
        assert_eq!(serde_json::to_string(&old).unwrap(), stored);
    }
}
