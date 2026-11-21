use std::io::{self, Cursor};

use exif::{Exif, In, Reader, Tag, Value};
use image::ImageDecoder;

use super::*;
use crate::assets::{MAX_EDIT_TEXT_BYTES, MAX_FILE_BYTES, image_reader};

const ALGORITHM: &str = "forge.metadata.verified-headers.v1";
const MAX_EXIF_BYTES: usize = 256 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MetadataRequest {
    pub operation_id: Uuid,
    pub base_revision: i64,
    pub target_id: Uuid,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MetadataSummary {
    #[serde(flatten)]
    provenance: Provenance,
    item_count: usize,
    #[serde(default, skip_serializing_if = "super::super::sources::is_zero")]
    unavailable_count: usize,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct MetadataFile {
    asset: SourceFile,
    image: Option<ImageMetadata>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    issue: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ImageMetadata {
    width: u32,
    height: u32,
    exif: ExifStatus,
    fields: Vec<MetadataField>,
    location_available: bool,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
enum ExifStatus {
    Absent,
    Available,
    Unreadable,
}

#[derive(Debug, Deserialize, Serialize)]
struct MetadataField {
    label: String,
    value: String,
}

enum ImageExif {
    Absent,
    Available(Exif),
    Unreadable,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MetadataPage {
    total: usize,
    next_offset: Option<usize>,
    files: Vec<MetadataFile>,
}

#[derive(Debug, Serialize)]
pub struct ExifLocation {
    latitude: f64,
    longitude: f64,
}

impl Project {
    pub fn run_metadata(
        &self,
        request: &MetadataRequest,
        mut observe: impl FnMut(AnalysisPhase) -> Result<()>,
    ) -> Result<MetadataSummary> {
        if request.operation_id.is_nil() {
            return Err(Error::Invalid("Provide a valid analysis operation ID"));
        }
        let kind = AnalysisKind::Metadata;
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
        let input = AnalysisInput::resolve(self, &space, request.target_id, kind)?;
        let assets = input
            .collection
            .files(&self.connection, 0..input.collection.len())?;
        let mut files = Vec::with_capacity(assets.len());
        let mut budget = MAX_BATCH_BYTES;
        let mut checkpoint = || observe(AnalysisPhase::Working);
        for asset in assets {
            checkpoint()?;
            files.push(read_metadata(self, asset, &mut budget, &mut checkpoint)?);
        }
        let unavailable_count = input.collection.unavailable_count();
        input.collection.verify_revision(self)?;
        let encoded = encode(&files)?;
        let summary = MetadataSummary {
            provenance: Provenance::new(
                &self.connection,
                request.operation_id,
                input.source,
                revision,
                ALGORITHM,
                &encoded,
            )?,
            item_count: files.len(),
            unavailable_count,
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

    pub fn metadata_status(&self, target: Uuid) -> Result<AnalysisStatus<MetadataSummary>> {
        let (space, _, _) = self.read_head()?;
        let kind = AnalysisKind::Metadata;
        kind.check_target(&space, target)?;
        let latest =
            AnalysisRecords::new(&self.connection, kind, target).latest::<MetadataSummary>()?;
        let input = AnalysisInput::resolve(self, &space, target, kind)
            .and_then(|input| input.check_available(self));
        source_status(
            &self.connection,
            input,
            latest,
            |record| &record.provenance,
            ALGORITHM,
            "Connect a file, Gallery or Directory in Space.",
        )
    }

    pub fn metadata_history(
        &self,
        target: Uuid,
        before: Option<i64>,
    ) -> Result<Vec<AnalysisHistoryItem<MetadataSummary>>> {
        let (space, _, _) = self.read_head()?;
        let kind = AnalysisKind::Metadata;
        kind.check_target(&space, target)?;
        AnalysisRecords::new(&self.connection, kind, target).history(before)
    }

    pub fn metadata_files(
        &self,
        target: Uuid,
        result: Uuid,
        offset: usize,
        limit: usize,
    ) -> Result<MetadataPage> {
        let (space, _, _) = self.read_head()?;
        let kind = AnalysisKind::Metadata;
        kind.check_target(&space, target)?;
        let files: Vec<MetadataFile> =
            AnalysisRecords::new(&self.connection, kind, target).result(result)?;
        let total = files.len();
        let end = page_bounds(offset, limit, total)?;
        let files = files.into_iter().skip(offset).take(end - offset).collect();
        Ok(MetadataPage {
            total,
            next_offset: (end < total).then_some(end),
            files,
        })
    }

    pub fn metadata_location(
        &self,
        target: Uuid,
        result: Uuid,
        version: Uuid,
    ) -> Result<Option<ExifLocation>> {
        let (space, _, _) = self.read_head()?;
        let kind = AnalysisKind::Metadata;
        let input = AnalysisInput::resolve(self, &space, target, kind)?;
        let records = AnalysisRecords::new(&self.connection, kind, target);
        let latest = records.latest::<MetadataSummary>()?;
        if !latest.is_some_and(|record| {
            record.provenance.id == result
                && record.provenance.source == input.source
                && record.provenance.algorithm == ALGORITHM
        }) {
            return Err(Error::Link(
                "SOURCE_CHANGED",
                "Show location from the current result for this source",
            ));
        }
        let asset = input
            .collection
            .version(&self.connection, version)?
            .ok_or(Error::Link(
                "SOURCE_NOT_FOUND",
                "This version is outside the connected files",
            ))?;
        let Some(format) = asset.format().filter(|format| is_image(*format)) else {
            return Ok(None);
        };
        let files: Vec<MetadataFile> = records.result(result)?;
        let Some(mut saved) = files
            .into_iter()
            .find(|file| {
                file.asset.same_version(&asset)
                    && file
                        .image
                        .as_ref()
                        .is_some_and(|image| image.location_available)
            })
            .map(|file| file.asset)
        else {
            return Ok(None);
        };
        let mut bytes = Vec::with_capacity(asset.bytes() as usize);
        saved.verify(self, &mut bytes, MAX_FILE_BYTES, || Ok(()))?;
        let (_, _, exif) = image_header(bytes, format)?;
        Ok(match exif {
            ImageExif::Available(data) => location(&data),
            _ => None,
        })
    }
}

fn read_metadata(
    project: &Project,
    mut asset: SourceFile,
    budget: &mut u64,
    checkpoint: &mut impl FnMut() -> Result<()>,
) -> Result<MetadataFile> {
    let directory = matches!(asset, SourceFile::Directory(_));
    let mut issue = None;
    if directory {
        if asset.bytes() > MAX_FILE_BYTES {
            issue = Some("File exceeds the 128 MiB reading limit.".into());
        } else if asset.bytes() > *budget {
            issue = Some("Directory calculation reached its 512 MiB reading budget.".into());
        }
        if issue.is_some() {
            return Ok(MetadataFile {
                asset,
                image: None,
                issue,
            });
        }
        *budget -= asset.bytes();
    }
    let image_format = asset.format().filter(|format| is_image(*format));
    let inspect_text = directory
        && matches!(asset.format(), Some(AssetFormat::Txt | AssetFormat::Md))
        && asset.bytes() <= MAX_EDIT_TEXT_BYTES as u64;
    let mut bytes = Vec::new();
    if image_format.is_some() || inspect_text {
        asset.verify(project, &mut bytes, MAX_FILE_BYTES, &mut *checkpoint)?;
    } else {
        asset.verify(project, &mut io::sink(), MAX_FILE_BYTES, &mut *checkpoint)?;
    }
    checkpoint()?;
    let image = if let Some(format) = image_format {
        match image_header(bytes, format) {
            Ok((width, height, exif)) => {
                let (status, fields, location_available) = match exif {
                    ImageExif::Absent => (ExifStatus::Absent, vec![], false),
                    ImageExif::Unreadable => (ExifStatus::Unreadable, vec![], false),
                    ImageExif::Available(data) => (
                        ExifStatus::Available,
                        exif_fields(&data),
                        location(&data).is_some(),
                    ),
                };
                Some(ImageMetadata {
                    width,
                    height,
                    exif: status,
                    fields,
                    location_available,
                })
            }
            Err(_) if directory => {
                issue = Some("Image header is unavailable for the named format.".into());
                None
            }
            Err(error) => return Err(error),
        }
    } else {
        if inspect_text && std::str::from_utf8(&bytes).is_err() {
            issue = Some("File is not valid UTF-8.".into());
        }
        None
    };
    Ok(MetadataFile {
        asset,
        image,
        issue,
    })
}

fn image_header(bytes: Vec<u8>, format: AssetFormat) -> Result<(u32, u32, ImageExif)> {
    let mut decoder = image_reader(Cursor::new(bytes), format)?
        .into_decoder()
        .map_err(|_| Error::AssetIntegrity)?;
    let (width, height) = decoder.dimensions();
    let exif = match decoder.exif_metadata() {
        Ok(None) => ImageExif::Absent,
        Ok(Some(bytes)) if bytes.len() <= MAX_EXIF_BYTES => Reader::new()
            .read_raw(bytes)
            .map_or(ImageExif::Unreadable, ImageExif::Available),
        Ok(Some(_)) | Err(_) => ImageExif::Unreadable,
    };
    Ok((width, height, exif))
}

fn exif_fields(exif: &Exif) -> Vec<MetadataField> {
    [
        (Tag::Make, "Camera make"),
        (Tag::Model, "Camera model"),
        (Tag::Orientation, "EXIF orientation"),
        (Tag::ExposureTime, "Exposure"),
        (Tag::FNumber, "Aperture"),
        (Tag::PhotographicSensitivity, "ISO"),
        (Tag::FocalLength, "Focal length"),
    ]
    .into_iter()
    .filter_map(|(tag, label)| {
        let value = &exif.get_field(tag, In::PRIMARY)?.value;
        let value = match tag {
            Tag::Make | Tag::Model => camera_text(value)?,
            Tag::Orientation => value
                .get_uint(0)
                .filter(|value| (1..=8).contains(value))?
                .to_string(),
            Tag::PhotographicSensitivity => value.get_uint(0)?.to_string(),
            Tag::ExposureTime | Tag::FNumber | Tag::FocalLength => {
                let Value::Rational(values) = value else {
                    return None;
                };
                let [rational] = values.as_slice() else {
                    return None;
                };
                if rational.denom == 0 {
                    return None;
                }
                match tag {
                    Tag::ExposureTime if rational.denom > rational.num => {
                        format!("{}/{} s", rational.num, rational.denom)
                    }
                    Tag::ExposureTime => format!("{:.2} s", rational.to_f64()),
                    Tag::FNumber => format!("f/{:.2}", rational.to_f64()),
                    _ => format!("{:.2} mm", rational.to_f64()),
                }
            }
            _ => return None,
        };
        Some(MetadataField {
            label: label.into(),
            value,
        })
    })
    .collect()
}

fn camera_text(value: &Value) -> Option<String> {
    let Value::Ascii(text) = value else {
        return None;
    };
    let raw = text.first()?;
    let bounded: String = raw
        .iter()
        .copied()
        .filter(|byte| (32..=126).contains(byte))
        .take(96)
        .map(char::from)
        .collect();
    let text = bounded.trim();
    (!text.is_empty()).then(|| text.to_owned())
}

fn location(exif: &Exif) -> Option<ExifLocation> {
    Some(ExifLocation {
        latitude: coordinate(
            exif,
            Tag::GPSLatitude,
            Tag::GPSLatitudeRef,
            b"N",
            b"S",
            90.0,
        )?,
        longitude: coordinate(
            exif,
            Tag::GPSLongitude,
            Tag::GPSLongitudeRef,
            b"E",
            b"W",
            180.0,
        )?,
    })
}

fn coordinate(
    exif: &Exif,
    tag: Tag,
    direction: Tag,
    positive: &[u8],
    negative: &[u8],
    max: f64,
) -> Option<f64> {
    let Value::Rational(parts) = &exif.get_field(tag, In::PRIMARY)?.value else {
        return None;
    };
    let [degrees, minutes, seconds] = parts.as_slice() else {
        return None;
    };
    if parts.iter().any(|part| part.denom == 0) {
        return None;
    }
    let (degrees, minutes, seconds) = (degrees.to_f64(), minutes.to_f64(), seconds.to_f64());
    let absolute = degrees + minutes / 60.0 + seconds / 3600.0;
    if absolute > max || minutes >= 60.0 || seconds >= 60.0 {
        return None;
    }
    let Value::Ascii(direction) = &exif.get_field(direction, In::PRIMARY)?.value else {
        return None;
    };
    match direction.first()?.as_slice() {
        value if value == positive => Some(absolute),
        value if value == negative => Some(-absolute),
        _ => None,
    }
}
