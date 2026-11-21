use std::io::{self, Seek, SeekFrom};

use serde_json::json;
use zip::{CompressionMethod, ZipWriter, write::SimpleFileOptions};

use super::*;

const MAX_EXPORT_BYTES: u64 = 96 * 1024 * 1024;
const EXPORT_TIMEOUT: Duration = Duration::from_secs(120);

impl Diagnostics {
    pub fn export(
        &mut self,
        destination: &Path,
        update: Option<&UpdateArchiveContext>,
    ) -> Result<()> {
        if let Some(update) = update {
            update.validate()?;
        }
        let name = destination.file_name().ok_or_else(unavailable)?;
        if !destination.is_absolute()
            || !destination
                .extension()
                .and_then(|part| part.to_str())
                .is_some_and(|part| part.eq_ignore_ascii_case("zip"))
        {
            return Err(Error::Invalid("Choose a .zip destination"));
        }
        let parent = fs::canonicalize(destination.parent().ok_or_else(unavailable)?)?;
        let destination = parent.join(name);
        if parent.starts_with(&self.root) {
            return Err(Error::Invalid(
                "Choose a location outside the diagnostics directory",
            ));
        }
        if destination.symlink_metadata().is_ok() {
            return Err(Error::ExportExists);
        }
        let created_at = now()?;
        self.prune(created_at)?;
        let path = parent.join(format!(".forge-logs-{}.tmp", Uuid::new_v4()));
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let file = options.open(&path)?;
        let draft = Draft(path);
        let mut output = ZipWriter::new(BudgetFile {
            file,
            written: 0,
            started: Instant::now(),
        });
        let mut members = serde_json::Map::new();

        start(&mut output, "events.jsonl")?;
        let events = self.for_each_audit(|event| {
            serde_json::to_writer(&mut output, &event)?;
            output.write_all(b"\n")?;
            Ok(true)
        })?;
        members.insert(
            "events.jsonl".into(),
            json!({ "records": events, "description": "Retained local audit events" }),
        );

        start(&mut output, "errors.json")?;
        output.write_all(b"[")?;
        let mut first = true;
        let errors = self.for_each_audit(|event| {
            if !event.outcome.is_error() {
                return Ok(false);
            }
            if !first {
                output.write_all(b",\n")?;
            }
            first = false;
            serde_json::to_writer(&mut output, &event)?;
            Ok(true)
        })?;
        output.write_all(b"]\n")?;
        members.insert(
            "errors.json".into(),
            json!({ "records": errors, "description": "Retained errors and denials" }),
        );

        start(&mut output, "README.txt")?;
        output.write_all(b"Forge desktop diagnostics\n\n\
            Timestamps are Unix milliseconds in UTC. Compare correlationId with the code shown by Forge.\n\
            For updates, compare manifest.json update.job.id with the update-stage event correlationId.\n\
            The archive carries technical operation names, stable error codes and project identifiers.\n\
            Usernames, paths, URLs, project content, payloads and original exception text are excluded.\n\
            Event, age and file limits are listed in manifest.json.\n")?;
        members.insert(
            "README.txt".into(),
            json!({ "description": "Archive use and redaction" }),
        );

        for (index, segment) in self.segments()?.iter().enumerate() {
            let name = format!("raw/runtime-{:02}.jsonl", index + 1);
            start(&mut output, &name)?;
            let records = write_operational(&mut output, segment, created_at - AGE_MS)?;
            members.insert(
                name,
                json!({ "records": records, "description": "Retained desktop lifecycle events" }),
            );
        }

        let audit_bytes: i64 = self.db.query_row(
            "SELECT COALESCE(SUM(length(CAST(payload AS BLOB))), 0) FROM events",
            [],
            |row| row.get(0),
        )?;
        let raw_bytes: u64 = self.segments()?.iter().map(|segment| segment.bytes).sum();
        start(&mut output, "manifest.json")?;
        let mut manifest = json!({
            "format": "forge-diagnostics",
            "schemaVersion": 1,
            "sourceVersion": env!("CARGO_PKG_VERSION"),
            "serviceRole": "forge-desktop",
            "createdAt": created_at,
            "auditEvents": events,
            "errorEvents": errors,
            "retainedBytesEstimate": audit_bytes as u64 + raw_bytes,
            "limits": {
                "auditCount": AUDIT_EVENTS,
                "auditBytes": AUDIT_BYTES,
                "ageDays": 30,
                "eventBytes": EVENT_BYTES,
                "runtimeFileBytes": FILE_BYTES,
                "runtimeFiles": FILE_COUNT,
                "directoryBytes": DIRECTORY_BYTES,
                "exportBytes": MAX_EXPORT_BYTES,
                "exportSeconds": EXPORT_TIMEOUT.as_secs(),
                "pageSize": PAGE
            },
            "members": members
        });
        if let Some(update) = update {
            manifest["update"] = serde_json::to_value(update)?;
        }
        serde_json::to_writer(&mut output, &manifest)?;
        let file = output.finish().map_err(|_| unavailable())?;
        file.file.sync_all()?;
        drop(file);
        rename_exclusive(&draft.0, &destination)
    }

    fn for_each_audit(&self, mut action: impl FnMut(Event<'_>) -> Result<bool>) -> Result<u64> {
        let mut query = self
            .db
            .prepare("SELECT payload FROM events ORDER BY occurred_at, sequence")?;
        let mut rows = query.query([])?;
        let mut count = 0;
        while let Some(row) = rows.next()? {
            let record = parse_record(&row.get::<_, String>(0)?)?;
            if action(record.event())? {
                count += 1;
            }
        }
        Ok(count)
    }
}

fn write_operational(output: &mut impl Write, segment: &Segment, cutoff: i64) -> Result<u64> {
    let mut input = BufReader::new(File::open(&segment.path)?.take(FILE_BYTES));
    let mut line = Vec::new();
    let mut count = 0;
    loop {
        line.clear();
        if (&mut input)
            .take(EVENT_BYTES as u64 + 1)
            .read_until(b'\n', &mut line)?
            == 0
        {
            return Ok(count);
        }
        if line.len() > EVENT_BYTES {
            return Err(unavailable());
        }
        if !line.ends_with(b"\n") {
            // An interrupted last append never becomes part of a logical export.
            return Ok(count);
        }
        let record = parse_record(std::str::from_utf8(&line).map_err(|_| unavailable())?)?;
        if !record.observation.action.operational() {
            return Err(unavailable());
        }
        if record.occurred_at >= cutoff {
            serde_json::to_writer(&mut *output, &record.event())?;
            output.write_all(b"\n")?;
            count += 1;
        }
    }
}

fn start(zip: &mut ZipWriter<BudgetFile>, name: &str) -> Result<()> {
    zip.start_file(
        name,
        SimpleFileOptions::default().compression_method(CompressionMethod::Stored),
    )
    .map_err(|_| unavailable())
}

struct Draft(PathBuf);

impl Drop for Draft {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

struct BudgetFile {
    file: File,
    written: u64,
    started: Instant,
}

impl Write for BudgetFile {
    fn write(&mut self, data: &[u8]) -> io::Result<usize> {
        if self.written.saturating_add(data.len() as u64) > MAX_EXPORT_BYTES
            || self.started.elapsed() > EXPORT_TIMEOUT
        {
            return Err(io::Error::other("Diagnostics export exceeded its budget"));
        }
        let written = self.file.write(data)?;
        self.written += written as u64;
        Ok(written)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.file.flush()
    }
}

impl Seek for BudgetFile {
    fn seek(&mut self, position: SeekFrom) -> io::Result<u64> {
        self.file.seek(position)
    }
}
