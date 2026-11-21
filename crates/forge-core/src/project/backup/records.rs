use super::*;
use rusqlite::types::Value as SqlValue;
use serde_json::Value;

pub(super) struct Table {
    pub name: &'static str,
    query: &'static str,
    insert: &'static str,
    columns: usize,
}

pub(super) const TABLES: &[Table] = &[
    Table {
        name: "history/revisions.jsonl",
        columns: 8,
        query: "SELECT json_array(revision,operation_id,actor,reason,occurred_at,CAST(snapshot AS TEXT),digest,request_digest) FROM revisions ORDER BY revision",
        insert: "INSERT INTO revisions(revision,operation_id,actor,reason,occurred_at,snapshot,digest,request_digest) VALUES(?1,?2,?3,?4,?5,CAST(?6 AS BLOB),?7,?8)",
    },
    Table {
        name: "data/navigation.jsonl",
        columns: 3,
        query: "SELECT json_array(revision,undo_revision,redo_revision) FROM revision_navigation ORDER BY revision",
        insert: "INSERT INTO revision_navigation VALUES(?1,?2,?3)",
    },
    Table {
        name: "data/assets.jsonl",
        columns: 2,
        query: "SELECT json_array(version_id,metadata) FROM asset_versions ORDER BY version_id",
        insert: "INSERT INTO asset_versions VALUES(?1,?2)",
    },
    Table {
        name: "data/imports.jsonl",
        columns: 3,
        query: "SELECT json_array(operation_id,request_digest,CAST(response AS TEXT)) FROM asset_import_batches ORDER BY operation_id",
        insert: "INSERT INTO asset_import_batches VALUES(?1,?2,CAST(?3 AS BLOB))",
    },
    Table {
        name: "data/analyses.jsonl",
        columns: 8,
        query: "SELECT json_array(sequence,operation_id,target_id,kind,project_revision,request_digest,CAST(summary AS TEXT),CAST(result AS TEXT)) FROM analyses ORDER BY sequence",
        insert: "INSERT INTO analyses VALUES(?1,?2,?3,?4,?5,?6,CAST(?7 AS BLOB),CAST(?8 AS BLOB),?9)",
    },
];

const MAX_LINE: u64 = 140 * 1024 * 1024;

pub(super) fn dump(db: &Connection, table: &Table, output: &mut impl Write) -> Result<u64> {
    let mut statement = db.prepare(table.query)?;
    let mut rows = statement.query([])?;
    let mut count = 0;
    while let Some(row) = rows.next()? {
        let encoded: String = row.get(0)?;
        if encoded.len() as u64 >= MAX_LINE {
            return Err(archive_limit("A logical project record is too large"));
        }
        output.write_all(encoded.as_bytes())?;
        output.write_all(b"\n")?;
        count += 1;
    }
    Ok(count)
}

pub(super) fn lines(input: impl Read, mut action: impl FnMut(&[u8]) -> Result<()>) -> Result<u64> {
    let mut reader = BufReader::new(input);
    let mut buffer = Vec::new();
    let mut count = 0;
    loop {
        buffer.clear();
        if (&mut reader)
            .take(MAX_LINE + 1)
            .read_until(b'\n', &mut buffer)?
            == 0
        {
            break;
        }
        if buffer.len() as u64 > MAX_LINE || !buffer.ends_with(b"\n") {
            return Err(invalid_archive(
                "A logical archive record is incomplete or exceeds its limit",
            ));
        }
        action(&buffer[..buffer.len() - 1])?;
        count += 1;
    }
    Ok(count)
}

pub(super) fn restore_record(
    db: &Connection,
    table: &Table,
    line: &[u8],
    source: Uuid,
    destination: Uuid,
) -> Result<()> {
    let values = validate_record(
        table,
        line,
        source,
        (source != destination).then_some(destination),
    )?;
    let parameters = values
        .into_iter()
        .map(|value| match value {
            Value::Null => SqlValue::Null,
            Value::Number(n) => SqlValue::Integer(n.as_i64().expect("verified integer")),
            Value::String(s) => SqlValue::Text(s),
            _ => unreachable!("verified logical record type"),
        })
        .collect::<Vec<_>>();
    db.execute(table.insert, rusqlite::params_from_iter(parameters.iter()))?;
    Ok(())
}

