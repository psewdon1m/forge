use std::{fs, fs::File, io, path::Path};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{
    Result, directory,
    install::{Active, active_record, stage_slot},
    manifest::{VerifiedManifest, canonical},
    read_bounded, write_new,
};

const RECORD: &str = "reinstall.json";
const DRAFT: &str = "reinstall.part";

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Pending {
    slot: String,
    replacement: Uuid,
}

fn exists(path: &Path) -> Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(_) => {
            directory(path)?;
            Ok(true)
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.into()),
    }
}

fn cleaned(path: &Path) -> Result<()> {
    if exists(path)? {
        fs::remove_dir_all(path)?;
    }
    Ok(())
}

// All recovery and replacement runs with the same exclusive installation lock as updates.
pub(crate) fn recover(root: &Path) -> Result<()> {
    let marker = root.join(RECORD);
    let record = match fs::symlink_metadata(&marker) {
        Ok(_) => read_bounded(&marker, 1024)?,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    let pending: Pending = serde_json::from_slice(&record)?;
    if pending.slot != active_record(root)?.slot
        || pending.replacement.is_nil()
        || pending.replacement.to_string() == pending.slot
    {
        return Err("Invalid Forge reinstall record".into());
    }

    let slots = root.join("slots");
    directory(&slots)?;
    let installed = slots.join(pending.slot);
    let original = slots.join(format!("reinstall-{}.previous", pending.replacement));
    if exists(&original)? {
        if exists(&installed)? {
            // Both directories exist only after the new slot reached its original name.
            cleaned(&original)?;
        } else {
            fs::rename(original, installed)?;
        }
    }
    cleaned(&slots.join(pending.replacement.to_string()))?;
    cleaned(&slots.join(format!("staging-{}", pending.replacement)))?;
    fs::remove_file(marker)?;
    Ok(())
}

pub(crate) fn replace(
    root: &Path,
    active: &Active,
    package: File,
    manifest: &VerifiedManifest,
) -> Result<()> {
    crate::uninstall::check(root)?;
    let slots = root.join("slots");
    let installed = slots.join(&active.slot);
    directory(&installed)?;
    crate::uninstall::reject_projects(&installed)?;

    let pending = Pending {
        slot: active.slot.clone(),
        replacement: Uuid::new_v4(),
    };
    let draft = root.join(DRAFT);
    match fs::remove_file(&draft) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    write_new(&draft, &canonical(&pending)?)?;
    fs::rename(&draft, root.join(RECORD))?;

    let result = (|| -> Result<()> {
        stage_slot(root, package, manifest, pending.replacement, None)?;
        fs::rename(
            &installed,
            slots.join(format!("reinstall-{}.previous", pending.replacement)),
        )?;
        fs::rename(slots.join(pending.replacement.to_string()), installed)?;
        Ok(())
    })();
    recover(root)?;
    result
}
