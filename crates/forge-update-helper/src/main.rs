use std::{
    env,
    io::{self, Read},
    path::Path,
    process::ExitCode,
};

use forge_update_helper::{
    Result, bundle, discovery, embedded_trust, install::helper_root, job, manifest::METADATA_LIMIT,
    read_bounded,
};

fn run() -> Result<()> {
    let args = env::args_os().skip(1).collect::<Vec<_>>();
    let root = || helper_root(&env::current_exe()?);
    match args.as_slice() {
        [command] if command == "stage-update" => {
            println!("{}", serde_json::to_string(&job::stage(&root()?, stage_request()?)?)?);
            Ok(())
        }
        [command, manifest, signature, package, rest @ ..] if command == "stage-local-update" => {
            let transition = match rest {
                [] => None,
                [transition, signature] => Some((Path::new(transition), Path::new(signature))),
                _ => return Err("Expected a transition and its detached signature".into()),
            };
            let staged = job::stage_local(
                &root()?,
                stage_request()?,
                job::LocalBundle { manifest: Path::new(manifest), signature: Path::new(signature), package: Path::new(package), transition },
            )?;
            println!("{}", serde_json::to_string(&staged)?);
            Ok(())
        }
        [command] if command == "update-status" || command == "check-updates" => {
            let state = discovery::status(&root()?, command == "check-updates")?;
            println!("{}", serde_json::to_string(&state)?);
            Ok(())
        }
        [command, directory] if command == "remove-installation" => {
            forge_update_helper::install::remove_installation(Path::new(directory), true)
        }
        [command, directory, pid] if command == "remove-after-exit" => {
            let pid = pid.to_str().ok_or("Invalid Forge process identifier")?.parse()?;
            forge_update_helper::install::remove_after_exit(Path::new(directory), pid)
        }
        [command, source, output] if command == "pack" => bundle::pack(Path::new(source), Path::new(output)),
        [command, manifest, signature, package, rest @ ..] if command == "verify-release" => {
            let mut trust = embedded_trust()?;
            match rest {
                [] => {}
                [transition, signature] => {
                    trust = trust.with_transition(
                        &read_bounded(Path::new(transition), METADATA_LIMIT)?,
                        &read_bounded(Path::new(signature), 64)?,
                    )?;
                }
                _ => return Err("Expected a transition and its detached signature".into()),
            }
            let manifest = trust.read_release(Path::new(manifest), Path::new(signature))?;
            bundle::verified_file(Path::new(package), &manifest)?;
            println!("{}", serde_json::to_string(manifest.data())?);
            Ok(())
        }
        _ => Err("Use pack SOURCE ZIP, verify-release or stage-local-update MANIFEST SIGNATURE ZIP [TRANSITION TRANSITION-SIGNATURE]".into()),
    }
}

fn stage_request() -> Result<job::StageRequest> {
    let mut bytes = Vec::new();
    io::stdin()
        .take(METADATA_LIMIT as u64 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > METADATA_LIMIT {
        return Err("Update request is too large".into());
    }
    Ok(serde_json::from_slice(&bytes)?)
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("Forge release verification failed: {error}");
            ExitCode::FAILURE
        }
    }
}
