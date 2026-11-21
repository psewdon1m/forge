use std::{env, fs, os::windows::ffi::OsStrExt, path::PathBuf, ptr::null};

use windows_sys::Win32::{
    Foundation::{E_ABORT, HWND},
    System::Com::{
        COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE, CoInitializeEx, CoUninitialize,
    },
    UI::Shell::{OAIF_EXEC, OPENASINFO, SHOpenWithDialog},
};

pub fn run() -> i32 {
    let mut arguments = env::args_os().skip(2);
    let Some(parent) = arguments
        .next()
        .and_then(|value| value.to_str()?.parse::<usize>().ok())
    else {
        return 1;
    };
    let Some(file) = arguments.next().map(PathBuf::from) else {
        return 1;
    };
    if arguments.next().is_some()
        || parent == 0
        || !file.is_absolute()
        || !matches!(
            file.file_name().and_then(|name| name.to_str()),
            Some("document.pdf" | "document.docx")
        )
        || !fs::symlink_metadata(&file).is_ok_and(|metadata| metadata.is_file())
    {
        return 1;
    }
    let file: Vec<u16> = file
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let options = OPENASINFO {
        pcszFile: file.as_ptr(),
        pcszClass: null(),
        oaifInFlags: OAIF_EXEC,
    };
    let flags = (COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) as u32;
    // The synchronous Shell dialog uses this thread's COM apartment and borrows the UTF-16 path.
    let hr = unsafe {
        if CoInitializeEx(null(), flags) < 0 {
            return 1;
        }
        let hr = SHOpenWithDialog(parent as HWND, &options);
        CoUninitialize();
        hr
    };
    const ERROR_CANCELLED_HRESULT: i32 = 0x8007_04c7_u32 as i32;
    match hr {
        0 => 0,
        E_ABORT | ERROR_CANCELLED_HRESULT => 2,
        _ => 1,
    }
}
