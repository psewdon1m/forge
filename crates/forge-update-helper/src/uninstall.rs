use std::{fs, io, io::Read, path::Path, process::Command};

use crate::{Result, reparse_point};

fn project(path: &Path) -> bool {
    fs::symlink_metadata(path.join(".forge")).is_ok()
}

fn project_backup(path: &Path) -> bool {
    if !path
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("zip"))
    {
        return false;
    }
    let Ok(file) = crate::open_regular(path) else {
        return true;
    };
    let Ok(mut zip) = zip::ZipArchive::new(file) else {
        return true;
    };
    let Ok(member) = zip.by_name("manifest.json") else {
        return false;
    };
    let mut bytes = Vec::new();
    if member
        .take(12 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .is_err()
    {
        return true;
    }
    serde_json::from_slice::<serde_json::Value>(&bytes)
        .ok()
        .and_then(|body| {
            body["format"]
                .as_str()
                .map(|value| value.starts_with("forge-") && value.ends_with("-backup"))
        })
        .unwrap_or(true)
}

fn present(path: &Path) -> Result<Option<fs::Metadata>> {
    match fs::symlink_metadata(path) {
        Ok(info) => Ok(Some(info)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

// A project and its contents are kept at their original path, including projects in Forge's own directories.
fn removal_plan(
    path: &Path,
    files: &mut Vec<std::path::PathBuf>,
    directories: &mut Vec<std::path::PathBuf>,
) -> Result<bool> {
    let Some(info) = present(path)? else {
        return Ok(false);
    };
    if reparse_point(&info) || (info.is_dir() && project(path)) {
        return Ok(true);
    }
    if !info.is_dir() {
        if project_backup(path) {
            return Ok(true);
        }
        files.push(path.to_path_buf());
        return Ok(false);
    }
    let mut keep = false;
    for child in fs::read_dir(path)? {
        keep |= removal_plan(&child?.path(), files, directories)?;
    }
    if !keep {
        directories.push(path.to_path_buf())
    }
    Ok(keep)
}

pub(crate) fn reject_projects(root: &Path) -> Result<()> {
    if removal_plan(root, &mut Vec::new(), &mut Vec::new())? {
        return Err("Forge found a project, backup or redirected folder inside the runtime. Use Settings to uninstall and retain it.".into());
    }
    Ok(())
}

pub(crate) fn prepare_full_removal(product: &Path, root: &Path) -> Result<()> {
    if product.ancestors().any(project) {
        return Err(
            "Forge is installed inside a project folder. The project was left untouched.".into(),
        );
    }
    if running(root)? {
        return Err("Close Forge and its update process before uninstalling".into());
    }
    // Resolve both trees completely before changing the installation or its shell registration.
    for directory in [root.to_path_buf(), product.join("Profile")] {
        removal_plan(&directory, &mut Vec::new(), &mut Vec::new())?;
    }
    Ok(())
}

pub(crate) fn remove_files(product: &Path, root: &Path, full: bool) -> Result<()> {
    let uninstaller = product.join("Installer").join("unins000.exe");
    if full && present(&uninstaller)?.is_some() {
        crate::directory(&product.join("Installer"))?;
        drop(crate::open_regular(&uninstaller)?);
        let result = Command::new(uninstaller)
            .args([
                "/VERYSILENT",
                "/SUPPRESSMSGBOXES",
                "/NORESTART",
                "/FORGE_SHELL_ONLY=1",
            ])
            .current_dir(std::env::temp_dir())
            .status()?;
        if !result.success() {
            return Err(
                "Windows could not remove the Forge shortcuts and Installed Apps registration"
                    .into(),
            );
        }
    }
    let mut files = Vec::new();
    let mut directories = Vec::new();
    removal_plan(root, &mut files, &mut directories)?;
    if full {
        removal_plan(&product.join("Profile"), &mut files, &mut directories)?;
    }
    for file in files {
        if let Some(info) = present(&file)?
            && !reparse_point(&info)
            && !info.is_dir()
        {
            #[cfg(windows)]
            clear_readonly(&file, &info)?;
            fs::remove_file(file)?;
        }
    }
    for directory in directories {
        fs::remove_dir(directory)?;
    }
    if fs::read_dir(product)?.next().is_none() {
        fs::remove_dir(product)?;
    }
    Ok(())
}

#[cfg(windows)]
pub(crate) fn after_exit(root: &Path, pid: u32) -> Result<()> {
    use std::io::Write;
    use windows_sys::Win32::{
        Foundation::{CloseHandle, WAIT_OBJECT_0},
        System::Threading::{OpenProcess, PROCESS_SYNCHRONIZE, WaitForSingleObject},
    };

    if pid == 0 || pid == std::process::id() {
        return Err("Invalid Forge process identifier".into());
    }
    crate::install::verified_active(root)?;
    let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
    if handle.is_null() {
        return Err(io::Error::last_os_error().into());
    }
    println!("FORGE_REMOVE_READY");
    let announced = io::stdout().flush();
    let status = unsafe { WaitForSingleObject(handle, 30_000) };
    unsafe { CloseHandle(handle) };
    let outcome = announced.map_err(Into::into).and_then(|_| {
        if status != WAIT_OBJECT_0 {
            return Err("Close Forge and retry the uninstall.".into());
        }
        for _ in 0..20 {
            if !running(root)? {
                return crate::install::remove_installation(root, true);
            }
            std::thread::sleep(std::time::Duration::from_millis(250));
        }
        Err("Close the Forge update process and retry the uninstall.".into())
    });
    if let Err(error) = &outcome {
        notify_failure(&error.to_string());
    }
    let cleanup = remove_worker();
    outcome.and(cleanup)
}

#[cfg(windows)]
fn notify_failure(message: &str) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{MB_ICONERROR, MessageBoxW};
    let text: Vec<_> = message.encode_utf16().chain(Some(0)).collect();
    let title: Vec<_> = "Forge uninstall".encode_utf16().chain(Some(0)).collect();
    unsafe {
        MessageBoxW(
            std::ptr::null_mut(),
            text.as_ptr(),
            title.as_ptr(),
            MB_ICONERROR,
        )
    };
}

#[cfg(windows)]
fn remove_worker() -> Result<()> {
    use std::{os::windows::process::CommandExt, path::PathBuf, process::Stdio};
    use windows_sys::Win32::System::Threading::CREATE_NO_WINDOW;
    let executable = std::env::current_exe()?;
    let parent = executable
        .parent()
        .ok_or("Invalid temporary worker location")?;
    if executable
        .file_name()
        .is_none_or(|name| name != "forge-remover.exe")
        || !parent
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with("forge-remove-"))
    {
        return Err("Invalid temporary worker location".into());
    }
    let system =
        PathBuf::from(std::env::var_os("SystemRoot").ok_or("Windows directory is unavailable")?);
    let cleanup = concat!(
        "$ErrorActionPreference='Stop'; ",
        "$worker=Get-Process -Id ([int]$env:FORGE_REMOVER_PID) -ErrorAction SilentlyContinue; ",
        "if ($worker -and !$worker.WaitForExit(30000)) { exit 1 }; ",
        "[IO.File]::Delete($env:FORGE_REMOVER_PATH); ",
        "[IO.Directory]::Delete([IO.Path]::GetDirectoryName($env:FORGE_REMOVER_PATH), $false)"
    );
    Command::new(system.join("System32/WindowsPowerShell/v1.0/powershell.exe"))
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            cleanup,
        ])
        .env("FORGE_REMOVER_PID", std::process::id().to_string())
        .env("FORGE_REMOVER_PATH", executable)
        .current_dir(std::env::temp_dir())
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()?;
    Ok(())
}

