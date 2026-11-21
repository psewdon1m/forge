use serde::de;

use super::*;

#[derive(Clone, Copy)]
pub(super) enum AnalysisKind {
    Palette,
    Metadata,
    Comparison,
}

impl AnalysisKind {
    fn name(self) -> &'static str {
        match self {
            Self::Palette => "palette",
            Self::Metadata => "metadata",
            Self::Comparison => "comparison",
        }
    }

    pub(super) fn check_target(self, space: &Space, id: Uuid) -> Result<()> {
        let (portal, message) = match self {
            Self::Palette => (PALETTE, "Open a Palette card in this project"),
            Self::Metadata => (
                crate::data_links::METADATA,
                "Open a Metadata card in this project",
            ),
            Self::Comparison => (
                crate::data_links::COMPARISON,
                "Open a Comparison card in this project",
            ),
        };
        if space.nodes.iter().any(|node| node.id == id && matches!(
            &node.content, Content::Portal { type_id, schema_version: 1, .. } if type_id == portal
        )) {
            Ok(())
        } else {
            Err(Error::Invalid(message))
        }
    }
}

pub(super) struct AnalysisRecords<'db> {
    db: &'db Connection,
    target: Uuid,
    kind: AnalysisKind,
}

impl<'db> AnalysisRecords<'db> {
    pub(super) fn new(db: &'db Connection, kind: AnalysisKind, target: Uuid) -> Self {
        Self { db, target, kind }
    }

    pub(super) fn replay<T: de::DeserializeOwned>(
        &self,
        operation: Uuid,
        fingerprint: &str,
    ) -> Result<Option<T>> {
        let saved: Option<(String, String, String, Vec<u8>)> = self.db.query_row(
            "SELECT target_id, kind, request_digest, summary FROM analyses WHERE operation_id = ?1",
            [operation.to_string()],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        ).optional()?;
        let Some((target, kind, expected, summary)) = saved else {
            return Ok(None);
        };
        if target != self.target.to_string() || kind != self.kind.name() || expected != fingerprint
        {
            return Err(Error::Invalid(
                "This operation ID was already used for another analysis",
            ));
        }
        Ok(Some(serde_json::from_slice(&summary)?))
    }

    pub(super) fn latest<T: de::DeserializeOwned>(&self) -> Result<Option<T>> {
        let latest: Option<Vec<u8>> = self.db.query_row(
            "SELECT summary FROM analyses WHERE target_id = ?1 AND kind = ?2 ORDER BY sequence DESC LIMIT 1",
            params![self.target.to_string(), self.kind.name()],
            |row| row.get(0),
        ).optional()?;
        latest
            .as_deref()
            .map(|bytes| serde_json::from_slice(bytes).map_err(Error::from))
            .transpose()
    }

    pub(super) fn history<T: de::DeserializeOwned>(
        &self,
        before: Option<i64>,
    ) -> Result<Vec<AnalysisHistoryItem<T>>> {
        let mut statement = self.db.prepare(
            "SELECT sequence, summary FROM analyses WHERE target_id = ?1 AND kind = ?2
             AND (?3 IS NULL OR sequence < ?3) ORDER BY sequence DESC LIMIT 30",
        )?;
        let rows = statement.query_map(
            params![self.target.to_string(), self.kind.name(), before],
            |row| Ok((row.get(0)?, row.get::<_, Vec<u8>>(1)?)),
        )?;
        rows.map(|row| {
            let (cursor, bytes) = row?;
            Ok(AnalysisHistoryItem {
                cursor,
                summary: serde_json::from_slice(&bytes)?,
            })
        })
        .collect()
    }

    pub(super) fn result<T: de::DeserializeOwned>(&self, id: Uuid) -> Result<T> {
        let saved: Option<(Vec<u8>, String)> = self.db.query_row(
            "SELECT result, result_digest FROM analyses WHERE operation_id = ?1 AND target_id = ?2 AND kind = ?3",
            params![id.to_string(), self.target.to_string(), self.kind.name()],
            |row| Ok((row.get(0)?, row.get(1)?)),
        ).optional()?;
        let (data, stored_digest) = saved.ok_or(Error::Invalid(
            "This result is unavailable for this analysis",
        ))?;
        if digest(&data) != stored_digest {
            return Err(Error::Corrupt(
                "The analysis result failed its integrity check",
            ));
        }
        Ok(serde_json::from_slice(&data)?)
    }

    pub(super) fn commit(
        &self,
        provenance: &Provenance,
        fingerprint: &str,
        summary: &impl Serialize,
        result: Vec<u8>,
        observe: &mut impl FnMut(AnalysisPhase) -> Result<()>,
    ) -> Result<()> {
        let summary = encode(summary)?;
        observe(AnalysisPhase::Committing)?;
        self.db.execute(
            "INSERT INTO analyses(operation_id, target_id, kind, project_revision, request_digest, summary, result, result_digest)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![provenance.id.to_string(), self.target.to_string(), self.kind.name(), provenance.project_revision,
                fingerprint, summary, result, provenance.result_digest],
        )?;
        Ok(())
    }
}
