use super::*;
use crate::directory::DirectoryFile;

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(untagged)]
pub enum SourceFile {
    Managed(AssetRef),
    Directory(DirectoryFile),
}

impl SourceFile {
    pub fn version_id(&self) -> Uuid {
        match self {
            Self::Managed(asset) => asset.version_id,
            Self::Directory(file) => file.version_id,
        }
    }

    pub fn name(&self) -> &str {
        match self {
            Self::Managed(asset) => &asset.name,
            Self::Directory(file) => &file.name,
        }
    }

    pub(super) fn bytes(&self) -> u64 {
        match self {
            Self::Managed(asset) => asset.bytes,
            Self::Directory(file) => file.bytes,
        }
    }

    pub(super) fn format(&self) -> Option<AssetFormat> {
        match self {
            Self::Managed(asset) => Some(asset.format),
            Self::Directory(file) => file.format,
        }
    }

    pub(super) fn same_version(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::Managed(a), Self::Managed(b)) => a == b,
            (Self::Directory(a), Self::Directory(b)) => {
                a.relative_path == b.relative_path
                    && a.asset_id == b.asset_id
                    && a.version_id == b.version_id
                    && a.fingerprint == b.fingerprint
                    && a.bytes == b.bytes
                    && a.format == b.format
            }
            _ => false,
        }
    }

    pub(super) fn verify(
        &mut self,
        project: &Project,
        output: &mut impl Write,
        limit: u64,
        checkpoint: impl FnMut() -> Result<()>,
    ) -> Result<()> {
        match self {
            Self::Managed(asset) => {
                if asset.bytes > limit {
                    return Err(Error::Limit);
                }
                let store =
                    AssetStore::open(&project.root, false).map_err(|_| Error::AssetIntegrity)?;
                store.copy_verified_with_checkpoint(asset, output, checkpoint)
            }
            Self::Directory(file) => {
                file.sha256 = Some(directory::read_file(
                    &project.root,
                    file,
                    limit,
                    output,
                    checkpoint,
                )?);
                Ok(())
            }
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkedFilePage {
    pub source_revision: String,
    pub total: usize,
    pub next_offset: Option<usize>,
    pub items: Vec<SourceFile>,
    #[serde(skip_serializing_if = "is_zero")]
    pub unavailable_count: usize,
}

pub(super) fn is_zero(value: &usize) -> bool {
    *value == 0
}

pub(super) enum LinkedCollection<'a> {
    Managed(ManagedCollection<'a>),
    Directory(directory::FileCollection),
}

impl<'a> LinkedCollection<'a> {
    pub(super) fn from_link(project: &Project, node: &'a Node, link: &DataLink) -> Result<Self> {
        if matches!(&node.content, Content::Portal { type_id, schema_version: 1, .. } if type_id == DIRECTORY_TYPE)
            && link.data_type == DataType::FileCollection
        {
            return directory::file_collection(&project.root).map(Self::Directory);
        }
        ManagedCollection::from_link(&project.connection, node, link).map(Self::Managed)
    }

    pub(super) fn len(&self) -> usize {
        match self {
            Self::Managed(files) => files.len(),
            Self::Directory(files) => files.files.len(),
        }
    }

    pub(super) fn revision(&self) -> String {
        match self {
            Self::Managed(files) => files.revision(),
            Self::Directory(files) => files.revision.clone(),
        }
    }

    pub(super) fn unavailable_count(&self) -> usize {
        match self {
            Self::Managed(_) => 0,
            Self::Directory(files) => files.unavailable_count,
        }
    }

    pub(super) fn files(&self, db: &Connection, range: Range<usize>) -> Result<Vec<SourceFile>> {
        match self {
            Self::Managed(files) => Ok(files
                .assets(db, range)?
                .into_iter()
                .map(SourceFile::Managed)
                .collect()),
            Self::Directory(files) => Ok(files.files[range]
                .iter()
                .cloned()
                .map(SourceFile::Directory)
                .collect()),
        }
    }

    pub(super) fn version(&self, db: &Connection, id: Uuid) -> Result<Option<SourceFile>> {
        match self {
            Self::Managed(files) => Ok(files.version(db, id)?.map(SourceFile::Managed)),
            Self::Directory(files) => Ok(files
                .files
                .iter()
                .find(|item| item.version_id == id)
                .cloned()
                .map(SourceFile::Directory)),
        }
    }

    pub(super) fn verify_revision(&self, project: &Project) -> Result<()> {
        if let Self::Directory(old) = self {
            let live = directory::file_collection(&project.root)?;
            check_source_revision(&live.revision, Some(&old.revision))?;
        }
        Ok(())
    }
}
