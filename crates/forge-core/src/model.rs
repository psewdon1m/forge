use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{
    AssetRef, DataLink, Error, GalleryItem, LinkPort, Result,
    checklist::{CHECKLIST_TYPE, Checklist, ChecklistCompletion, ChecklistGroup, ChecklistItem},
    data_links::{self, Gallery},
    dataset::{self, Dataset},
    editor, intelligent, research, scheme, site,
};

const MAX_NODES: usize = 25_000;
const MAX_LABEL: usize = 240;
const MAX_NOTE_BYTES: usize = 256 * 1024;
const MAX_PLAIN_BYTES: usize = 1024 * 1024;
const MAX_COORDINATE: f64 = 1_000_000.0;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Position {
    pub x: f64,
    pub y: f64,
}

impl Position {
    pub(crate) fn validate(self) -> Result<()> {
        for value in [self.x, self.y] {
            if !value.is_finite() || value.abs() > MAX_COORDINATE {
                return Err(Error::Invalid("Coordinates outside the Space bounds"));
            }
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Viewport {
    pub x: f64,
    pub y: f64,
    pub zoom: f64,
}

impl Default for Viewport {
    fn default() -> Self {
        Self {
            x: 0.0,
            y: 0.0,
            zoom: 1.0,
        }
    }
}

impl Viewport {
    pub(crate) fn validate(self) -> Result<()> {
        Position {
            x: self.x,
            y: self.y,
        }
        .validate()?;
        if !self.zoom.is_finite() || !(0.05..=8.0).contains(&self.zoom) {
            return Err(Error::Invalid("Zoom outside the supported range"));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Node {
    pub id: Uuid,
    pub label: String,
    pub position: Position,
    pub content: Content,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Content {
    Note {
        text: String,
    },
    Asset {
        asset: AssetRef,
    },
    Portal {
        plain_id: Uuid,
        type_id: String,
        schema_version: u32,
        /// JSON source text for the registered Plain, retained verbatim if its definition is absent.
        payload: String,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Placement {
    pub id: Uuid,
    pub position: Position,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Group {
    pub id: Uuid,
    pub members: Vec<Uuid>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Space {
    pub project_id: Uuid,
    pub title: String,
    pub nodes: Vec<Node>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub groups: Vec<Group>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub links: Vec<DataLink>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Change {
    Add {
        node: Node,
    },
    Move {
        id: Uuid,
        position: Position,
    },
    MoveSelection {
        placements: Vec<Placement>,
    },
    RenameProject {
        title: String,
    },
    RenameNode {
        id: Uuid,
        label: String,
    },
    EditNote {
        id: Uuid,
        text: String,
    },
    EditChecklist {
        id: Uuid,
        items: Vec<ChecklistItem>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        groups: Option<Vec<ChecklistGroup>>,
    },
    ImportDataset {
        id: Uuid,
        text: String,
        options: dataset::ImportOptions,
    },
    EditDatasetCell {
        id: Uuid,
        row_id: Uuid,
        column: usize,
        raw: String,
    },
    EditScheme {
        id: Uuid,
        document: scheme::Document,
    },
    EditSite {
        id: Uuid,
        site: site::Site,
    },
    EditResearch {
        id: Uuid,
        action: research::Action,
    },
    EditEditor {
        id: Uuid,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        selection: Option<editor::Selection>,
        graph: editor::Graph,
    },
    SaveIntelligentResult {
        id: Uuid,
        result: intelligent::SavedResult,
    },
    EditGallery {
        id: Uuid,
        items: Vec<GalleryItem>,
    },
    Connect {
        id: Uuid,
        source: LinkPort,
        target: LinkPort,
    },
    Disconnect {
        id: Uuid,
    },
    ArchiveNode {
        id: Uuid,
    },
    ArchiveSelection {
        ids: Vec<Uuid>,
    },
    GroupSelection {
        ids: Vec<Uuid>,
    },
    Ungroup {
        id: Uuid,
    },
    Paste {
        nodes: Vec<Node>,
        groups: Vec<Group>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        links: Vec<DataLink>,
    },
    RestoreRevision {
        revision: i64,
    },
    Undo,
    Redo,
}

pub(crate) fn validate_label(label: &str) -> Result<()> {
    if label.trim().is_empty()
        || label.chars().count() > MAX_LABEL
        || label.chars().any(char::is_control)
    {
        return Err(Error::Invalid(
            "A label must have 1–240 printable characters",
        ));
    }
    Ok(())
}

impl Space {
    pub(crate) fn validate(&self) -> Result<()> {
        validate_label(&self.title)?;
        if self.project_id.is_nil() || self.nodes.len() > MAX_NODES {
            return Err(Error::Invalid(
                "Invalid project identity or object limit exceeded",
            ));
        }
        let mut node_ids = HashMap::new();
        let mut plain_ids = HashMap::new();
        for node in &self.nodes {
            if node.id.is_nil() || node_ids.insert(node.id, ()).is_some() {
                return Err(Error::Invalid("Duplicate or empty object identity"));
            }
            validate_label(&node.label)?;
            node.position.validate()?;
            match &node.content {
                Content::Note { text } if text.len() > MAX_NOTE_BYTES => {
                    return Err(Error::Invalid("Note size limit exceeded"));
                }
                Content::Portal {
                    plain_id,
                    type_id,
                    schema_version,
                    payload,
                } => {
                    if plain_id.is_nil() || plain_ids.insert(*plain_id, ()).is_some() {
                        return Err(Error::Invalid("Each Plain must have exactly one Portal"));
                    }
                    let valid_type = !type_id.is_empty()
                        && type_id.len() <= 96
                        && type_id.bytes().all(|byte| {
                            byte.is_ascii_lowercase()
                                || byte.is_ascii_digit()
                                || b"-._".contains(&byte)
                        });
                    if !valid_type || *schema_version == 0 || payload.len() > MAX_PLAIN_BYTES {
                        return Err(Error::Invalid("Invalid Plain type, schema or payload"));
                    }
                    if type_id == CHECKLIST_TYPE && *schema_version == 1 {
                        Checklist::decode(payload)?;
                    } else if type_id == data_links::GALLERY && *schema_version == 1 {
                        Gallery::decode(payload)?;
                    } else if type_id == dataset::TYPE_ID && *schema_version == 1 {
                        Dataset::decode(payload)?;
                    } else if type_id == scheme::TYPE_ID && *schema_version == 1 {
                        scheme::Document::decode(payload)?;
                    } else if type_id == site::TYPE_ID && *schema_version == 1 {
                        site::Site::decode(payload)?;
                    } else if type_id == research::TYPE_ID && *schema_version == 1 {
                        research::Document::decode(payload)?;
                    } else if type_id == intelligent::TYPE_ID && *schema_version == 1 {
                        intelligent::Document::decode(payload)?;
                    } else if type_id == editor::TYPE_ID && *schema_version == 1 {
                        editor::Document::decode(payload)?;
                    } else if type_id == crate::git::TYPE_ID && *schema_version == 1 {
                        serde_json::from_str::<crate::git::Document>(payload)
                            .map_err(|_| Error::Invalid("Invalid Git Plain payload"))?;
                    } else if serde_json::from_str::<serde_json::Value>(payload).is_err() {
                        return Err(Error::Invalid("Invalid Plain payload"));
                    }
                }
                Content::Note { .. } => {}
                Content::Asset { asset } => asset.validate()?,
            }
        }
        let mut group_ids = HashSet::new();
        let mut grouped = HashSet::new();
        for group in &self.groups {
            if group.id.is_nil() || !group_ids.insert(group.id) || group.members.len() < 2 {
                return Err(Error::Invalid("Invalid group identity or membership"));
            }
            for id in &group.members {
                if !node_ids.contains_key(id) || !grouped.insert(id) {
                    return Err(Error::Invalid(
                        "Objects must belong to at most one existing group",
                    ));
                }
            }
        }
        data_links::validate_links(&self.nodes, &self.links)
    }

    pub(crate) fn apply(
        &mut self,
        change: Change,
        checklist_stamp: Option<&ChecklistCompletion>,
    ) -> Result<()> {
        match change {
            Change::Add { mut node } => {
                Checklist::initialize(&mut node.content, false)?;
                self.nodes.push(node);
            }
            Change::Move { id, position } => {
                if self.groups.iter().any(|group| group.members.contains(&id)) {
                    return Err(Error::Invalid("Move the whole group together"));
                }
                self.node_mut(id)?.position = position;
            }
            Change::MoveSelection { placements } => {
                if placements.is_empty() || placements.len() > self.nodes.len() {
                    return Err(Error::Invalid("Invalid object selection"));
                }
                let mut positions = HashMap::new();
                for placement in placements {
                    placement.position.validate()?;
                    if positions.insert(placement.id, placement.position).is_some() {
                        return Err(Error::Invalid("Object appears twice in the move"));
                    }
                }
                for group in &self.groups {
                    let moving = group
                        .members
                        .iter()
                        .filter(|id| positions.contains_key(id))
                        .count();
                    if moving != 0 && moving != group.members.len() {
                        return Err(Error::Invalid("Move the whole group together"));
                    }
                }
                for node in &mut self.nodes {
                    if let Some(position) = positions.remove(&node.id) {
                        node.position = position;
                    }
                }
                if !positions.is_empty() {
                    return Err(Error::Invalid("Selection contains a missing object"));
                }
            }
            Change::RenameProject { title } => self.title = title,
            Change::RenameNode { id, label } => self.node_mut(id)?.label = label,
            Change::EditNote { id, text } => match &mut self.node_mut(id)?.content {
                Content::Note { text: current } => *current = text,
                _ => return Err(Error::Invalid("That object is not a note")),
            },
            Change::EditChecklist { id, items, groups } => Checklist::edit(
                &mut self.node_mut(id)?.content,
                items,
                groups,
                checklist_stamp
                    .ok_or(Error::Invalid("Checklist edit requires a revision stamp"))?,
            )?,
            Change::EditGallery { id, items } => {
                data_links::set_gallery(self.node_mut(id)?, &Gallery { items })?
            }
            Change::ImportDataset { id, text, options } => {
                Dataset::import(&mut self.node_mut(id)?.content, &text, &options)?
            }
            Change::EditDatasetCell {
                id,
                row_id,
                column,
                raw,
            } => Dataset::edit(&mut self.node_mut(id)?.content, row_id, column, raw)?,
            Change::EditScheme { id, document } => {
                document.store(&mut self.node_mut(id)?.content)?
            }
            Change::EditSite { id, site } => site.store(&mut self.node_mut(id)?.content)?,
            Change::Connect { id, source, target } => {
                self.links
                    .push(data_links::new_link(&self.nodes, id, source, target)?);
            }
            Change::Disconnect { id } => {
                let index = self
                    .links
                    .iter()
                    .position(|link| link.id == id)
                    .ok_or(Error::Link("LINK_ENDPOINT", "The link no longer exists"))?;
                self.links.remove(index);
            }
            Change::ArchiveNode { id } => {
                self.archive(vec![id])?;
            }
            Change::ArchiveSelection { ids } => self.archive(ids)?,
            Change::GroupSelection { ids } => {
                self.checked_selection(&ids)?;
                if ids.len() < 2 {
                    return Err(Error::Invalid("Select at least two objects to group"));
                }
                self.groups.push(Group {
                    id: Uuid::new_v4(),
                    members: ids,
                });
            }
            Change::Ungroup { id } => {
                let position = self
                    .groups
                    .iter()
                    .position(|group| group.id == id)
                    .ok_or(Error::Invalid("Group does not exist"))?;
                self.groups.remove(position);
            }
            Change::Paste {
                nodes,
                groups,
                links,
            } => {
                self.paste(nodes, groups, links)?;
            }
            Change::SaveIntelligentResult { id, result } => {
                intelligent::Document::save(&mut self.node_mut(id)?.content, result)?;
            }
            Change::EditResearch { .. }
            | Change::EditEditor { .. }
            | Change::RestoreRevision { .. }
            | Change::Undo
            | Change::Redo => {
                return Err(Error::Invalid(
                    "Revision changes must be resolved in storage",
                ));
            }
        }
        self.validate()
    }

    fn node_mut(&mut self, id: Uuid) -> Result<&mut Node> {
        self.nodes
            .iter_mut()
            .find(|node| node.id == id)
            .ok_or(Error::Invalid("Object does not exist"))
    }

    fn checked_selection(&self, ids: &[Uuid]) -> Result<HashSet<Uuid>> {
        let selection: HashSet<_> = ids.iter().copied().collect();
        if ids.is_empty()
            || selection.len() != ids.len()
            || self
                .nodes
                .iter()
                .filter(|node| selection.contains(&node.id))
                .count()
                != ids.len()
        {
            return Err(Error::Invalid("Invalid object selection"));
        }
        Ok(selection)
    }

    fn archive(&mut self, ids: Vec<Uuid>) -> Result<()> {
        let selected = self.checked_selection(&ids)?;
        self.nodes.retain(|node| !selected.contains(&node.id));
        self.links.retain(|link| {
            !selected.contains(&link.source.node_id) && !selected.contains(&link.target.node_id)
        });
        for group in &mut self.groups {
            group.members.retain(|id| !selected.contains(id));
        }
        self.groups.retain(|group| group.members.len() >= 2);
        Ok(())
    }

    fn paste(&mut self, nodes: Vec<Node>, groups: Vec<Group>, links: Vec<DataLink>) -> Result<()> {
        if nodes.is_empty() || nodes.len() > MAX_NODES - self.nodes.len() {
            return Err(Error::Invalid("Invalid paste size"));
        }
        let clipboard = Space {
            project_id: self.project_id,
            title: self.title.clone(),
            nodes,
            groups,
            links,
        };
        clipboard.validate()?;
        let mut identities = HashMap::new();
        for mut node in clipboard.nodes {
            let copy_id = Uuid::new_v4();
            identities.insert(node.id, copy_id);
            node.id = copy_id;
            if let Content::Portal { plain_id, .. } = &mut node.content {
                *plain_id = Uuid::new_v4();
            }
            Checklist::initialize(&mut node.content, true)?;
            Dataset::clone_rows(&mut node.content)?;
            scheme::Document::copy_elements(&mut node.content)?;
            self.nodes.push(node);
        }
        self.groups
            .extend(clipboard.groups.into_iter().map(|group| Group {
                id: Uuid::new_v4(),
                members: group.members.iter().map(|id| identities[id]).collect(),
            }));
        self.links
            .extend(clipboard.links.into_iter().map(|mut link| {
                link.id = Uuid::new_v4();
                link.source.node_id = identities[&link.source.node_id];
                link.target.node_id = identities[&link.target.node_id];
                link
            }));
        Ok(())
    }
}