pub(super) fn validate_record(
    table: &Table,
    line: &[u8],
    source: Uuid,
    destination: Option<Uuid>,
) -> Result<Vec<Value>> {
    let mut values: Vec<Value> = serde_json::from_slice(line)
        .map_err(|_| invalid_archive("A logical archive record is invalid"))?;
    if values.len() != table.columns {
        return Err(invalid_archive(
            "A logical archive record has unexpected fields",
        ));
    }
    if !values
        .iter()
        .all(|value| value.is_null() || value.is_string() || value.is_i64())
    {
        return Err(invalid_archive("Invalid logical record value"));
    }
    if table.name == "history/revisions.jsonl" {
        let snapshot = text(&values[5])?;
        if !valid_uuid(text(&values[1])?)
            || digest(snapshot.as_bytes()) != text(&values[6])?
            || !valid_optional_hash(&values[7])
        {
            return Err(invalid_archive(
                "The project history contains an invalid revision",
            ));
        }
        let mut space: Space = decode(snapshot.as_bytes())?;
        if space.project_id != source {
            return Err(invalid_archive("A revision belongs to another project"));
        }
        space.validate()?;
        if let Some(destination) = destination {
            space.project_id = destination;
            let snapshot = encode(&space)?;
            values[6] = Value::String(digest(&snapshot));
            values[5] = Value::String(String::from_utf8(snapshot).expect("JSON is UTF-8"));
        }
    } else if table.name == "data/assets.jsonl" {
        let asset: AssetRef = serde_json::from_str(text(&values[1])?)?;
        if text(&values[0])? != asset.version_id.to_string() {
            return Err(invalid_archive("An asset version has an invalid identity"));
        }
        asset.validate()?;
    } else if table.name == "data/imports.jsonl" {
        if !valid_uuid(text(&values[0])?) || !valid_hash(text(&values[1])?) {
            return Err(invalid_archive("An import receipt has an invalid identity"));
        }
        let response: ImportResult = decode(text(&values[2])?.as_bytes())?;
        if response.revision < 0 {
            return Err(invalid_archive("An import receipt has an invalid revision"));
        }
    } else if table.name == "data/analyses.jsonl" {
        let operation = text(&values[1])?;
        let target = text(&values[2])?;
        let kind = text(&values[3])?;
        let request_hash = text(&values[5])?;
        let summary: Value = decode(text(&values[6])?.as_bytes())?;
        let result = text(&values[7])?;
        let result_hash = digest(result.as_bytes());
        let _: Value = decode(result.as_bytes())?;
        if !valid_uuid(operation)
            || !valid_uuid(target)
            || !valid_hash(request_hash)
            || !matches!(kind, "palette" | "metadata" | "comparison")
            || summary.get("id").and_then(Value::as_str) != Some(operation)
            || summary.get("projectRevision").and_then(Value::as_i64) != values[4].as_i64()
            || summary.get("resultDigest").and_then(Value::as_str) != Some(result_hash.as_str())
        {
            return Err(invalid_archive(
                "An analysis record has invalid provenance or digest",
            ));
        }
        values.push(Value::String(result_hash));
    }
    Ok(values)
}

fn text(value: &Value) -> Result<&str> {
    value
        .as_str()
        .ok_or_else(|| invalid_archive("Expected text in a logical record"))
}

fn valid_optional_hash(value: &Value) -> bool {
    value.is_null() || value.as_str().is_some_and(valid_hash)
}

fn valid_uuid(value: &str) -> bool {
    Uuid::parse_str(value).is_ok_and(|id| !id.is_nil() && id.to_string() == value)
}

pub(super) fn assets(db: &Connection) -> Result<Vec<AssetRef>> {
    let mut statement = db.prepare(
        "SELECT version_id, metadata FROM asset_versions ORDER BY version_id LIMIT 10001",
    )?;
    let rows = statement.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    let mut assets = Vec::new();
    for row in rows {
        let (version, value) = row?;
        if assets.len() >= MAX_MEMBERS {
            return Err(archive_limit("Too many registered asset versions"));
        }
        let asset: AssetRef = serde_json::from_str(&value)?;
        asset.validate()?;
        if version != asset.version_id.to_string() {
            return Err(invalid_archive("An asset registry key and version differ"));
        }
        assets.push(asset);
    }
    Ok(assets)
}

pub(super) fn health(db: &Connection, project: Uuid, expected: &ProjectData) -> Result<Space> {
    let checked: String = db.pragma_query_value(None, "quick_check", |row| row.get(0))?;
    let foreign_error: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_foreign_key_check)",
        [],
        |row| row.get(0),
    )?;
    if checked != "ok" || foreign_error {
        return Err(invalid_archive(
            "The logical project has invalid database relationships",
        ));
    }
    let (head, count): (i64, i64) =
        db.query_row("SELECT max(revision), count(*) FROM revisions", [], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })?;
    if head != expected.revision || head.checked_add(1) != Some(count) {
        return Err(invalid_archive("The project history is incomplete"));
    }
    for revision in 0..=head {
        let space = read_snapshot(db, project, revision)?;
        validate_asset_refs(db, &space)?;
        navigation_for(db, revision)?;
        let mut statement =
            db.prepare("SELECT target_id,kind FROM analyses WHERE project_revision=?1")?;
        let analyses = statement.query_map([revision], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        for analysis in analyses {
            let (target, kind) = analysis?;
            if !space.nodes.iter().any(|node| {
                node.id.to_string() == target
                    && matches!(&node.content, Content::Portal { type_id, schema_version: 1,.. }
                    if type_id.strip_prefix("forge.") == Some(kind.as_str()))
            }) {
                return Err(invalid_archive(
                    "An analysis does not belong to its recorded project revision",
                ));
            }
        }
    }
    let space = read_snapshot(db, project, head)?;
    if space.title != expected.title {
        return Err(invalid_archive(
            "The backup title differs from its current revision",
        ));
    }
    Ok(space)
}
