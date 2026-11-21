use std::{io, path::Path};

use crate::{Error, Result};

pub(crate) fn rename_exclusive(source: &Path, destination: &Path) -> Result<()> {
    #[cfg(windows)]
    let result = {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::{MOVEFILE_WRITE_THROUGH, MoveFileExW};
        let wide = |path: &Path| {
            path.as_os_str()
                .encode_wide()
                .chain([0])
                .collect::<Vec<_>>()
        };
        let source = wide(source);
        let destination = wide(destination);
        // Both names are NUL terminated. Without REPLACE_EXISTING, the rename fails if the target exists.
        unsafe {
            MoveFileExW(
                source.as_ptr(),
                destination.as_ptr(),
                MOVEFILE_WRITE_THROUGH,
            ) != 0
        }
    };
    #[cfg(target_os = "linux")]
    let result = {
        use std::{ffi::CString, os::unix::ffi::OsStrExt};
        let c = |path: &Path| {
            CString::new(path.as_os_str().as_bytes())
                .map_err(|_| Error::Invalid("Invalid destination path"))
        };
        let source = c(source)?;
        let destination = c(destination)?;
        // Both paths are out-of-process checked. RENAME_NOREPLACE guarantees an exclusive publication.
        unsafe {
            libc::renameat2(
                libc::AT_FDCWD,
                source.as_ptr(),
                libc::AT_FDCWD,
                destination.as_ptr(),
                libc::RENAME_NOREPLACE,
            ) == 0
        }
    };
    #[cfg(not(any(windows, target_os = "linux")))]
    let result = {
        let _ = (source, destination);
        return Err(Error::Invalid(
            "Exclusive publication requires Windows or Linux",
        ));
    };
    if result {
        return Ok(());
    }
    let error = io::Error::last_os_error();
    if error.kind() == io::ErrorKind::AlreadyExists {
        Err(Error::ExportExists)
    } else {
        Err(error.into())
    }
}
pub(crate) fn available_bytes(path: &Path) -> Result<u64> {
    #[cfg(windows)]
    let available = {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
        let name: Vec<_> = path.as_os_str().encode_wide().chain([0]).collect();
        let mut available = 0;
        // The API reads the NUL-terminated directory path and writes to an initialized u64.
        if unsafe {
            GetDiskFreeSpaceExW(
                name.as_ptr(),
                &mut available,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        } == 0
        {
            return Err(io::Error::last_os_error().into());
        }
        available
    };
    #[cfg(unix)]
    let available = {
        use std::{ffi::CString, mem::MaybeUninit, os::unix::ffi::OsStrExt};
        let path = CString::new(path.as_os_str().as_bytes())
            .map_err(|_| Error::Invalid("Invalid filesystem path"))?;
        let mut info = MaybeUninit::<libc::statvfs>::uninit();
        // On success the system call initializes the entire statvfs record.
        if unsafe { libc::statvfs(path.as_ptr(), info.as_mut_ptr()) } != 0 {
            return Err(io::Error::last_os_error().into());
        }
        let info = unsafe { info.assume_init() };
        (info.f_bavail as u128 * info.f_frsize as u128).min(u64::MAX as u128) as u64
    };
    Ok(available)
}
