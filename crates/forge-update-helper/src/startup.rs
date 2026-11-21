use std::{
    fs, io,
    path::{Path, PathBuf},
    process::Child,
    time::{Duration, Instant},
};

use forge_core::Project;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{Result, install, open_regular, read_bounded, write_new};

const HEALTH_TIMEOUT: Duration = Duration::from_secs(60);
const MARKER_LIMIT: usize = 1024;

#[cfg(windows)]
pub(crate) struct SourceProcess(std::os::windows::io::OwnedHandle);

#[cfg(windows)]
impl SourceProcess {
    pub(crate) fn open(pid: u32, executable: &Path) -> Result<Self> {
        use std::os::windows::{
            ffi::OsStringExt,
            io::{AsRawHandle, FromRawHandle, OwnedHandle},
        };
        use windows_sys::Win32::System::Threading::{
            OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
            QueryFullProcessImageNameW,
        };

        // These rights allow reading the executable path and waiting on this one process.
        let handle = unsafe {
            OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
                0,
                pid,
            )
        };
        if handle.is_null() {
            return Err(io::Error::last_os_error().into());
        }
        // OpenProcess returned a new owned handle, which must be closed even on query failure.
        let handle = unsafe { OwnedHandle::from_raw_handle(handle) };
        let mut image = vec![0; 32_768];
        let mut length = image.len() as u32;
        // image and length are valid writable outputs for this handle.
        if unsafe {
            QueryFullProcessImageNameW(handle.as_raw_handle(), 0, image.as_mut_ptr(), &mut length)
        } == 0
        {
            return Err(io::Error::last_os_error().into());
        }
        let image = PathBuf::from(std::ffi::OsString::from_wide(&image[..length as usize]));
        if fs::canonicalize(image)? != fs::canonicalize(executable)? {
            return Err("The restart request is not from the installed Forge version".into());
        }
        Ok(Self(handle))
    }

    pub(crate) fn wait(self) -> Result<()> {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::{
            Foundation::WAIT_OBJECT_0, System::Threading::WaitForSingleObject,
        };

        // The owned process handle remains valid throughout the wait.
        if unsafe { WaitForSingleObject(self.0.as_raw_handle(), 30_000) } != WAIT_OBJECT_0 {
            return Err("The current Forge process did not exit before the deadline".into());
        }
        Ok(())
    }
}

#[cfg(not(windows))]
pub(crate) struct SourceProcess;

#[cfg(not(windows))]
impl SourceProcess {
    pub(crate) fn open(_: u32, _: &Path) -> Result<Self> {
        Err("Restarting a managed installation requires Windows".into())
    }

    pub(crate) fn wait(self) -> Result<()> {
        Err("Restarting a managed installation requires Windows".into())
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Proof {
    job_id: Uuid,
    nonce: Uuid,
    version: String,
    pid: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Challenge<'a> {
    job_id: Uuid,
    nonce: Uuid,
    version: &'a str,
    directory: &'a Path,
    project_id: Uuid,
    supervisor_pid: u32,
}

struct ProbeProject(PathBuf);

impl Drop for ProbeProject {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

pub(crate) struct Healthy {
    child: Option<Child>,
    nonce: Uuid,
    project: ProbeProject,
}

impl Healthy {
    pub(crate) fn release(mut self) -> Result<()> {
        let child = self
            .child
            .as_mut()
            .ok_or("The startup process is unavailable")?;
        let temporary = self.project.0.join("approval.part");
        let data = self.nonce.to_string();
        write_new(&temporary, data.as_bytes())?;
        fs::rename(temporary, self.project.0.join("approval"))?;
        let acknowledgment = wait_marker(
            child,
            &self.project.0.join("accepted"),
            Duration::from_secs(5),
        )?;
        if acknowledgment != data.as_bytes() {
            return Err("The startup process did not acknowledge approval".into());
        }
        self.child.take();
        Ok(())
    }
}

impl Drop for Healthy {
    fn drop(&mut self) {
        if let Some(child) = &mut self.child {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

fn wait_marker(child: &mut Child, path: &Path, timeout: Duration) -> Result<Vec<u8>> {
    let deadline = Instant::now() + timeout;
    loop {
        match read_bounded(path, MARKER_LIMIT) {
            Ok(bytes) => return Ok(bytes),
            Err(error)
                if error
                    .downcast_ref::<io::Error>()
                    .is_some_and(|error| error.kind() == io::ErrorKind::NotFound) => {}
            Err(error) => return Err(error),
        }
        if let Some(exit) = child.try_wait()? {
            return Err(
                format!("The startup process exited before completing its check: {exit}").into(),
            );
        }
        if Instant::now() >= deadline {
            return Err("Forge exceeded the startup deadline".into());
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

pub(crate) fn check(root: &Path, slot: &Path, job_id: Uuid, version: &str) -> Result<Healthy> {
    let nonce = Uuid::new_v4();
    let directory = root.join(format!("health-{nonce}"));
    fs::create_dir(&directory)?;
    let project = ProbeProject(directory);
    let project_id = Project::create(&project.0, "Forge startup check".into())?
        .view()?
        .space
        .project_id;
    let challenge = Challenge {
        job_id,
        nonce,
        version,
        directory: &project.0,
        project_id,
        supervisor_pid: std::process::id(),
    };
    let _executable = open_regular(&slot.join("Forge.exe"))?;
    let child = install::desktop_command(root, slot)
        .env("FORGE_STARTUP_CHECK", serde_json::to_string(&challenge)?)
        .spawn()?;
    let mut startup = Healthy {
        child: Some(child),
        nonce,
        project,
    };
    let child = startup.child.as_mut().expect("just started");
    let pid = child.id();
    let bytes = wait_marker(child, &startup.project.0.join("ready.json"), HEALTH_TIMEOUT)?;
    let proof: Proof = serde_json::from_slice(&bytes)?;
    if proof.job_id != job_id || proof.version != version || proof.nonce != nonce {
        return Err("The startup proof did not match the job and version".into());
    }
    if proof.pid != pid {
        return Err(format!("Expected startup process {pid}, got {}", proof.pid).into());
    }
    if let Some(exit) = child.try_wait()? {
        return Err(format!("The startup process exited before activation: {exit}").into());
    }
    Ok(startup)
}
