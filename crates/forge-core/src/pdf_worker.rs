use std::{
    io::{self, Read, Write},
    process::{Child, Command, Stdio},
    thread,
    time::{Duration, Instant},
};

use forge_core::{
    Error, Result,
    research::{MAX_PDF_BYTES, MAX_TEXT},
};
use lopdf::{DecompressError, Document, LoadOptions};

pub const ARGUMENT: &str = "--extract-research-pdf";
const MEMORY_LIMIT: usize = 256 * 1024 * 1024;
const STREAM_LIMIT: usize = 8 * 1024 * 1024;
const PAGE_LIMIT: usize = 256;
const DEADLINE: Duration = Duration::from_secs(8);
const TEXT: u8 = 0;
const EMPTY: u8 = 1;
const LIMIT: u8 = 2;
const INVALID: u8 = 3;

fn unavailable() -> Error {
    Error::Link("PDF_UNAVAILABLE", "The PDF text worker could not finish")
}

pub fn extract(input: &[u8]) -> Result<String> {
    extract_with_checkpoint(input, &mut || Ok(()))
}

pub fn extract_with_checkpoint(
    input: &[u8],
    checkpoint: &mut dyn FnMut() -> Result<()>,
) -> Result<String> {
    checkpoint()?;
    let executable = std::env::current_exe().map_err(|_| unavailable())?;
    let mut command = Command::new(&executable);
    command
        .arg(ARGUMENT)
        .current_dir(executable.parent().ok_or_else(unavailable)?)
        .env_clear()
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW);
    }
    let start = Instant::now();
    let mut child = command.spawn().map_err(|_| unavailable())?;
    #[cfg(windows)]
    let _job = match launch_limits(&child) {
        Ok(job) => job,
        Err(error) => {
            stop(&mut child);
            return Err(error);
        }
    };

    // The child waits for EOF before it parses. Drain its output independently of input and exit.
    let mut stdin = child.stdin.take().expect("piped PDF stdin");
    let stdout = child.stdout.take().expect("piped PDF stdout");
    let response = thread::scope(|scope| -> Result<Vec<u8>> {
        let writer = scope.spawn(move || stdin.write_all(input));
        let reader = scope.spawn(move || {
            let mut bytes = Vec::new();
            stdout.take((MAX_TEXT + 2) as u64).read_to_end(&mut bytes)?;
            Ok::<_, io::Error>(bytes)
        });
        wait(&mut child, start, checkpoint)?;
        writer
            .join()
            .map_err(|_| unavailable())?
            .map_err(|_| unavailable())?;
        reader
            .join()
            .map_err(|_| unavailable())?
            .map_err(|_| unavailable())
    })?;
    match response.as_slice() {
        [TEXT, body @ ..] if !body.is_empty() && body.len() <= MAX_TEXT => {
            String::from_utf8(body.to_vec()).map_err(|_| unavailable())
        }
        [EMPTY] => Err(Error::Link(
            "NO_EXTRACTABLE_TEXT",
            "This PDF has no extractable text. Enter PDF text manually to retain the attachment.",
        )),
        [LIMIT] => Err(Error::Link(
            "PDF_LIMIT",
            "The PDF exceeds the text extraction limits. Enter PDF text manually or link a smaller file.",
        )),
        [INVALID] => Err(Error::Link(
            "PDF_UNREADABLE",
            "The PDF text layer could not be read. Enter PDF text manually to retain the attachment.",
        )),
        _ => Err(unavailable()),
    }
}

