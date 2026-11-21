use std::{
    borrow::Cow,
    collections::{HashMap, HashSet, VecDeque},
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{AssetFormat, Content, Error, Node, Result};

pub const GALLERY: &str = "forge.gallery";
pub const PALETTE: &str = "forge.palette";
pub const METADATA: &str = "forge.metadata";
pub const COMPARISON: &str = "forge.comparison";
const MAX_LINKS: usize = 50_000;
const MAX_ITEMS: usize = 5_000;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
pub enum DataType {
    FileCollection,
    ImageCollection,
    TextContent,
    ColorPalette,
    MetadataCollection,
    ComparisonResult,
    ChecklistCompletionRecords,
    TabularData,
    GraphData,
    ResearchSources,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LinkPort {
    pub node_id: Uuid,
    pub port_id: String,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AccessMode {
    ReadOnly,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DataLink {
    pub id: Uuid,
    pub source: LinkPort,
    pub target: LinkPort,
    pub data_type: DataType,
    pub contract_version: u32,
    pub access: AccessMode,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GalleryItem {
    pub asset_id: Uuid,
    pub version_id: Uuid,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Gallery {
    pub items: Vec<GalleryItem>,
}

impl Gallery {
    pub fn decode(payload: &str) -> Result<Self> {
        let gallery: Self =
            serde_json::from_str(payload).map_err(|_| Error::Invalid("Invalid Gallery payload"))?;
        gallery.validate()?;
        Ok(gallery)
    }

    pub fn validate(&self) -> Result<()> {
        let mut ids = HashSet::new();
        if self.items.len() > MAX_ITEMS
            || self.items.iter().any(|item| {
                item.asset_id.is_nil() || item.version_id.is_nil() || !ids.insert(item.asset_id)
            })
        {
            return Err(Error::Invalid(
                "Gallery requires unique images and supports up to 5000 entries",
            ));
        }
        Ok(())
    }

    pub fn revision(&self) -> String {
        let mut hash = Sha256::new();
        hash.update(b"forge.gallery.v1");
        for item in &self.items {
            hash.update(item.asset_id.as_bytes());
            hash.update(item.version_id.as_bytes());
        }
        format!("{:x}", hash.finalize())
    }
}

pub fn is_image(format: AssetFormat) -> bool {
    matches!(
        format,
        AssetFormat::Png | AssetFormat::Jpeg | AssetFormat::Webp
    )
}

fn portal_type(content: &Content) -> Option<&str> {
    match content {
        Content::Portal {
            type_id,
            schema_version: 1,
            ..
        } => Some(type_id),
        _ => None,
    }
}

pub(crate) fn gallery(node: &Node) -> Result<Gallery> {
    match &node.content {
        Content::Portal {
            type_id,
            schema_version: 1,
            payload,
            ..
        } if type_id == GALLERY => Gallery::decode(payload),
        _ => Err(Error::Invalid("Open a Gallery in this project")),
    }
}

pub(crate) fn set_gallery(node: &mut Node, gallery: &Gallery) -> Result<()> {
    gallery.validate()?;
    match &mut node.content {
        Content::Portal {
            type_id,
            schema_version: 1,
            payload,
            ..
        } if type_id == GALLERY => {
            *payload = serde_json::to_string(gallery)?;
            Ok(())
        }
        _ => Err(Error::Invalid("Open a Gallery in this project")),
    }
}

fn output(content: &Content, port: &str) -> Option<DataType> {
    match (content, port) {
        (Content::Asset { .. }, "files") => Some(DataType::FileCollection),
        (Content::Asset { asset }, "images") if is_image(asset.format) => {
            Some(DataType::ImageCollection)
        }
        (Content::Asset { asset }, "text")
            if matches!(asset.format, AssetFormat::Txt | AssetFormat::Md) =>
        {
            Some(DataType::TextContent)
        }
        (Content::Note { .. }, "text") => Some(DataType::TextContent),
        _ => match (portal_type(content), port) {
            (Some(GALLERY), "files") => Some(DataType::FileCollection),
            (Some(crate::directory::DIRECTORY_TYPE), "files") => Some(DataType::FileCollection),
            (Some(GALLERY), "images") => Some(DataType::ImageCollection),
            (Some(PALETTE), "palette") => Some(DataType::ColorPalette),
            (Some(METADATA), "metadata") => Some(DataType::MetadataCollection),
            (Some(COMPARISON), "comparison") => Some(DataType::ComparisonResult),
            (Some(crate::checklist::CHECKLIST_TYPE), "text") => Some(DataType::TextContent),
            (Some(crate::checklist::CHECKLIST_TYPE), "completions") => {
                Some(DataType::ChecklistCompletionRecords)
            }
            (Some(crate::dataset::TYPE_ID), "rows") => Some(DataType::TabularData),
            (Some(crate::scheme::TYPE_ID), "graph") => Some(DataType::GraphData),
            (Some(crate::scheme::TYPE_ID), "text") => Some(DataType::TextContent),
            (Some(crate::site::TYPE_ID), "quote") => Some(DataType::TextContent),
            (Some(crate::research::TYPE_ID), "sources") => Some(DataType::ResearchSources),
            _ => None,
        },
    }
}

pub(crate) fn inline_text(content: &Content) -> Result<Option<Cow<'_, str>>> {
    match content {
        Content::Note { text } => Ok(Some(Cow::Borrowed(text))),
        Content::Portal {
            type_id,
            schema_version: 1,
            payload,
            ..
        } if type_id == crate::scheme::TYPE_ID => Ok(Some(Cow::Owned(
            crate::scheme::Document::decode(payload)?.text(),
        ))),
        Content::Portal {
            type_id,
            schema_version: 1,
            payload,
            ..
        } if type_id == crate::checklist::CHECKLIST_TYPE => Ok(Some(Cow::Owned(
            crate::checklist::Checklist::decode(payload)?.text(),
        ))),
        Content::Portal {
            type_id,
            schema_version: 1,
            payload,
            ..
        } if type_id == crate::site::TYPE_ID => Ok(crate::site::Site::decode(payload)?
            .reference
            .map(|reference| Cow::Owned(reference.quote))),
        _ => Ok(None),
    }
}

fn input(content: &Content, port: &str, data_type: DataType) -> Option<usize> {
    match (portal_type(content), port, data_type) {
        (Some(PALETTE | crate::editor::TYPE_ID), "images", DataType::ImageCollection)
        | (Some(METADATA), "files", DataType::FileCollection | DataType::ImageCollection) => {
            Some(1)
        }
        (
            Some(COMPARISON),
            "sources",
            DataType::FileCollection | DataType::ImageCollection | DataType::TextContent,
        ) => Some(2),
        (
            Some(crate::research::TYPE_ID),
            "sources",
            DataType::FileCollection | DataType::ImageCollection | DataType::TextContent,
        ) => Some(64),
        (
            Some(crate::intelligent::TYPE_ID),
            "context",
            DataType::ColorPalette
            | DataType::ResearchSources
            | DataType::TabularData
            | DataType::TextContent,
        ) => Some(32),
        _ => None,
    }
}

fn opaque(content: &Content) -> bool {
    matches!(content, Content::Portal { .. })
        && !matches!(
            portal_type(content),
            Some(
                GALLERY
                    | PALETTE
                    | METADATA
                    | COMPARISON
                    | "forge.directory"
                    | "forge.checklist"
                    | crate::dataset::TYPE_ID
                    | crate::scheme::TYPE_ID
                    | crate::site::TYPE_ID
                    | crate::research::TYPE_ID
                    | crate::intelligent::TYPE_ID
                    | crate::editor::TYPE_ID
            )
        )
}

pub(crate) fn validate_links(nodes: &[Node], links: &[DataLink]) -> Result<()> {
    if links.len() > MAX_LINKS {
        return Err(Error::Limit);
    }
    if links.is_empty() {
        return Ok(());
    }
    let known: HashMap<_, _> = nodes.iter().map(|node| (node.id, &node.content)).collect();
    let mut ids = HashSet::new();
    let mut pairs = HashSet::new();
    let mut counts = HashMap::new();
    let mut indegree = HashMap::<Uuid, usize>::new();
    let mut targets = HashMap::<Uuid, Vec<Uuid>>::new();
    for link in links {
        if link.id.is_nil() || !ids.insert(link.id) || !pairs.insert((&link.source, &link.target)) {
            return Err(Error::Link("LINK_DUPLICATE", "This link already exists"));
        }
        if link.source.node_id == link.target.node_id {
            return Err(Error::Link("LINK_CYCLE", "An object cannot link to itself"));
        }
        let (Some(source), Some(target)) = (
            known.get(&link.source.node_id),
            known.get(&link.target.node_id),
        ) else {
            return Err(Error::Link(
                "LINK_ENDPOINT",
                "Both endpoints must be objects in this project",
            ));
        };
        if link.contract_version != 1
            || link.source.port_id.is_empty()
            || link.target.port_id.is_empty()
            || link.source.port_id.len() > 96
            || link.target.port_id.len() > 96
        {
            return Err(Error::Link("LINK_CONTRACT", "Invalid link contract"));
        }
        if !opaque(source) && output(source, &link.source.port_id) != Some(link.data_type) {
            return Err(Error::Link(
                "LINK_INCOMPATIBLE",
                "The source does not provide that data type",
            ));
        }
        let count = counts.entry(&link.target).or_insert(0);
        *count += 1;
        if !opaque(target) {
            let limit = input(target, &link.target.port_id, link.data_type).ok_or(Error::Link(
                "LINK_INCOMPATIBLE",
                "The target port does not accept this data type",
            ))?;
            if *count > limit {
                return Err(Error::Link(
                    "LINK_CARDINALITY",
                    "The target port has no free inputs",
                ));
            }
        }
        indegree.entry(link.source.node_id).or_default();
        *indegree.entry(link.target.node_id).or_default() += 1;
        targets
            .entry(link.source.node_id)
            .or_default()
            .push(link.target.node_id);
    }
    let mut ready: VecDeque<_> = indegree
        .iter()
        .filter_map(|(id, count)| (*count == 0).then_some(*id))
        .collect();
    let mut visited = 0;
    while let Some(id) = ready.pop_front() {
        visited += 1;
        for target in targets.get(&id).into_iter().flatten() {
            let count = indegree.get_mut(target).expect("target has a degree");
            *count -= 1;
            if *count == 0 {
                ready.push_back(*target);
            }
        }
    }
    if visited != indegree.len() {
        return Err(Error::Link("LINK_CYCLE", "This link would create a cycle"));
    }
    Ok(())
}

pub(crate) fn new_link(
    nodes: &[Node],
    id: Uuid,
    source: LinkPort,
    target: LinkPort,
) -> Result<DataLink> {
    if source.node_id == target.node_id {
        return Err(Error::Link("LINK_CYCLE", "An object cannot link to itself"));
    }
    let find = |port: &LinkPort| {
        nodes
            .iter()
            .find(|node| node.id == port.node_id)
            .map(|node| &node.content)
            .ok_or(Error::Link("LINK_ENDPOINT", "Link endpoint is missing"))
    };
    let data_type = output(find(&source)?, &source.port_id)
        .ok_or(Error::Link("LINK_INCOMPATIBLE", "Unknown source port"))?;
    if input(find(&target)?, &target.port_id, data_type).is_none() {
        return Err(Error::Link(
            "LINK_INCOMPATIBLE",
            "The target port does not accept this data type",
        ));
    }
    Ok(DataLink {
        id,
        source,
        target,
        data_type,
        contract_version: 1,
        access: AccessMode::ReadOnly,
    })
}

pub(crate) fn readable_link(source: &Node, target: &Node, link: &DataLink) -> bool {
    output(&source.content, &link.source.port_id) == Some(link.data_type)
        && input(&target.content, &link.target.port_id, link.data_type).is_some()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Position;

    #[test]
    fn opaque_portals_keep_known_link_shapes_but_cannot_form_cycles() {
        let nodes: Vec<_> = (0..3)
            .map(|_| Node {
                id: Uuid::new_v4(),
                label: "Unknown Plain".into(),
                position: Position { x: 0.0, y: 0.0 },
                content: Content::Portal {
                    plain_id: Uuid::new_v4(),
                    type_id: "forge.external".into(),
                    schema_version: 2,
                    payload: "{}".into(),
                },
            })
            .collect();
        let link = |from: usize, to: usize| DataLink {
            id: Uuid::new_v4(),
            source: LinkPort {
                node_id: nodes[from].id,
                port_id: "output".into(),
            },
            target: LinkPort {
                node_id: nodes[to].id,
                port_id: "input".into(),
            },
            data_type: DataType::TextContent,
            contract_version: 1,
            access: AccessMode::ReadOnly,
        };
        let first = link(0, 1);
        let second = link(1, 2);
        validate_links(&nodes, &[first.clone(), second.clone()]).unwrap();
        assert!(!readable_link(&nodes[0], &nodes[1], &first));
        assert_eq!(
            validate_links(&nodes, &[first, second, link(2, 0)])
                .unwrap_err()
                .code(),
            "LINK_CYCLE"
        );
    }
}
