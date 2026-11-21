use std::{
    fs,
    io::{self, BufRead, BufReader, Cursor, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
};

use cap_fs_ext::{DirExt, FollowSymlinks, OpenOptionsFollowExt};
use cap_std::{
    ambient_authority,
    fs::{Dir, File, OpenOptions},
};
use image::{DynamicImage, ImageDecoder, ImageFormat, ImageReader, Limits};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{Error, Position, Result, model::validate_label};

pub const MAX_FILE_BYTES: u64 = 128 * 1024 * 1024;
pub const MAX_BATCH_BYTES: u64 = 512 * 1024 * 1024;
pub const MAX_FILES: usize = 50;
const MAX_PIXELS: u64 = 40_000_000;
const MAX_IMAGE_ALLOC: u64 = 384 * 1024 * 1024;
const TEXT_PREVIEW_BYTES: usize = 64 * 1024;
pub const MAX_EDIT_TEXT_BYTES: usize = 256 * 1024;
const IMAGE_PREVIEW_EDGE: u32 = 512;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AssetFormat {
    Png,
    Jpeg,
    Webp,
    Txt,
    Md,
    Pdf,
    Docx,
    Wav,
    Webm,
    Mp4,
}

impl AssetFormat {
    fn is_text(self) -> bool {
        matches!(self, Self::Txt | Self::Md)
    }

    pub(crate) fn from_path(path: &Path) -> Result<Self> {
        match path
            .extension()
            .and_then(|part| part.to_str())
            .map(str::to_ascii_lowercase)
            .as_deref()
        {
            Some("png") => Ok(Self::Png),
            Some("jpg" | "jpeg") => Ok(Self::Jpeg),
            Some("webp") => Ok(Self::Webp),
            Some("txt") => Ok(Self::Txt),
            Some("md") => Ok(Self::Md),
            Some("pdf") => Ok(Self::Pdf),
            Some("docx") => Ok(Self::Docx),
            Some("wav") => Ok(Self::Wav),
            Some("webm") => Ok(Self::Webm),
            Some("mp4") => Ok(Self::Mp4),
            _ => Err(Error::Invalid("Unsupported file format")),
        }
    }

    pub fn suffix(self) -> &'static str {
        match self {
            Self::Png => "png",
            Self::Jpeg => "jpeg",
            Self::Webp => "webp",
            Self::Txt => "txt",
            Self::Md => "md",
            Self::Pdf => "pdf",
            Self::Docx => "docx",
            Self::Wav => "wav",
            Self::Webm => "webm",
            Self::Mp4 => "mp4",
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssetRef {
    pub asset_id: Uuid,
    pub version_id: Uuid,
    pub name: String,
    pub format: AssetFormat,
    pub bytes: u64,
    pub sha256: String,
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AssetPreview {
    Text { text: String, truncated: bool },
    Image { png: Vec<u8> },
    Document,
}

impl AssetRef {
    pub(crate) fn validate(&self) -> Result<()> {
        validate_label(&self.name)?;
        if self.asset_id.is_nil()
            || self.version_id.is_nil()
            || self.bytes == 0
            || self.bytes > MAX_FILE_BYTES
            || !valid_sha(&self.sha256)
            || self.name.contains(['/', '\\', ':'])
        {
            return Err(Error::Invalid("Invalid asset version"));
        }
        Ok(())
    }
}

pub(crate) fn valid_sha(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImportRequest {
    pub operation_id: Uuid,
    pub base_revision: i64,
    pub paths: Vec<PathBuf>,
    pub position: Position,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub revision: i64,
    pub items: Vec<ImportItem>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(
    tag = "phase",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ImportProgress {
    Copying {
        file_index: usize,
        total_files: usize,
        bytes: u64,
        file_bytes: u64,
    },
    Committing {
        total_files: usize,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportItem {
    pub name: String,
    pub asset: Option<AssetRef>,
    pub node_id: Option<Uuid>,
    pub error_code: Option<String>,
    pub message: Option<String>,
}

pub(crate) struct AssetStore {
    staging: Dir,
    blobs: Dir,
}

struct FileIdentity<'a> {
    format: AssetFormat,
    name: String,
    asset_id: Uuid,
    previous_digest: Option<&'a str>,
}

impl AssetStore {
    pub fn open(root: &Dir, create: bool) -> Result<Self> {
        let metadata = root.open_dir_nofollow(".forge")?;
        if create {
            ensure_dir(root, "assets")?;
            ensure_dir(&metadata, "staging")?;
        }
        Ok(Self {
            staging: metadata.open_dir_nofollow("staging")?,
            blobs: root.open_dir_nofollow("assets")?,
        })
    }

    pub fn preview(&self, asset: &AssetRef) -> Result<AssetPreview> {
        match asset.format {
            AssetFormat::Txt | AssetFormat::Md => {
                let mut prefix = AssetPrefix(Vec::with_capacity(TEXT_PREVIEW_BYTES));
                self.copy_verified(asset, &mut prefix)?;
                let truncated = asset.bytes > TEXT_PREVIEW_BYTES as u64;
                if let Err(error) = std::str::from_utf8(&prefix.0) {
                    if !truncated || error.error_len().is_some() {
                        return Err(Error::AssetIntegrity);
                    }
                    prefix.0.truncate(error.valid_up_to());
                }
                let text = String::from_utf8(prefix.0).map_err(|_| Error::AssetIntegrity)?;
                Ok(AssetPreview::Text { text, truncated })
            }
            AssetFormat::Png | AssetFormat::Jpeg | AssetFormat::Webp => {
                let mut original = Vec::with_capacity(asset.bytes as usize);
                self.copy_verified(asset, &mut original)?;
                preview_image(original, asset.format)
            }
            AssetFormat::Pdf
            | AssetFormat::Docx
            | AssetFormat::Wav
            | AssetFormat::Webm
            | AssetFormat::Mp4 => {
                self.copy_verified(asset, &mut io::sink())?;
                Ok(AssetPreview::Document)
            }
        }
    }

    pub fn export(&self, asset: &AssetRef, destination: &Path) -> Result<()> {
        self.export_with_checkpoint(asset, destination, || Ok(()))
    }

    pub(crate) fn export_with_checkpoint(
        &self,
        asset: &AssetRef,
        destination: &Path,
        mut checkpoint: impl FnMut() -> Result<()>,
    ) -> Result<()> {
        if !destination.is_absolute() || AssetFormat::from_path(destination)? != asset.format {
            return Err(Error::Invalid("Save the file with its original format"));
        }
        publish_export(destination, |output| {
            self.copy_verified_with_checkpoint(asset, output, &mut checkpoint)?;
            checkpoint()
        })
    }

    fn copy_verified(&self, asset: &AssetRef, output: &mut impl Write) -> Result<()> {
        self.copy_verified_with_checkpoint(asset, output, || Ok(()))
    }

    pub(crate) fn wav_duration(&self, asset: &AssetRef) -> Result<u64> {
        if asset.format != AssetFormat::Wav {
            return Err(Error::AssetUnavailable);
        }
        let mut prefix = AssetPrefix(Vec::with_capacity(TEXT_PREVIEW_BYTES));
        self.copy_verified(asset, &mut prefix)?;
        crate::wav::duration(&prefix.0, asset.bytes)
    }

    fn open_asset_blob(&self, asset: &AssetRef) -> Result<File> {
        let file = open_regular(
            &self.blobs,
            blob_name(asset.version_id, asset.format.suffix()),
        )
        .map_err(|_| Error::AssetIntegrity)?;
        if file.metadata()?.len() != asset.bytes {
            return Err(Error::AssetIntegrity);
        }
        Ok(file)
    }

    pub(crate) fn check_blob(&self, asset: &AssetRef) -> Result<()> {
        self.open_asset_blob(asset).map(|_| ())
    }

    pub(crate) fn copy_verified_with_checkpoint(
        &self,
        asset: &AssetRef,
        output: &mut impl Write,
        mut checkpoint: impl FnMut() -> Result<()>,
    ) -> Result<()> {
        let mut file = self.open_asset_blob(asset)?;
        let mut remaining = asset.bytes;
        let (bytes, sha256) =
            copy_and_hash_progress(&mut file, output, &mut remaining, |_| checkpoint()).map_err(
                |error| {
                    if matches!(error, Error::Invalid(_)) {
                        Error::AssetIntegrity
                    } else {
                        error
                    }
                },
            )?;
        if bytes != asset.bytes || sha256 != asset.sha256 {
            return Err(Error::AssetIntegrity);
        }
        Ok(())
    }

    pub(crate) fn analysis_image(
        &self,
        asset: &AssetRef,
        checkpoint: &mut impl FnMut() -> Result<()>,
    ) -> Result<(DynamicImage, crate::palette::ColorSource)> {
        use crate::palette::{ColorSource, PngColor};

        let mut original = Vec::with_capacity(asset.bytes as usize);
        self.copy_verified_with_checkpoint(asset, &mut original, &mut *checkpoint)?;
        checkpoint()?;
        let png_color = (asset.format == AssetFormat::Png)
            .then(|| PngColor::read(&original))
            .transpose()?;
        let mut decoder = image_reader(Cursor::new(original), asset.format)?
            .into_decoder()
            .map_err(|_| Error::AssetIntegrity)?;
        let mut limit = Limits::default();
        limit.max_alloc = Some(MAX_IMAGE_ALLOC);
        limit
            .reserve(decoder.total_bytes())
            .map_err(|_| Error::AssetIntegrity)?;
        decoder
            .set_limits(limit)
            .map_err(|_| Error::AssetIntegrity)?;
        let color = match png_color {
            Some(cicp @ PngColor::Cicp { .. }) => ColorSource::Png(cicp),
            lower_priority => match decoder.icc_profile().map_err(|_| Error::AssetIntegrity)? {
                Some(icc) if icc.len() > 4 * 1024 * 1024 => {
                    return Err(Error::Invalid("Image color profile exceeds 4 MiB"));
                }
                Some(icc) => ColorSource::Icc(icc),
                None => lower_priority.map_or(ColorSource::Decoder, ColorSource::Png),
            },
        };
        let image = DynamicImage::from_decoder(decoder).map_err(|_| Error::AssetIntegrity)?;
        checkpoint()?;
        Ok((image, color))
    }

    pub fn read_text(&self, asset: &AssetRef) -> Result<String> {
        self.read_text_with_checkpoint(asset, || Ok(()))
    }

    pub(crate) fn read_text_with_checkpoint(
        &self,
        asset: &AssetRef,
        checkpoint: impl FnMut() -> Result<()>,
    ) -> Result<String> {
        if !asset.format.is_text() {
            return Err(Error::Invalid("Only TXT and Markdown can be edited here"));
        }
        if asset.bytes > MAX_EDIT_TEXT_BYTES as u64 {
            return Err(Error::Invalid("The file exceeds the 256 KiB editor limit"));
        }
        let mut bytes = Vec::with_capacity(asset.bytes as usize);
        self.copy_verified_with_checkpoint(asset, &mut bytes, checkpoint)?;
        String::from_utf8(bytes).map_err(|_| Error::AssetIntegrity)
    }

    pub fn prepare_text(
        &self,
        db: &Connection,
        previous: &AssetRef,
        text: &str,
    ) -> Result<AssetRef> {
        if text.len() > MAX_EDIT_TEXT_BYTES {
            return Err(Error::Invalid("The text exceeds the 256 KiB editor limit"));
        }
        if text.is_empty() || text.as_bytes().contains(&0) {
            return Err(Error::Invalid(
                "Enter nonempty UTF-8 text without NUL characters",
            ));
        }
        if self.read_text(previous)? == text {
            return Err(Error::Invalid("The file text has no changes"));
        }
        self.stage(
            db,
            previous.format,
            previous.name.clone(),
            previous.asset_id,
            |output| {
                output.write_all(text.as_bytes())?;
                Ok((
                    text.len() as u64,
                    format!("{:x}", Sha256::digest(text.as_bytes())),
                ))
            },
        )
    }

    pub(crate) fn prepare_generated_image(
        &self,
        db: &Connection,
        name: String,
        format: AssetFormat,
        bytes: &[u8],
        mut checkpoint: impl FnMut() -> Result<()>,
    ) -> Result<AssetRef> {
        if !matches!(format, AssetFormat::Png | AssetFormat::Jpeg) || bytes.is_empty() {
            return Err(Error::Invalid("Invalid generated image"));
        }
        let mut remaining = MAX_FILE_BYTES;
        self.stage(db, format, name, Uuid::new_v4(), |output| {
            copy_and_hash_progress(&mut Cursor::new(bytes), output, &mut remaining, |_| {
                checkpoint()
            })
        })
    }

    pub fn prepare(
        &self,
        db: &Connection,
        source: &Path,
        remaining: &mut u64,
        previous: Option<&AssetRef>,
    ) -> Result<AssetRef> {
        self.prepare_with_progress(db, source, remaining, previous, |_, _| Ok(()))
    }

    pub fn prepare_with_progress(
        &self,
        db: &Connection,
        source: &Path,
        remaining: &mut u64,
        previous: Option<&AssetRef>,
        mut progress: impl FnMut(u64, u64) -> Result<()>,
    ) -> Result<AssetRef> {
        let name = source_name(source)?;
        let format = AssetFormat::from_path(source)?;
        if previous.is_some_and(|asset| asset.format != format) {
            return Err(Error::Invalid(
                "Choose a replacement with the original format",
            ));
        }
        let asset_id = previous.map_or_else(Uuid::new_v4, |asset| asset.asset_id);
        self.stage_file(
            db,
            source,
            remaining,
            FileIdentity {
                format,
                name,
                asset_id,
                previous_digest: None,
            },
            &mut progress,
        )
    }

    pub fn prepare_edited_document(
        &self,
        db: &Connection,
        source: &Path,
        previous: &AssetRef,
    ) -> Result<AssetRef> {
        if !matches!(previous.format, AssetFormat::Pdf | AssetFormat::Docx)
            || AssetFormat::from_path(source)? != previous.format
        {
            return Err(Error::Invalid(
                "Choose an edited PDF or DOCX of the original format",
            ));
        }
        self.copy_verified(previous, &mut io::sink())?;
        let mut remaining = MAX_FILE_BYTES;
        self.stage_file(
            db,
            source,
            &mut remaining,
            FileIdentity {
                format: previous.format,
                name: previous.name.clone(),
                asset_id: previous.asset_id,
                previous_digest: Some(&previous.sha256),
            },
            &mut |_, _| Ok(()),
        )
    }

    fn stage_file(
        &self,
        db: &Connection,
        source: &Path,
        remaining: &mut u64,
        identity: FileIdentity<'_>,
        progress: &mut impl FnMut(u64, u64) -> Result<()>,
    ) -> Result<AssetRef> {
        let mut input = open_source(source)?;
        let initial = input.metadata()?;
        if initial.len() == 0 {
            return Err(Error::Invalid("The file is empty"));
        }
        if initial.len() > MAX_FILE_BYTES || initial.len() > *remaining {
            return Err(Error::Invalid("File or batch size limit exceeded"));
        }
        let FileIdentity {
            format,
            name,
            asset_id,
            previous_digest,
        } = identity;
        progress(0, initial.len())?;
        self.stage(db, format, name, asset_id, |output| {
            let (bytes, sha256) =
                copy_and_hash_progress(&mut input, output, remaining, |copied| {
                    progress(copied, initial.len())
                })?;
            let final_metadata = input.metadata()?;
            if bytes != initial.len()
                || final_metadata.len() != bytes
                || initial.modified()? != final_metadata.modified()?
            {
                return Err(Error::Invalid("The source file changed during import"));
            }
            if previous_digest == Some(sha256.as_str()) {
                return Err(Error::Invalid(
                    "The edit copy is unchanged. Save changes in the editor first",
                ));
            }
            Ok((bytes, sha256))
        })
    }

    fn stage(
        &self,
        db: &Connection,
        format: AssetFormat,
        name: String,
        asset_id: Uuid,
        write: impl FnOnce(&mut File) -> Result<(u64, String)>,
    ) -> Result<AssetRef> {
        let version_id = Uuid::new_v4();
        let version = version_id.to_string();
        let staged = stage_name(version_id);
        let blob = blob_name(version_id, format.suffix());

        db.execute(
            "INSERT INTO asset_intents(version_id, suffix) VALUES (?1, ?2)",
            params![version, format.suffix()],
        )?;
        let mut published = false;
        let result = (|| {
            let mut options = OpenOptions::new();
            options
                .read(true)
                .write(true)
                .create_new(true)
                .follow(FollowSymlinks::No);
            let mut output = self.staging.open_with(&staged, &options)?;
            let (bytes, sha256) = write(&mut output)?;
            output.seek(SeekFrom::Start(0))?;
            validate_content(&mut output, format)?;
            output.sync_all()?;
            drop(output);
            db.execute(
                "UPDATE asset_intents SET bytes=?1, sha256=?2 WHERE version_id=?3",
                params![bytes as i64, sha256, version],
            )?;
            self.staging.hard_link(&staged, &self.blobs, &blob)?;
            published = true;
            self.staging.remove_file(&staged)?;
            Ok(AssetRef {
                asset_id,
                version_id,
                name,
                format,
                bytes,
                sha256,
            })
        })();

        if result.is_err() {
            if published {
                unlink_if_present(&self.blobs, &blob)?;
            }
            unlink_if_present(&self.staging, &staged)?;
            db.execute("DELETE FROM asset_intents WHERE version_id=?1", [&version])?;
        }
        result
    }

    pub fn recover(&self, db: &Connection) -> Result<()> {
        let mut statement =
            db.prepare("SELECT version_id, suffix, bytes, sha256 FROM asset_intents LIMIT 51")?;
        let intents: Vec<_> = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<i64>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                ))
            })?
            .collect::<rusqlite::Result<_>>()?;
        drop(statement);
        if intents.len() > MAX_FILES {
            return Err(Error::Corrupt("Unexpected number of unfinished imports"));
        }
        for (id, suffix, size, sha256) in intents {
            let id_value =
                Uuid::parse_str(&id).map_err(|_| Error::Corrupt("Invalid import intent ID"))?;
            if id_value.is_nil()
                || !matches!(
                    suffix.as_str(),
                    "png"
                        | "jpeg"
                        | "webp"
                        | "txt"
                        | "md"
                        | "pdf"
                        | "docx"
                        | "wav"
                        | "webm"
                        | "mp4"
                )
            {
                return Err(Error::Corrupt("Invalid import intent"));
            }
            if db
                .query_row(
                    "SELECT 1 FROM asset_versions WHERE version_id=?1",
                    [&id],
                    |_| Ok(()),
                )
                .optional()?
                .is_some()
            {
                return Err(Error::Corrupt("Published asset has an unfinished intent"));
            }
            let blob = blob_name(id_value, &suffix);
            match self.blobs.symlink_metadata(&blob) {
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
                Ok(metadata) => {
                    let expected_size = size.and_then(|bytes| u64::try_from(bytes).ok());
                    let mut file = open_regular(&self.blobs, &blob)?;
                    if !metadata.is_file()
                        || expected_size != Some(file.metadata()?.len())
                        || !sha256.as_ref().is_some_and(|value| valid_sha(value))
                    {
                        return Err(Error::Corrupt(
                            "An unfinished import does not match its recorded metadata",
                        ));
                    }
                    let mut budget = MAX_FILE_BYTES;
                    let (bytes, digest) = copy_and_hash(&mut file, &mut io::sink(), &mut budget)?;
                    if Some(bytes) != expected_size || Some(digest) != sha256 {
                        return Err(Error::Corrupt("An unfinished import failed its checksum"));
                    }
                    self.blobs.remove_file(&blob)?;
                }
            }
            unlink_if_present(&self.staging, &stage_name(id_value))?;
            db.execute("DELETE FROM asset_intents WHERE version_id=?1", [&id])?;
        }
        Ok(())
    }
}

struct AssetPrefix(Vec<u8>);

impl Write for AssetPrefix {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        let retain = bytes.len().min(TEXT_PREVIEW_BYTES - self.0.len());
        self.0.extend_from_slice(&bytes[..retain]);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

pub(crate) fn publish_export(
    destination: &Path,
    write: impl FnOnce(&mut File) -> Result<()>,
) -> Result<()> {
    let filename = source_name(destination)?;
    let parent = destination
        .parent()
        .ok_or(Error::Invalid("Choose a destination folder"))?;
    let folder = Dir::open_ambient_dir(parent, ambient_authority())?;
    match folder.symlink_metadata(&filename) {
        Ok(_) => return Err(Error::ExportExists),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    let staged = format!(".forge-export-{}.part", Uuid::new_v4());
    let mut options = OpenOptions::new();
    options
        .write(true)
        .create_new(true)
        .follow(FollowSymlinks::No);
    let mut output = folder.open_with(&staged, &options)?;
    let copied = write(&mut output).and_then(|()| Ok(output.sync_all()?));
    drop(output);
    let published = copied.and_then(|()| {
        folder
            .hard_link(&staged, &folder, &filename)
            .map_err(|error| {
                if error.kind() == io::ErrorKind::AlreadyExists {
                    Error::ExportExists
                } else {
                    error.into()
                }
            })
    });
    let clean = folder.remove_file(&staged);
    published?;
    // The verified destination is already committed. A cleanup failure must not report a failed copy.
    let _ = clean;
    Ok(())
}

pub(crate) fn source_name(path: &Path) -> Result<String> {
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or(Error::Invalid("Invalid filename"))?;
    validate_label(name)?;
    if name.contains(['/', '\\', ':']) {
        return Err(Error::Invalid("Invalid filename"));
    }
    Ok(name.to_owned())
}

pub(crate) fn open_source(path: &Path) -> Result<File> {
    if !path.is_absolute() {
        return Err(Error::Invalid("Choose a local file"));
    }
    let parent = path.parent().ok_or(Error::Invalid("Invalid source path"))?;
    let filename = path.file_name().ok_or(Error::Invalid("Invalid filename"))?;
    if !fs::symlink_metadata(path)?.is_file() {
        return Err(Error::Invalid("Only regular files can be imported"));
    }
    let folder = Dir::open_ambient_dir(parent, ambient_authority())?;
    open_regular(&folder, Path::new(filename))
}

fn open_regular(dir: &Dir, path: impl AsRef<Path>) -> Result<File> {
    let mut options = OpenOptions::new();
    options.read(true).follow(FollowSymlinks::No);
    let file = dir.open_with(path, &options)?;
    if !file.metadata()?.is_file() {
        return Err(Error::Invalid("Only regular files can be imported"));
    }
    Ok(file)
}

fn ensure_dir(parent: &Dir, name: &str) -> Result<()> {
    match parent.create_dir(name) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => Ok(()),
        Err(error) => Err(error.into()),
    }
}

fn unlink_if_present(dir: &Dir, name: &str) -> Result<()> {
    match dir.remove_file(name) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

fn stage_name(id: Uuid) -> String {
    format!("asset-{id}.part")
}

fn blob_name(id: Uuid, suffix: &str) -> String {
    format!("asset-{id}.{suffix}")
}

fn copy_and_hash(
    input: &mut impl Read,
    output: &mut impl Write,
    remaining: &mut u64,
) -> Result<(u64, String)> {
    copy_and_hash_progress(input, output, remaining, |_| Ok(()))
}

pub(crate) fn copy_and_hash_progress(
    input: &mut impl Read,
    output: &mut impl Write,
    remaining: &mut u64,
    mut progress: impl FnMut(u64) -> Result<()>,
) -> Result<(u64, String)> {
    let mut buffer = [0u8; 64 * 1024];
    let mut total = 0;
    let mut sha = Sha256::new();
    loop {
        let count = input.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        total += count as u64;
        let exhausted = count as u64 > *remaining;
        *remaining = remaining.saturating_sub(count as u64);
        if total > MAX_FILE_BYTES || exhausted {
            return Err(Error::Invalid("File or batch size limit exceeded"));
        }
        sha.update(&buffer[..count]);
        output.write_all(&buffer[..count])?;
        progress(total)?;
    }
    Ok((total, format!("{:x}", sha.finalize())))
}

fn validate_content(file: &mut File, format: AssetFormat) -> Result<()> {
    match format {
        AssetFormat::Png | AssetFormat::Jpeg | AssetFormat::Webp => {
            decode_image(BufReader::new(file), format)?;
            Ok(())
        }
        AssetFormat::Txt | AssetFormat::Md => validate_text(file),
        AssetFormat::Pdf => validate_pdf(file),
        AssetFormat::Docx => validate_docx(file),
        AssetFormat::Webm | AssetFormat::Mp4 => {
            let bytes = file.metadata()?.len();
            crate::video::validate(file, bytes, format)
        }
        AssetFormat::Wav => {
            let bytes = file.metadata()?.len();
            let mut prefix = Vec::new();
            file.take(TEXT_PREVIEW_BYTES as u64)
                .read_to_end(&mut prefix)?;
            crate::wav::duration(&prefix, bytes).map(|_| ())
        }
    }
}

pub(crate) fn preview_image(original: Vec<u8>, format: AssetFormat) -> Result<AssetPreview> {
    encode_image_preview(decode_image(Cursor::new(original), format)?)
}

pub(crate) fn encode_image_preview(image: DynamicImage) -> Result<AssetPreview> {
    let thumbnail = if image.width().max(image.height()) > IMAGE_PREVIEW_EDGE {
        image.thumbnail(IMAGE_PREVIEW_EDGE, IMAGE_PREVIEW_EDGE)
    } else {
        image
    };
    let mut png = Cursor::new(Vec::new());
    thumbnail
        .write_to(&mut png, ImageFormat::Png)
        .map_err(|_| Error::Invalid("Could not encode the image preview"))?;
    Ok(AssetPreview::Image {
        png: png.into_inner(),
    })
}

pub(crate) fn decode_image(
    input: impl BufRead + Seek,
    format: AssetFormat,
) -> Result<DynamicImage> {
    image_reader(input, format)?
        .decode()
        .map_err(|_| Error::Invalid("Image is damaged or exceeds decode limits"))
}

pub(crate) fn image_reader<R: BufRead + Seek>(
    mut input: R,
    format: AssetFormat,
) -> Result<ImageReader<R>> {
    let expected = match format {
        AssetFormat::Png => ImageFormat::Png,
        AssetFormat::Jpeg => ImageFormat::Jpeg,
        AssetFormat::Webp => ImageFormat::WebP,
        _ => return Err(Error::Invalid("Unsupported image format")),
    };
    let reader = ImageReader::new(&mut input).with_guessed_format()?;
    if reader.format() != Some(expected) {
        return Err(Error::Invalid("Image data does not match the extension"));
    }
    let (width, height) = reader
        .into_dimensions()
        .map_err(|_| Error::Invalid("Invalid image header"))?;
    if width == 0 || height == 0 || u64::from(width) * u64::from(height) > MAX_PIXELS {
        return Err(Error::Invalid("Image exceeds the 40 megapixel limit"));
    }
    input.rewind()?;
    let mut limits = Limits::default();
    limits.max_image_width = Some(width);
    limits.max_image_height = Some(height);
    limits.max_alloc = Some(MAX_IMAGE_ALLOC);
    let mut reader = ImageReader::with_format(input, expected);
    reader.limits(limits);
    Ok(reader)
}

fn validate_text(file: &mut File) -> Result<()> {
    let mut buffer = [0u8; 64 * 1024 + 3];
    let mut carry = 0;
    loop {
        let read = file.read(&mut buffer[carry..])?;
        if read == 0 {
            return if carry == 0 {
                Ok(())
            } else {
                Err(Error::Invalid("Text ends in an incomplete UTF-8 sequence"))
            };
        }
        let count = read + carry;
        if buffer[..count].contains(&0) {
            return Err(Error::Invalid("Text contains NUL bytes"));
        }
        match std::str::from_utf8(&buffer[..count]) {
            Ok(_) => carry = 0,
            Err(error) if error.error_len().is_none() => {
                carry = count - error.valid_up_to();
                buffer.copy_within(error.valid_up_to()..count, 0);
            }
            Err(_) => return Err(Error::Invalid("Text must be UTF-8")),
        }
    }
}

fn validate_pdf(file: &mut File) -> Result<()> {
    let mut header = [0; 8];
    file.read_exact(&mut header)
        .map_err(|_| Error::Invalid("Invalid PDF header"))?;
    if &header[..5] != b"%PDF-"
        || !matches!(header[5], b'1' | b'2')
        || header[6] != b'.'
        || !header[7].is_ascii_digit()
    {
        return Err(Error::Invalid("Invalid PDF header"));
    }
    let length = file.metadata()?.len();
    file.seek(SeekFrom::Start(length.saturating_sub(4096)))?;
    let mut tail = Vec::new();
    file.take(4096).read_to_end(&mut tail)?;
    if !tail.trim_ascii_end().ends_with(b"%%EOF") {
        return Err(Error::Invalid("PDF end marker is missing"));
    }
    Ok(())
}

fn validate_docx(file: &mut File) -> Result<()> {
    let mut archive =
        zip::ZipArchive::new(file).map_err(|_| Error::Invalid("Invalid DOCX package"))?;
    if archive.len() > 4096 {
        return Err(Error::Invalid("DOCX contains too many entries"));
    }
    let mut expanded = 0u64;
    for index in 0..archive.len() {
        let entry = archive
            .by_index_raw(index)
            .map_err(|_| Error::Invalid("Invalid DOCX entry"))?;
        expanded = expanded.saturating_add(entry.size());
        if expanded > MAX_BATCH_BYTES || entry.enclosed_name().is_none() || entry.is_symlink() {
            return Err(Error::Invalid(
                "DOCX package exceeds expansion limits or contains unsupported paths",
            ));
        }
    }
    for (path, root) in [
        ("[Content_Types].xml", "Types"),
        ("word/document.xml", "document"),
    ] {
        use quick_xml::{Reader, events::Event};
        const MAX_XML: u64 = 16 * 1024 * 1024;
        let member = archive
            .by_name(path)
            .map_err(|_| Error::Invalid("A required DOCX part is missing"))?;
        if !member.is_file() || member.size() == 0 || member.size() > MAX_XML {
            return Err(Error::Invalid("A required DOCX part exceeds its limit"));
        }
        let size = member.size();
        let mut xml = Vec::new();
        member
            .take(MAX_XML + 1)
            .read_to_end(&mut xml)
            .map_err(|_| Error::Invalid("Unable to decode DOCX document XML"))?;
        if xml.len() as u64 != size {
            return Err(Error::Invalid(
                "DOCX XML size does not match its package metadata",
            ));
        }
        let mut reader = Reader::from_reader(xml.as_slice());
        let mut depth = 0usize;
        let mut found_root = false;
        loop {
            let event = reader
                .read_event()
                .map_err(|_| Error::Invalid("Invalid DOCX document XML"))?;
            match event {
                Event::Start(ref element) | Event::Empty(ref element) if depth == 0 => {
                    if found_root || element.local_name().as_ref() != root {
                        return Err(Error::Invalid("Unexpected document element in DOCX XML"));
                    }
                    found_root = true;
                    if matches!(event, Event::Start(_)) {
                        depth = 1;
                    }
                }
                Event::Start(_) => depth += 1,
                Event::End(_) if depth > 0 => depth -= 1,
                Event::DocType(_) => {
                    return Err(Error::Invalid("DOCX XML declarations are not supported"));
                }
                Event::Eof => break,
                _ => {}
            }
            if depth > 256 {
                return Err(Error::Invalid("DOCX XML nesting limit exceeded"));
            }
        }
        if !found_root || depth != 0 {
            return Err(Error::Invalid("Incomplete DOCX document XML"));
        }
    }
    Ok(())
}