fn stop(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

fn wait(
    child: &mut Child,
    start: Instant,
    checkpoint: &mut dyn FnMut() -> Result<()>,
) -> Result<()> {
    loop {
        if let Err(error) = checkpoint() {
            stop(child);
            return Err(error);
        }
        match child.try_wait() {
            Ok(Some(status)) if status.success() => return Ok(()),
            Ok(Some(_)) => return Err(unavailable()),
            Ok(None) if start.elapsed() < DEADLINE => thread::sleep(Duration::from_millis(10)),
            Ok(None) => {
                stop(child);
                return Err(Error::Link(
                    "PDF_TIMEOUT",
                    "PDF text extraction timed out. Enter PDF text manually or link a smaller file.",
                ));
            }
            Err(_) => {
                stop(child);
                return Err(unavailable());
            }
        }
    }
}

#[cfg(windows)]
fn launch_limits(child: &Child) -> Result<std::os::windows::io::OwnedHandle> {
    use std::{
        mem::size_of_val,
        os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
        ptr::null,
    };
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_ACTIVE_PROCESS,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOB_OBJECT_LIMIT_PROCESS_MEMORY,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
        SetInformationJobObject,
    };
    // Assign the job before the first byte reaches the worker. Closing the last handle kills it.
    let raw = unsafe { CreateJobObjectW(null(), null()) };
    if raw.is_null() {
        return Err(unavailable());
    }
    let job = unsafe { OwnedHandle::from_raw_handle(raw) };
    let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_PROCESS_MEMORY
        | JOB_OBJECT_LIMIT_ACTIVE_PROCESS
        | JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    limits.BasicLimitInformation.ActiveProcessLimit = 1;
    limits.ProcessMemoryLimit = MEMORY_LIMIT;
    if unsafe {
        SetInformationJobObject(
            raw,
            JobObjectExtendedLimitInformation,
            (&raw const limits).cast(),
            size_of_val(&limits) as u32,
        ) == 0
            || AssignProcessToJobObject(raw, child.as_raw_handle()) == 0
    } {
        return Err(unavailable());
    }
    Ok(job)
}

pub fn run() -> io::Result<()> {
    #[cfg(unix)]
    {
        let limits = libc::rlimit {
            rlim_cur: MEMORY_LIMIT as libc::rlim_t,
            rlim_max: MEMORY_LIMIT as libc::rlim_t,
        };
        // This process has not read the document yet. Only its own address-space limit changes.
        if unsafe { libc::setrlimit(libc::RLIMIT_AS, &raw const limits) } != 0 {
            return Err(io::Error::last_os_error());
        }
    }
    let mut bytes = Vec::new();
    io::stdin()
        .lock()
        .take(MAX_PDF_BYTES + 1)
        .read_to_end(&mut bytes)?;
    let mut output = io::stdout().lock();
    match read_text(&bytes) {
        Ok(text) => {
            output.write_all(&[TEXT])?;
            output.write_all(text.as_bytes())?;
        }
        Err(code) => output.write_all(&[code])?,
    }
    output.flush()
}

fn classify(error: lopdf::Error) -> u8 {
    match error {
        lopdf::Error::Decompress(
            DecompressError::MemoryLimitExceeded { .. } | DecompressError::TooManyFilters { .. },
        ) => LIMIT,
        _ => INVALID,
    }
}

fn read_text(bytes: &[u8]) -> std::result::Result<String, u8> {
    if bytes.len() as u64 > MAX_PDF_BYTES {
        return Err(LIMIT);
    }
    let options = LoadOptions {
        strict: true,
        max_decompressed_size: Some(STREAM_LIMIT),
        ..LoadOptions::default()
    };
    let document = Document::load_mem_with_options(bytes, options).map_err(classify)?;
    if document.is_encrypted() {
        return Err(INVALID);
    }
    let pages = document.page_iter().take(PAGE_LIMIT + 1).count();
    if pages > PAGE_LIMIT {
        return Err(LIMIT);
    }
    let mut text = String::new();
    for number in 1..=pages as u32 {
        let mut page = document
            .extract_text_with_limit(&[number], STREAM_LIMIT)
            .map_err(classify)?;
        page.retain(|ch| !ch.is_control() || matches!(ch, '\r' | '\n' | '\t'));
        let page = page.trim();
        if page.is_empty() {
            continue;
        }
        let needs_separator = !text.is_empty();
        if text.len() + page.len() + usize::from(needs_separator) > MAX_TEXT {
            return Err(LIMIT);
        }
        if needs_separator {
            text.push('\n');
        }
        text.push_str(page);
    }
    if text.is_empty() {
        Err(EMPTY)
    } else {
        Ok(text)
    }
}
