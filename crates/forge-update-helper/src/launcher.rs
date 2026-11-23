use std::{
    env,
    io::{self, Read},
    path::Path,
    process::ExitCode,
};

use forge_update_helper::{
    Result, embedded_trust, install, job, manifest::METADATA_LIMIT, read_bounded,
};

fn run() -> Result<()> {
    let executable = env::current_exe()?;
    let root = install::launcher_root(&executable)?;
    let args = env::args_os().skip(1).collect::<Vec<_>>();
    match args.as_slice() {
        [] => job::launch(&root),
        [command] if command == "activate-update" || command == "rollback-update" => {
            let mut input = Vec::new();
            io::stdin().take(64 * 1024 + 1).read_to_end(&mut input)?;
            if input.len() > 64 * 1024 {
                return Err("Update restart request is too large".into());
            }
            let request = serde_json::from_slice(&input)?;
            if command == "activate-update" {
                job::activate(&root, request)
            } else {
                job::rollback_manual(&root, request)
            }
        }
        [command] if command == "status" => {
            println!(
                "{}",
                serde_json::to_string(&install::active_slot(&root)?.0)?
            );
            Ok(())
        }
        [command, manifest, signature, package, rotation @ ..] if command == "install" => {
            let bytes = read_bounded(Path::new(manifest), METADATA_LIMIT)?;
            let signature = read_bounded(Path::new(signature), 64)?;
            let trust = match rotation {
                [] => embedded_trust()?,
                [body, signature] => embedded_trust()?.with_transition(
                    &read_bounded(Path::new(body), METADATA_LIMIT)?,
                    &read_bounded(Path::new(signature), 64)?,
                )?,
                _ => return Err("Expected a transition and its detached signature".into()),
            };
            let verified = trust.release(&bytes, &signature)?;
            let record = install::first_install(&root, &executable, Path::new(package), &verified)?;
            println!("{}", serde_json::to_string(&record)?);
            Ok(())
        }
        [command, directory, manifest, signature, package] if command == "install-at" => {
            let destination = Path::new(directory);
            let verified = embedded_trust()?.read_release(Path::new(manifest), Path::new(signature))?;
            let record = install::wizard_install(destination, &executable, Path::new(package), &verified)?;
            println!("{}", serde_json::to_string(&record)?);
            Ok(())
        }
        [command] if command == "check-uninstall" => {
            if executable.file_name().and_then(|name| name.to_str()) != Some("Forge Launcher.exe") {
                return Err("Use the installed Forge Launcher for this check".into());
            }
            install::check_uninstall(&root)
        }
        [command, directory] if command == "remove-runtime" => {
            install::remove_installation(Path::new(directory), false)
        }
        _ => Err(
            "Use install MANIFEST SIGNATURE ZIP, install-at DIRECTORY MANIFEST SIGNATURE ZIP, status, or run without arguments to launch Forge"
                .into(),
        ),
    }
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("Forge Launcher: {error}");
            ExitCode::FAILURE
        }
    }
}
