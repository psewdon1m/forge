use std::{
    cmp::Ordering,
    io::{Read, Write},
    path::Path,
};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use uuid::Uuid;

use crate::{
    Content, Error, Result,
    assets::{open_source, source_name},
};

pub(crate) const TYPE_ID: &str = "forge.dataset";
const MAX_INPUT: usize = 512 * 1024;
const MAX_CELL: usize = 4_096;
const MAX_ROWS: usize = 2_000;
const MAX_COLUMNS: usize = 32;
const MAX_PAYLOAD: usize = 1024 * 1024;

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Delimiter {
    Comma,
    Tab,
}

impl Delimiter {
    fn char(self) -> char {
        match self {
            Self::Comma => ',',
            Self::Tab => '\t',
        }
    }

    pub fn extension(self) -> &'static str {
        match self {
            Self::Comma => "csv",
            Self::Tab => "tsv",
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ColumnKind {
    String,
    Number,
    Boolean,
    Date,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImportOptions {
    pub delimiter: Delimiter,
    pub header: bool,
    #[serde(default)]
    pub types: Vec<ColumnKind>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Column {
    pub name: String,
    pub kind: ColumnKind,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Row {
    id: Uuid,
    cells: Vec<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Dataset {
    pub columns: Vec<Column>,
    rows: Vec<Row>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Issue {
    pub line: usize,
    pub column: Option<usize>,
    pub message: &'static str,
}

impl Issue {
    fn error(&self) -> Error {
        Error::Dataset {
            line: self.line,
            column: self.column,
            message: self.message,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub columns: Vec<Column>,
    pub rows: Vec<PreviewRow>,
    pub total: usize,
    pub issues: Vec<Issue>,
    pub issue_count: usize,
}

#[derive(Debug, Serialize)]
pub struct PreviewRow {
    line: usize,
    cells: Vec<String>,
}

struct Parsed {
    columns: Vec<Column>,
    rows: Vec<PreviewRow>,
    issues: Vec<Issue>,
    issue_count: usize,
}

#[derive(Debug, Serialize)]
pub struct InputFile {
    name: String,
    delimiter: Delimiter,
    text: String,
}

pub fn read_input(path: &Path) -> Result<InputFile> {
    let name = source_name(path)?;
    let delimiter = match path
        .extension()
        .and_then(|part| part.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("csv") => Delimiter::Comma,
        Some("tsv") => Delimiter::Tab,
        _ => return Err(Error::Invalid("Choose a CSV or TSV file")),
    };
    let mut bytes = Vec::new();
    open_source(path)?
        .take(MAX_INPUT as u64 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > MAX_INPUT {
        return Err(Error::Link(
            "DATASET_LIMIT",
            "CSV and TSV input is limited to 512 KiB",
        ));
    }
    let text = String::from_utf8(bytes)
        .map_err(|_| Error::Link("DATASET_ENCODING", "CSV and TSV require valid UTF-8"))?;
    check_input(&text).map_err(|issue| issue.error())?;
    Ok(InputFile {
        name,
        delimiter,
        text,
    })
}

pub fn preview(text: &str, options: &ImportOptions) -> Preview {
    let parsed = parse(text, options);
    Preview {
        columns: parsed.columns,
        total: parsed.rows.len(),
        rows: parsed.rows.into_iter().take(8).collect(),
        issues: parsed.issues,
        issue_count: parsed.issue_count,
    }
}

fn parse(text: &str, options: &ImportOptions) -> Parsed {
    let mut result = Parsed {
        columns: vec![],
        rows: vec![],
        issues: vec![],
        issue_count: 0,
    };
    let mut records = match check_input(text).and_then(|()| records(text, options.delimiter)) {
        Ok(records) if !records.is_empty() => records,
        Ok(_) => {
            result.issue(0, None, "The input contains no rows");
            return result;
        }
        Err(issue) => {
            result.issue(issue.line, issue.column, issue.message);
            return result;
        }
    };
    let width = records[0].cells.len();
    if (!options.types.is_empty() && options.types.len() != width) || width > MAX_COLUMNS {
        result.issue(
            records[0].line,
            None,
            "The selected column types do not match the input",
        );
        return result;
    }
    result.columns = (0..width)
        .map(|index| {
            let name = if options.header && !records[0].cells[index].trim().is_empty() {
                records[0].cells[index].clone()
            } else {
                format!("Column {}", index + 1)
            };
            Column {
                name,
                kind: options
                    .types
                    .get(index)
                    .copied()
                    .unwrap_or(ColumnKind::String),
            }
        })
        .collect();
    for (index, column) in result.columns.iter().enumerate() {
        if !valid_cell(&column.name) {
            result.issues.push(Issue {
                line: 1,
                column: Some(index + 1),
                message: "Invalid column label",
            });
            result.issue_count += 1;
        }
    }
    if options.header {
        records.remove(0);
    }
    if records.len() > MAX_ROWS {
        result.issue(
            records[MAX_ROWS].line,
            None,
            "A Dataset can contain up to 2,000 data rows",
        );
        return result;
    }
    for record in &mut records {
        if record.cells.len() > width {
            result.issue(
                record.line,
                Some(width + 1),
                "This row has more cells than the header or first row",
            );
            record.cells.truncate(width);
        }
        record.cells.resize_with(width, String::new);
        for (index, (raw, column)) in record.cells.iter().zip(&result.columns).enumerate() {
            if !valid(column.kind, raw) {
                result.issue_count += 1;
                if result.issues.len() < 20 {
                    result.issues.push(Issue {
                        line: record.line,
                        column: Some(index + 1),
                        message: expected(column.kind),
                    });
                }
            }
        }
    }
    result.rows = records;
    if result.issue_count == 0 {
        let preview = Dataset {
            columns: result.columns.clone(),
            rows: result
                .rows
                .iter()
                .map(|row| Row {
                    id: Uuid::nil(),
                    cells: row.cells.clone(),
                })
                .collect(),
        };
        if serde_json::to_vec(&preview).map_or(true, |bytes| bytes.len() > MAX_PAYLOAD) {
            result.issue(0, None, "The saved Dataset exceeds the 1 MiB Plain limit");
        }
    }
    result
}

impl Parsed {
    fn issue(&mut self, line: usize, column: Option<usize>, message: &'static str) {
        self.issue_count += 1;
        if self.issues.len() < 20 {
            self.issues.push(Issue {
                line,
                column,
                message,
            });
        }
    }

    fn build(self) -> Result<Dataset> {
        if let Some(issue) = self.issues.first() {
            return Err(issue.error());
        }
        let table = Dataset {
            columns: self.columns,
            rows: self
                .rows
                .into_iter()
                .map(|row| Row {
                    id: Uuid::new_v4(),
                    cells: row.cells,
                })
                .collect(),
        };
        table.validate()?;
        Ok(table)
    }
}

fn check_input(text: &str) -> std::result::Result<(), Issue> {
    if text.len() > MAX_INPUT {
        return Err(Issue {
            line: 0,
            column: None,
            message: "CSV and TSV input is limited to 512 KiB",
        });
    }
    if text
        .bytes()
        .any(|byte| byte < 32 && !matches!(byte, b'\r' | b'\n' | b'\t'))
    {
        return Err(Issue {
            line: 0,
            column: None,
            message: "The input contains an unsupported control character",
        });
    }
    Ok(())
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum State {
    Start,
    Plain,
    Quoted,
    AfterQuote,
}

fn records(text: &str, delimiter: Delimiter) -> std::result::Result<Vec<PreviewRow>, Issue> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut input = text.chars().peekable();
    let mut rows = Vec::new();
    let mut cells = Vec::new();
    let mut field = String::new();
    let mut state = State::Start;
    let mut line = 1;
    let mut row_line = 1;
    let mut pending = false;
    let delimiter = delimiter.char();
    while let Some(ch) = input.next() {
        let error = |message| Issue {
            line,
            column: Some(cells.len() + 1),
            message,
        };
        pending = true;
        if state == State::Quoted {
            match ch {
                '"' if input.next_if_eq(&'"').is_some() => field.push('"'),
                '"' => state = State::AfterQuote,
                '\r' if input.next_if_eq(&'\n').is_some() => {
                    field.push_str("\r\n");
                    line += 1;
                }
                '\r' | '\n' => {
                    field.push(ch);
                    line += 1;
                }
                _ => field.push(ch),
            }
        } else if ch == delimiter {
            cells.push(std::mem::take(&mut field));
            if cells.len() >= MAX_COLUMNS {
                return Err(Issue {
                    line,
                    column: Some(cells.len() + 1),
                    message: "A Dataset can contain up to 32 columns",
                });
            }
            state = State::Start;
        } else if matches!(ch, '\r' | '\n') {
            if ch == '\r' {
                input.next_if_eq(&'\n');
            }
            push_record(&mut rows, &mut cells, &mut field, row_line)?;
            state = State::Start;
            pending = false;
            line += 1;
            row_line = line;
        } else {
            match (state, ch) {
                (State::Start, '"') => state = State::Quoted,
                (State::AfterQuote, _) | (_, '"') => {
                    return Err(error("Unexpected quote or text after a closing quote"));
                }
                _ => {
                    state = State::Plain;
                    field.push(ch);
                }
            }
        }
        if field.len() > MAX_CELL {
            return Err(Issue {
                line,
                column: Some(cells.len() + 1),
                message: "A cell can contain up to 4,096 UTF-8 bytes",
            });
        }
    }
    if state == State::Quoted {
        return Err(Issue {
            line,
            column: Some(cells.len() + 1),
            message: "Quoted cell is missing its closing quote",
        });
    }
    if pending {
        push_record(&mut rows, &mut cells, &mut field, row_line)?;
    }
    Ok(rows)
}

fn push_record(
    rows: &mut Vec<PreviewRow>,
    cells: &mut Vec<String>,
    field: &mut String,
    line: usize,
) -> std::result::Result<(), Issue> {
    if rows.len() > MAX_ROWS {
        return Err(Issue {
            line,
            column: None,
            message: "A Dataset can contain up to 2,000 data rows",
        });
    }
    cells.push(std::mem::take(field));
    rows.push(PreviewRow {
        line,
        cells: std::mem::take(cells),
    });
    Ok(())
}

fn valid_cell(raw: &str) -> bool {
    raw.len() <= MAX_CELL
        && !raw
            .bytes()
            .any(|byte| byte < 32 && !matches!(byte, b'\t' | b'\r' | b'\n'))
}

fn finite_number(raw: &str) -> Option<f64> {
    raw.parse::<f64>().ok().filter(|value| value.is_finite())
}

fn valid(kind: ColumnKind, raw: &str) -> bool {
    if !valid_cell(raw) {
        return false;
    }
    if raw.is_empty() {
        return true;
    }
    match kind {
        ColumnKind::String => true,
        ColumnKind::Number => finite_number(raw).is_some(),
        ColumnKind::Boolean => {
            raw.eq_ignore_ascii_case("true") || raw.eq_ignore_ascii_case("false")
        }
        ColumnKind::Date => date(raw),
    }
}

fn expected(kind: ColumnKind) -> &'static str {
    match kind {
        ColumnKind::String => "Expected text within the cell size limit",
        ColumnKind::Number => "Expected a finite number with a decimal point",
        ColumnKind::Boolean => "Expected true or false",
        ColumnKind::Date => "Expected a valid YYYY-MM-DD date",
    }
}

fn date(raw: &str) -> bool {
    let bytes = raw.as_bytes();
    if bytes.len() != 10
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || !bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| matches!(index, 4 | 7) || byte.is_ascii_digit())
    {
        return false;
    }
    let year = raw[0..4].parse::<u16>().unwrap();
    let month = raw[5..7].parse::<u8>().unwrap();
    let day = raw[8..10].parse::<u8>().unwrap();
    if year == 0 || day == 0 {
        return false;
    }
    let leap = year.is_multiple_of(4) && (!year.is_multiple_of(100) || year.is_multiple_of(400));
    day <= match month {
        2 => {
            if leap {
                29
            } else {
                28
            }
        }
        4 | 6 | 9 | 11 => 30,
        1..=12 => 31,
        _ => 0,
    }
}

impl Dataset {
    pub(crate) fn model_rows(&self, offset: usize, limit: usize) -> Result<String> {
        if !(1..=100).contains(&limit) || offset >= self.rows.len() {
            return Err(Error::Link(
                "MODEL_CONTEXT_EMPTY",
                "Select an available Dataset row range of up to 100 rows",
            ));
        }
        if self
            .columns
            .iter()
            .any(|column| crate::intelligent::credential_label(&column.name))
        {
            return Err(crate::intelligent::sensitive());
        }
        let end = offset.saturating_add(limit).min(self.rows.len());
        if self.rows[offset..end]
            .iter()
            .flat_map(|row| row.cells.iter())
            .any(|cell| crate::intelligent::contains_credentials(cell))
        {
            return Err(crate::intelligent::sensitive());
        }
        Ok(serde_json::to_string(&(
            &self.columns,
            &self.rows[offset..end],
        ))?)
    }
    pub fn decode(payload: &str) -> Result<Self> {
        let result: Self =
            serde_json::from_str(payload).map_err(|_| Error::Invalid("Invalid Dataset payload"))?;
        result.validate()?;
        Ok(result)
    }

    pub(crate) fn payload(content: &Content) -> Result<&str> {
        match content {
            Content::Portal {
                type_id,
                schema_version: 1,
                payload,
                ..
            } if type_id == TYPE_ID => Ok(payload),
            _ => Err(Error::Invalid("That object is not a supported Dataset")),
        }
    }

    fn validate(&self) -> Result<()> {
        use std::collections::HashSet;
        if self.columns.len() > MAX_COLUMNS
            || self.rows.len() > MAX_ROWS
            || self.columns.is_empty() && !self.rows.is_empty()
            || self
                .columns
                .iter()
                .any(|column| column.name.trim().is_empty() || !valid_cell(&column.name))
        {
            return Err(Error::Invalid("Invalid Dataset dimensions or column label"));
        }
        let mut ids = HashSet::new();
        for row in &self.rows {
            if row.id.is_nil() || !ids.insert(row.id) || row.cells.len() != self.columns.len() {
                return Err(Error::Invalid("Invalid Dataset row identity or width"));
            }
            if !row
                .cells
                .iter()
                .zip(&self.columns)
                .all(|(raw, column)| valid(column.kind, raw))
            {
                return Err(Error::Invalid("Dataset contains an invalid typed cell"));
            }
        }
        Ok(())
    }

    fn store(self, content: &mut Content) -> Result<()> {
        Self::payload(content)?;
        let encoded = serde_json::to_string(&self)?;
        if encoded.len() > MAX_PAYLOAD {
            return Err(Error::Link(
                "DATASET_LIMIT",
                "The saved Dataset exceeds the 1 MiB Plain limit",
            ));
        }
        let Content::Portal { payload, .. } = content else {
            unreachable!()
        };
        *payload = encoded;
        Ok(())
    }

    pub(crate) fn import(content: &mut Content, text: &str, options: &ImportOptions) -> Result<()> {
        Self::payload(content)?;
        parse(text, options).build()?.store(content)
    }

    pub(crate) fn edit(
        content: &mut Content,
        row_id: Uuid,
        column: usize,
        raw: String,
    ) -> Result<()> {
        let mut data = Self::decode(Self::payload(content)?)?;
        let kind = data
            .columns
            .get(column)
            .ok_or(Error::Invalid("Dataset column is missing"))?
            .kind;
        let (index, row) = data
            .rows
            .iter_mut()
            .enumerate()
            .find(|(_, row)| row.id == row_id)
            .ok_or(Error::Invalid("Dataset row is missing"))?;
        if !valid(kind, &raw) {
            return Err(Error::Dataset {
                line: index + 1,
                column: Some(column + 1),
                message: expected(kind),
            });
        }
        row.cells[column] = raw;
        data.store(content)
    }

    pub(crate) fn clone_rows(content: &mut Content) -> Result<()> {
        if let Ok(payload) = Self::payload(content) {
            let mut table = Self::decode(payload)?;
            for row in &mut table.rows {
                row.id = Uuid::new_v4();
            }
            table.store(content)?;
        }
        Ok(())
    }

    pub(crate) fn page(self, source_revision: String, query: &Query) -> Result<Page> {
        if query.limit == 0 || query.limit > 100 || query.filter.chars().count() > 240 {
            return Err(Error::Invalid("Invalid Dataset page or filter"));
        }
        let filter = query.filter.to_lowercase();
        let mut rows: Vec<_> = self
            .rows
            .into_iter()
            .enumerate()
            .filter(|(_, row)| {
                filter.is_empty()
                    || row
                        .cells
                        .iter()
                        .any(|raw| raw.to_lowercase().contains(&filter))
            })
            .collect();
        if let Some(sort) = &query.sort {
            let column = self
                .columns
                .get(sort.column)
                .ok_or(Error::Invalid("Dataset sort column is missing"))?;
            rows.sort_by(|(_, a), (_, b)| {
                compare(
                    column.kind,
                    &a.cells[sort.column],
                    &b.cells[sort.column],
                    sort.descending,
                )
            });
        }
        let total = rows.len();
        let end = query.offset.saturating_add(query.limit).min(total);
        if query.offset > total {
            return Err(Error::Invalid(
                "Dataset page starts outside the filtered rows",
            ));
        }
        let page = rows
            .into_iter()
            .skip(query.offset)
            .take(end - query.offset)
            .map(|(ordinal, row)| PageRow {
                id: row.id,
                ordinal: ordinal + 1,
                cells: row
                    .cells
                    .into_iter()
                    .zip(&self.columns)
                    .map(|(raw, column)| PageCell {
                        value: typed(column.kind, &raw),
                        raw,
                    })
                    .collect(),
            })
            .collect();
        Ok(Page {
            source_revision,
            columns: self.columns,
            rows: page,
            total,
            next_offset: (end < total).then_some(end),
        })
    }

    pub(crate) fn export(&self, delimiter: Delimiter, out: &mut impl Write) -> Result<()> {
        if self.columns.is_empty() {
            return Err(Error::Invalid("Add columns before exporting a Dataset"));
        }
        write_row(
            out,
            delimiter,
            self.columns
                .iter()
                .map(|column| (column.name.as_str(), true)),
        )?;
        for row in &self.rows {
            write_row(
                out,
                delimiter,
                row.cells.iter().zip(&self.columns).map(|(value, column)| {
                    (value.as_str(), matches!(column.kind, ColumnKind::String))
                }),
            )?;
        }
        Ok(())
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Query {
    pub offset: usize,
    pub limit: usize,
    pub source_revision: Option<String>,
    #[serde(default)]
    pub filter: String,
    pub sort: Option<Sort>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Sort {
    column: usize,
    descending: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    source_revision: String,
    columns: Vec<Column>,
    rows: Vec<PageRow>,
    total: usize,
    next_offset: Option<usize>,
}

#[derive(Debug, Serialize)]
struct PageRow {
    id: Uuid,
    ordinal: usize,
    cells: Vec<PageCell>,
}

#[derive(Debug, Serialize)]
struct PageCell {
    raw: String,
    value: Value,
}

fn typed(kind: ColumnKind, raw: &str) -> Value {
    if raw.is_empty() {
        return Value::Null;
    }
    match kind {
        ColumnKind::Number => json!(finite_number(raw)),
        ColumnKind::Boolean => Value::Bool(raw.eq_ignore_ascii_case("true")),
        ColumnKind::Date | ColumnKind::String => Value::String(raw.into()),
    }
}

fn compare(kind: ColumnKind, a: &str, b: &str, reverse: bool) -> Ordering {
    match (a.is_empty(), b.is_empty()) {
        (true, true) => return Ordering::Equal,
        (true, false) => return Ordering::Greater,
        (false, true) => return Ordering::Less,
        _ => {}
    }
    let order = match kind {
        ColumnKind::Number => finite_number(a)
            .unwrap()
            .total_cmp(&finite_number(b).unwrap()),
        ColumnKind::Boolean => a
            .eq_ignore_ascii_case("true")
            .cmp(&b.eq_ignore_ascii_case("true")),
        ColumnKind::String => a.to_lowercase().cmp(&b.to_lowercase()),
        ColumnKind::Date => a.cmp(b),
    };
    if reverse { order.reverse() } else { order }
}

fn write_row<'a>(
    out: &mut impl Write,
    delimiter: Delimiter,
    fields: impl Iterator<Item = (&'a str, bool)>,
) -> std::io::Result<()> {
    for (index, (value, text)) in fields.enumerate() {
        if index > 0 {
            out.write_all(&[delimiter.char() as u8])?;
        }
        out.write_all(b"\"")?;
        if text && formula_like(value) {
            out.write_all(b"text: ")?;
        }
        out.write_all(value.replace('"', "\"\"").as_bytes())?;
        out.write_all(b"\"")?;
    }
    out.write_all(b"\r\n")
}

fn formula_like(value: &str) -> bool {
    value.starts_with(['\t', '\r', '\n'])
        || value
            .trim_start_matches(|ch: char| {
                ch.is_whitespace() || matches!(ch, '\u{feff}' | '\u{200b}' | '\'')
            })
            .starts_with(['=', '+', '-', '@', '＝', '＋', '－', '＠'])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn options(delimiter: Delimiter) -> ImportOptions {
        ImportOptions {
            delimiter,
            header: true,
            types: vec![
                ColumnKind::String,
                ColumnKind::Number,
                ColumnKind::Boolean,
                ColumnKind::Date,
            ],
        }
    }

    #[test]
    fn preview_reports_physical_rows_and_types_around_multiline_records() {
        let csv = "\u{feff}Name,Cost,Ready,Day\r\n\"A,\r\n\"\"B\"\"\",-2,TRUE,2024-02-29\r\nC,no,yes,2025-02-29\r\nShort\r\n";
        let model = preview(csv, &options(Delimiter::Comma));
        assert_eq!(model.total, 3);
        assert_eq!(model.rows[0].cells[0], "A,\r\n\"B\"");
        assert_eq!(model.rows[2].cells, ["Short", "", "", ""]);
        assert_eq!(model.issue_count, 3);
        assert_eq!(
            model
                .issues
                .iter()
                .map(|issue| (issue.line, issue.column))
                .collect::<Vec<_>>(),
            [(4, Some(2)), (4, Some(3)), (4, Some(4))]
        );
        let broken = preview(
            "Name,Cost,Ready,Day\n\"Broken\"suffix,1,true,2026-01-01",
            &options(Delimiter::Comma),
        );
        assert_eq!(
            (broken.issues[0].line, broken.issues[0].column),
            (2, Some(1))
        );
        let oversized = preview(&"x".repeat(MAX_INPUT + 1), &options(Delimiter::Comma));
        assert_eq!(oversized.issue_count, 1);
    }

    #[test]
    fn tabular_view_keeps_raw_values_and_safe_exports_protect_only_text() {
        let tsv = "=Label\tCost\tReady\tDay\r\n\"   ＝example\"\t-2\tTRUE\t2024-02-29\r\nSecond\t03.50\tfalse\t\r\nLast\r\n";
        let data = parse(tsv, &options(Delimiter::Tab)).build().unwrap();
        let mut output = vec![];
        data.export(Delimiter::Comma, &mut output).unwrap();
        let output = String::from_utf8(output).unwrap();
        assert!(output.starts_with("\"text: =Label\",\"Cost\",\"Ready\",\"Day\"\r\n"));
        assert!(output.contains("\"text:    ＝example\",\"-2\",\"TRUE\",\"2024-02-29\"\r\n"));
        let query = Query {
            offset: 0,
            limit: 3,
            source_revision: None,
            filter: String::new(),
            sort: Some(Sort {
                column: 1,
                descending: true,
            }),
        };
        let page = data.page("test-revision".into(), &query).unwrap();
        assert_eq!(
            page.rows.iter().map(|row| row.ordinal).collect::<Vec<_>>(),
            [2, 1, 3]
        );
        assert_eq!(page.rows[0].cells[1].raw, "03.50");
        assert_eq!(page.rows[0].cells[1].value, json!(3.5));
        assert_eq!(page.rows[1].cells[0].raw, "   ＝example");
        assert_eq!(page.rows[1].cells[2].value, json!(true));
        assert!(page.rows[2].cells[1].value.is_null());
    }
}
