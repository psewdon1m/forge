use std::path::Path;

use ed25519_dalek::{Signature, VerifyingKey};
use semver::Version;
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use sha2::{Digest, Sha256};

use crate::{Result, read_bounded};

pub const METADATA_LIMIT: usize = 64 * 1024;
pub const PACKAGE_LIMIT: u64 = 512 * 1024 * 1024;
pub const MIN_WINDOWS_BUILD: u32 = 22_000;
pub const PRODUCT: &str = "forge";
pub const PLATFORM: &str = "windows-x64";
pub const CHANNEL: &str = "stable";
const GITHUB_RELEASES: &str = "https://github.com/psewdon1m/forge/releases/download";
const RELEASE_DOMAIN: &[u8] = b"forge.release.v1\0";
const ROTATION_DOMAIN: &[u8] = b"forge.release-key-transition.v1\0";

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Manifest {
    pub product: String,
    pub schema_version: u32,
    pub platform: String,
    pub channel: String,
    pub version: String,
    pub tag: String,
    pub commit_sha: String,
    pub artifact: Artifact,
    pub compatibility: Compatibility,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data_policy: Option<DataPolicy>,
    pub release_notes: String,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
pub enum DataPolicy {
    #[serde(rename = "no-migration-v1")]
    NoMigrationV1,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Artifact {
    pub url: String,
    pub bytes: u64,
    pub sha256: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Compatibility {
    pub helper_min: String,
    pub helper_max: String,
    pub project_schema_min: u32,
    pub project_schema_max: u32,
    pub minimum_windows_build: u32,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Transition {
    product: String,
    schema_version: u32,
    channel: String,
    next_public_key: String,
    use_next_from: String,
    retire_previous_at: String,
}

pub struct Trust {
    anchor: VerifyingKey,
    transition: Option<KeyWindow>,
}

struct KeyWindow {
    next: VerifyingKey,
    start: Version,
    end: Version,
    evidence: (Vec<u8>, [u8; 64]),
}

pub struct VerifiedManifest {
    data: Manifest,
    version: Version,
    signature: [u8; 64],
    transition: Option<(Vec<u8>, [u8; 64])>,
}

pub fn canonical(value: &impl Serialize) -> Result<Vec<u8>> {
    Ok(serde_json::to_vec(&serde_json::to_value(value)?)?)
}

fn parse_canonical<T: DeserializeOwned + Serialize>(bytes: &[u8]) -> Result<T> {
    if bytes.len() > METADATA_LIMIT {
        return Err("Release metadata exceeds its size limit".into());
    }
    let value: T = serde_json::from_slice(bytes)?;
    if canonical(&value)? != bytes {
        return Err("Release metadata is not canonical JSON".into());
    }
    Ok(value)
}

pub fn lower_hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn key(hex: &str) -> Result<VerifyingKey> {
    if !lower_hex(hex, 64) {
        return Err("Invalid Ed25519 release public key".into());
    }
    let mut bytes = [0; 32];
    for (index, part) in bytes.iter_mut().enumerate() {
        *part = u8::from_str_radix(&hex[index * 2..index * 2 + 2], 16)?;
    }
    let key = VerifyingKey::from_bytes(&bytes)?;
    if key.is_weak() {
        return Err("Weak Ed25519 release public key".into());
    }
    Ok(key)
}

pub fn digest(data: &[u8]) -> String {
    format!("{:x}", Sha256::digest(data))
}

pub fn stable_version(value: &str) -> Result<Version> {
    if value.len() > 32 {
        return Err("Invalid Stable version".into());
    }
    let result = Version::parse(value)?;
    if !result.pre.is_empty() || !result.build.is_empty() {
        return Err("Stable uses release SemVer without prerelease or build suffix".into());
    }
    Ok(result)
}

pub fn file_name(version: &str) -> String {
    format!("forge-{version}-{PLATFORM}.zip")
}

impl Manifest {
    pub fn validate(&self) -> Result<Version> {
        if self.schema_version != 1
            || self.product != PRODUCT
            || self.platform != PLATFORM
            || self.channel != CHANNEL
        {
            return Err("Unsupported release product, schema, platform or channel".into());
        }
        let version = stable_version(&self.version)?;
        if self.tag != format!("forge-v{version}") || !lower_hex(&self.commit_sha, 40) {
            return Err("Release tag or revision does not match the version".into());
        }
        if self.artifact.url
            != format!(
                "{GITHUB_RELEASES}/{}/{}",
                self.tag,
                file_name(&self.version)
            )
        {
            return Err("Artifact URL is not the expected versioned release asset".into());
        }
        if !lower_hex(&self.artifact.sha256, 64)
            || !(1..=PACKAGE_LIMIT).contains(&self.artifact.bytes)
        {
            return Err("Release artifact digest or size is invalid".into());
        }
        let compat = &self.compatibility;
        if stable_version(&compat.helper_min)? > stable_version(&compat.helper_max)?
            || compat.project_schema_min == 0
            || compat.project_schema_min > compat.project_schema_max
            || compat.minimum_windows_build < MIN_WINDOWS_BUILD
        {
            return Err("Release compatibility range is invalid".into());
        }
        if self.release_notes.is_empty()
            || self.release_notes.len() > 16 * 1024
            || self
                .release_notes
                .chars()
                .any(|ch| ch.is_control() && !matches!(ch, '\n' | '\t'))
        {
            return Err("Release notes must be bounded plain text".into());
        }
        Ok(version)
    }
}

impl Trust {
    pub fn new(hex: &str) -> Result<Self> {
        Ok(Self {
            anchor: key(hex)?,
            transition: None,
        })
    }

    pub fn with_transition(mut self, bytes: &[u8], signature: &[u8]) -> Result<Self> {
        if let Some(known) = &self.transition {
            if known.evidence.0 == bytes && known.evidence.1 == signature {
                return Ok(self);
            }
            return Err("A transition is already loaded for this anchor".into());
        }
        let transition: Transition = parse_canonical(bytes)?;
        let signature = Signature::from_slice(signature)?;
        self.anchor
            .verify_strict(&[ROTATION_DOMAIN, bytes].concat(), &signature)?;
        if transition.schema_version != 1
            || transition.product != PRODUCT
            || transition.channel != CHANNEL
        {
            return Err("Unsupported trust transition".into());
        }
        let start = stable_version(&transition.use_next_from)?;
        let end = stable_version(&transition.retire_previous_at)?;
        let next = key(&transition.next_public_key)?;
        if Some(end.patch) != start.patch.checked_add(1)
            || end.major != start.major
            || end.minor != start.minor
            || next == self.anchor
        {
            return Err(
                "Transition must overlap for exactly one Stable patch release and change the key"
                    .into(),
            );
        }
        self.transition = Some(KeyWindow {
            next,
            start,
            end,
            evidence: (bytes.to_vec(), signature.to_bytes()),
        });
        Ok(self)
    }

    pub fn release(&self, bytes: &[u8], sig_bytes: &[u8]) -> Result<VerifiedManifest> {
        let data: Manifest = parse_canonical(bytes)?;
        let version = data.validate()?;
        let body = [RELEASE_DOMAIN, bytes].concat();
        let signature = Signature::from_slice(sig_bytes)?;
        let current_allowed = self
            .transition
            .as_ref()
            .is_none_or(|window| version < window.end);
        let trusted = (current_allowed && self.anchor.verify_strict(&body, &signature).is_ok())
            || self.transition.as_ref().is_some_and(|window| {
                version >= window.start && window.next.verify_strict(&body, &signature).is_ok()
            });
        if !trusted {
            return Err("Release signature does not match the trusted key for this version".into());
        }
        Ok(VerifiedManifest {
            data,
            version,
            signature: signature.to_bytes(),
            transition: self
                .transition
                .as_ref()
                .map(|window| window.evidence.clone()),
        })
    }

    pub fn read_release(&self, manifest: &Path, signature: &Path) -> Result<VerifiedManifest> {
        self.release(
            &read_bounded(manifest, METADATA_LIMIT)?,
            &read_bounded(signature, 64)?,
        )
    }
}

impl VerifiedManifest {
    pub(crate) fn signature(&self) -> &[u8; 64] {
        &self.signature
    }

    pub(crate) fn transition(&self) -> Option<(&[u8], &[u8; 64])> {
        self.transition
            .as_ref()
            .map(|(bytes, sig)| (bytes.as_slice(), sig))
    }

    pub fn data(&self) -> &Manifest {
        &self.data
    }

    pub fn ensure_compatible(
        &self,
        helper: &str,
        project_schema: u32,
        windows_build: u32,
    ) -> Result<()> {
        let helper = stable_version(helper)?;
        let limits = &self.data.compatibility;
        if helper < stable_version(&limits.helper_min)?
            || helper > stable_version(&limits.helper_max)?
            || !(limits.project_schema_min..=limits.project_schema_max).contains(&project_schema)
            || windows_build < limits.minimum_windows_build
        {
            return Err("This version is incompatible with the installed helper, Windows build or project schema".into());
        }
        Ok(())
    }

    pub fn compare_installed(
        &self,
        installed_version: &str,
        installed_sha256: &str,
    ) -> Result<std::cmp::Ordering> {
        use std::cmp::Ordering;
        match self.version.cmp(&stable_version(installed_version)?) {
            Ordering::Less => Err("Stable updates cannot downgrade the installed version".into()),
            Ordering::Equal if installed_sha256 != self.data.artifact.sha256 => {
                Err("An installed version cannot change its package digest".into())
            }
            order => Ok(order),
        }
    }
}
