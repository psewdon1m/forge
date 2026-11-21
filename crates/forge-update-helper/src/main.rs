use std::{
    env,
    io::{self, Read},
    path::Path,
    process::ExitCode,
};

use forge_update_helper::{
    Result, bundle, discovery, embedded_trust, install::per_user_root, job,
    manifest::METADATA_LIMIT, read_bounded,
};

fn run() -> Result<()> {
    let args = env::args_os().skip(1).collect::<Vec<_>>();
    match args.as_slice() {
        [command] if command == "stage-update" => {
            let mut bytes = Vec::new();
            io::stdin().take(64 * 1024 + 1).read_to_end(&mut bytes)?;
            if bytes.len() > 64 * 1024 { return Err("Update request is too large".into()); }
            println!("{}", serde_json::to_string(&job::stage(&per_user_root()?, serde_json::from_slice(&bytes)?)?)?);
            Ok(())
        }
        [command] if command == "update-status" || command == "check-updates" => {
            let state = discovery::status(&per_user_root()?, command == "check-updates")?;
            println!("{}", serde_json::to_string(&state)?);
            Ok(())
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
        _ => Err("Use pack SOURCE ZIP or verify-release MANIFEST SIGNATURE ZIP [TRANSITION TRANSITION-SIGNATURE]".into()),
    }
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
