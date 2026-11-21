use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{Content, Error, Result, model::validate_label};

pub(crate) const CHECKLIST_TYPE: &str = "forge.checklist";

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChecklistItem {
    pub id: Uuid,
    pub label: String,
    pub done: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group_id: Option<Uuid>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completion: Option<ChecklistCompletion>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChecklistGroup {
    pub id: Uuid,
    pub label: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChecklistCompletion {
    pub occurred_at: String,
    pub revision: i64,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Checklist {
    pub items: Vec<ChecklistItem>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub groups: Vec<ChecklistGroup>,
}

impl Checklist {
    pub(crate) fn decode(payload: &str) -> Result<Self> {
        let list: Self = serde_json::from_str(payload)
            .map_err(|_| Error::Invalid("Invalid checklist payload"))?;
        list.validate()?;
        Ok(list)
    }

    pub(crate) fn from_content(content: &Content) -> Result<Self> {
        match content {
            Content::Portal {
                type_id,
                schema_version: 1,
                payload,
                ..
            } if type_id == CHECKLIST_TYPE => Self::decode(payload),
            _ => Err(Error::Invalid("That object is not a supported checklist")),
        }
    }

    fn validate(&self) -> Result<()> {
        if self.items.len() > 100 || self.groups.len() > 20 {
            return Err(Error::Invalid(
                "A checklist supports up to 100 tasks and 20 groups",
            ));
        }
        let mut groups = HashSet::new();
        for group in &self.groups {
            if group.id.is_nil() || !groups.insert(group.id) {
                return Err(Error::Invalid(
                    "Duplicate or empty checklist group identity",
                ));
            }
            validate_label(&group.label)?;
        }
        let mut ids = HashSet::new();
        for item in &self.items {
            if item.id.is_nil() || !ids.insert(item.id) || groups.contains(&item.id) {
                return Err(Error::Invalid("Duplicate or empty task identity"));
            }
            validate_label(&item.label)?;
            if item.group_id.is_some_and(|id| !groups.contains(&id)) {
                return Err(Error::Invalid("A task refers to a missing group"));
            }
            if let Some(completion) = &item.completion
                && (!item.done || completion.revision <= 0 || !valid_utc(&completion.occurred_at))
            {
                return Err(Error::Invalid("Invalid checklist completion record"));
            }
        }
        Ok(())
    }

    pub(crate) fn edit(
        content: &mut Content,
        mut items: Vec<ChecklistItem>,
        groups: Option<Vec<ChecklistGroup>>,
        stamp: &ChecklistCompletion,
    ) -> Result<()> {
        let previous = Self::from_content(content)?;
        let existing = previous
            .items
            .iter()
            .map(|item| (item.id, item))
            .collect::<HashMap<_, _>>();
        for item in &mut items {
            item.completion = if item.done {
                match existing.get(&item.id).filter(|item| item.done) {
                    Some(item) => item.completion.clone(),
                    None => Some(stamp.clone()),
                }
            } else {
                None
            };
        }
        let list = Self {
            items,
            groups: groups.unwrap_or(previous.groups),
        };
        list.validate()?;
        let Content::Portal { payload, .. } = content else {
            unreachable!()
        };
        *payload = serde_json::to_string(&list)?;
        Ok(())
    }

    pub(crate) fn initialize(content: &mut Content, pasted: bool) -> Result<()> {
        let Content::Portal {
            type_id,
            schema_version: 1,
            payload,
            ..
        } = content
        else {
            return Ok(());
        };
        if type_id != CHECKLIST_TYPE {
            return Ok(());
        }
        let mut list = Self::decode(payload)?;
        let ids = if pasted {
            list.groups
                .iter_mut()
                .map(|group| {
                    let old = group.id;
                    group.id = Uuid::new_v4();
                    (old, group.id)
                })
                .collect::<HashMap<_, _>>()
        } else {
            HashMap::new()
        };
        for item in &mut list.items {
            if pasted {
                item.id = Uuid::new_v4();
                item.group_id = item.group_id.map(|id| ids[&id]);
            }
            item.completion = None;
        }
        *payload = serde_json::to_string(&list)?;
        Ok(())
    }

    pub(crate) fn text(&self) -> String {
        let mut lines = Vec::new();
        let items = |group_id| {
            self.items
                .iter()
                .filter(move |item| item.group_id == group_id)
                .map(|item| format!("- [{}] {}", if item.done { "x" } else { " " }, item.label))
        };
        lines.extend(items(None));
        for group in &self.groups {
            lines.push(group.label.clone());
            lines.extend(items(Some(group.id)));
        }
        lines.join("\n")
    }
}

fn valid_utc(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 24
        && bytes.iter().enumerate().all(|(index, byte)| match index {
            4 | 7 => *byte == b'-',
            10 => *byte == b'T',
            13 | 16 => *byte == b':',
            19 => *byte == b'.',
            23 => *byte == b'Z',
            _ => byte.is_ascii_digit(),
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn legacy_completion_keeps_unknown_time_and_new_marks_use_the_core_revision() {
        let old_id = Uuid::new_v4();
        let new_id = Uuid::new_v4();
        let group = Uuid::new_v4();
        let mut content = Content::Portal {
            plain_id: Uuid::new_v4(),
            type_id: CHECKLIST_TYPE.into(),
            schema_version: 1,
            payload: json!({ "items": [{ "id": old_id, "label": "Legacy", "done": true }] })
                .to_string(),
        };
        let mut items = Checklist::from_content(&content).unwrap().items;
        items.push(ChecklistItem {
            id: new_id,
            label: "New".into(),
            done: true,
            group_id: Some(group),
            completion: Some(ChecklistCompletion {
                occurred_at: "forged".into(),
                revision: 9000,
            }),
        });
        let stamp = ChecklistCompletion {
            occurred_at: "2026-11-20T10:00:00.000Z".into(),
            revision: 2,
        };
        Checklist::edit(
            &mut content,
            items,
            Some(vec![ChecklistGroup {
                id: group,
                label: "Lighting".into(),
            }]),
            &stamp,
        )
        .unwrap();
        let list = Checklist::from_content(&content).unwrap();
        assert_eq!(list.items[0].completion, None);
        assert_eq!(list.items[1].completion.as_ref(), Some(&stamp));
        assert_eq!(list.text(), "- [x] Legacy\nLighting\n- [x] New");

        let mut copied = content.clone();
        Checklist::initialize(&mut copied, true).unwrap();
        let copied = Checklist::from_content(&copied).unwrap();
        assert_ne!(copied.groups[0].id, group);
        assert_ne!(copied.items[1].id, new_id);
        assert_eq!(copied.items[1].group_id, Some(copied.groups[0].id));
        assert!(copied.items[1].done);
        assert_eq!(copied.items[1].completion, None);

        let mut items = list.items;
        items[1].done = false;
        Checklist::edit(&mut content, items, None, &stamp).unwrap();
        let list = Checklist::from_content(&content).unwrap();
        assert_eq!(list.items[1].completion, None);
        assert_eq!(list.groups[0].id, group);
    }
}