#[cfg(not(windows))]
pub(crate) fn after_exit(_root: &Path, _pid: u32) -> Result<()> {
    Err("Removing Forge requires Windows".into())
}

#[cfg(windows)]
fn clear_readonly(path: &Path, info: &fs::Metadata) -> Result<()> {
    use std::os::windows::{ffi::OsStrExt, fs::MetadataExt};
    use windows_sys::Win32::Storage::FileSystem::{FILE_ATTRIBUTE_READONLY, SetFileAttributesW};

    let attributes = info.file_attributes();
    if attributes & FILE_ATTRIBUTE_READONLY != 0 {
        let name: Vec<_> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        let result =
            unsafe { SetFileAttributesW(name.as_ptr(), attributes & !FILE_ATTRIBUTE_READONLY) };
        if result == 0 {
            return Err(io::Error::last_os_error().into());
        }
    }
    Ok(())
}

pub(crate) fn check(root: &Path) -> Result<()> {
    let mut pending = vec![root.to_path_buf()];
    while let Some(directory) = pending.pop() {
        for entry in fs::read_dir(directory)? {
            let path = entry?.path();
            let info = fs::symlink_metadata(&path)?;
            if reparse_point(&info) {
                return Err("Forge installation contains a reparse point".into());
            }
            if info.is_dir() {
                pending.push(path);
            }
        }
    }
    if running(root)? {
        return Err("Close Forge and its update process before uninstalling".into());
    }
    Ok(())
}

#[cfg(windows)]
fn running(root: &Path) -> Result<bool> {
    use std::mem::size_of;
    use windows_sys::Win32::{
        Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE},
        System::{
            Diagnostics::ToolHelp::{
                CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW,
                TH32CS_SNAPPROCESS,
            },
            Threading::{
                OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, QueryFullProcessImageNameW,
            },
        },
    };

    struct Handle(HANDLE);
    impl Drop for Handle {
        fn drop(&mut self) {
            unsafe { CloseHandle(self.0) };
        }
    }

    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error().into());
    }
    let snapshot = Handle(snapshot);
    let mut entry = PROCESSENTRY32W {
        dwSize: size_of::<PROCESSENTRY32W>() as u32,
        ..Default::default()
    };
    let mut found = unsafe { Process32FirstW(snapshot.0, &mut entry) };
    if found == 0 {
        return Err(io::Error::last_os_error().into());
    }
    let prefix = root.to_string_lossy().replace('/', "\\").to_lowercase() + "\\";
    let mut path = vec![0u16; 32_768];
    while found != 0 {
        let length = entry
            .szExeFile
            .iter()
            .position(|&unit| unit == 0)
            .unwrap_or(entry.szExeFile.len());
        let name = String::from_utf16_lossy(&entry.szExeFile[..length]).to_ascii_lowercase();
        if entry.th32ProcessID != std::process::id()
            && matches!(
                name.as_str(),
                "forge.exe" | "forge launcher.exe" | "forge-update-helper.exe" | "forge-core.exe"
            )
        {
            let process =
                unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, entry.th32ProcessID) };
            if !process.is_null() {
                let process = Handle(process);
                let mut length = path.len() as u32;
                let ok = unsafe {
                    QueryFullProcessImageNameW(process.0, 0, path.as_mut_ptr(), &mut length)
                };
                if ok != 0
                    && String::from_utf16_lossy(&path[..length as usize])
                        .to_lowercase()
                        .starts_with(&prefix)
                {
                    return Ok(true);
                }
            }
        }
        found = unsafe { Process32NextW(snapshot.0, &mut entry) };
    }
    Ok(false)
}

#[cfg(not(windows))]
fn running(_root: &Path) -> Result<bool> {
    Err("Checking running Forge processes requires Windows".into())
}
