use std::{
    cmp::Ordering,
    collections::BTreeMap,
    io::{self, Read},
    path::Path,
    thread,
    time::{Duration, Instant, SystemTime},
};

use forge_core::diagnostics::{UpdateFailureCode, UpdateHttpEndpoint, UpdateHttpFailure};
use semver::Version;
use serde::{Deserialize, Serialize};
use ureq::Agent;
use url::Url;

use crate::{
    Result,
    install::{Active, HELPER_VERSION, PROJECT_SCHEMA, verified_active, windows_build},
    job::{self, JobSummary},
    manifest::{DataPolicy, METADATA_LIMIT, Trust, VerifiedManifest, stable_version},
};

const SOURCE: &str = "https://api.github.com/repos/psewdon1m/forge/releases";
const ASSETS: &str = "https://github.com/psewdon1m/forge/releases/download";
const INDEX_BYTES: usize = 4 * 1024 * 1024;
const PAGE_SIZE: usize = 100;
const MAX_PAGES: usize = 4;
const MANIFEST: &str = "forge-release.json";
const SIGNATURE: &str = "forge-release.sig";
const TRANSITION: &str = "forge-release-key-transition.json";
const TRANSITION_SIG: &str = "forge-release-key-transition.sig";
const ASSET_RETRIES: u32 = 2;
const INITIAL_RETRY_MS: u64 = 250;

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
enum AssetEndpoint {
    #[serde(rename = "github.com")]
    GitHub,
    #[serde(rename = "release-assets.githubusercontent.com")]
    ReleaseAssets,
    #[serde(rename = "objects.githubusercontent.com")]
    Objects,
}

impl AssetEndpoint {
    fn from_host(host: &str) -> Option<Self> {
        match host {
            "github.com" => Some(Self::GitHub),
            "release-assets.githubusercontent.com" => Some(Self::ReleaseAssets),
            "objects.githubusercontent.com" => Some(Self::Objects),
            _ => None,
        }
    }

    fn host(self) -> &'static str {
        match self {
            Self::GitHub => "github.com",
            Self::ReleaseAssets => "release-assets.githubusercontent.com",
            Self::Objects => "objects.githubusercontent.com",
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct AssetHttpFailure {
    status: u16,
    endpoint: AssetEndpoint,
}

impl AssetHttpFailure {
    pub(crate) fn valid(self) -> bool {
        (100..600).contains(&self.status) && self.status != 200
    }

    pub(crate) fn message(self) -> String {
        format!(
            "{} returned HTTP {} while downloading the update package.",
            self.endpoint.host(),
            self.status
        )
    }

    pub(crate) fn diagnostic(self) -> UpdateHttpFailure {
        UpdateHttpFailure {
            status: self.status,
            endpoint: match self.endpoint {
                AssetEndpoint::GitHub => UpdateHttpEndpoint::GitHub,
                AssetEndpoint::ReleaseAssets => UpdateHttpEndpoint::ReleaseAssets,
                AssetEndpoint::Objects => UpdateHttpEndpoint::Objects,
            },
        }
    }
}

pub(crate) enum DownloadFailure {
    Transfer,
    Http(AssetHttpFailure),
}

#[derive(Debug)]
pub(crate) enum Failure {
    Offline,
    Dns,
    Tls,
    Timeout,
    Endpoint,
    IndexHttp(u16),
    AssetHttp(AssetHttpFailure, Option<Duration>),
    InvalidIndex,
    MissingRelease,
    UntrustedRelease,
    VersionConflict,
    SelectionChanged,
    IncompatibleRelease,
    UnsupportedUpdatePolicy,
}

impl Failure {
    fn outcome(self) -> Outcome {
        if matches!(self, Self::Offline) {
            return Outcome::Offline;
        }
        Outcome::Error {
            problem: self.problem(),
        }
    }

    pub(crate) fn problem(self) -> ChannelProblem {
        use UpdateFailureCode as Code;

        let http = match &self {
            Self::IndexHttp(status) => Some(UpdateHttpFailure {
                status: *status,
                endpoint: UpdateHttpEndpoint::GitHubApi,
            }),
            Self::AssetHttp(failure, _) => Some(failure.diagnostic()),
            _ => None,
        };
        let (code, message) = match self {
            Self::Offline => (
                Code::ChannelOffline,
                "The release source could not be reached. Check the connection and retry.".into(),
            ),
            Self::Dns => (
                Code::ChannelDns,
                "Forge could not resolve the Stable channel host. Check DNS and retry.".into(),
            ),
            Self::Tls => (
                Code::ChannelTls,
                "Forge could not verify the Stable channel connection. Check the system clock and connection.".into(),
            ),
            Self::Timeout => (
                Code::ChannelTimeout,
                "The Stable channel took too long to respond. Try again.".into(),
            ),
            Self::Endpoint => (
                Code::ChannelUnavailable,
                "The Stable release channel could not respond safely.".into(),
            ),
            Self::IndexHttp(status) => (
                Code::ChannelIndexHttp,
                format!("api.github.com returned HTTP {status} while reading the Stable release listing."),
            ),
            Self::AssetHttp(failure, _) => (
                Code::ChannelMetadataHttp,
                format!("{} returned HTTP {} while reading signed release metadata.", failure.endpoint.host(), failure.status),
            ),
            Self::InvalidIndex => (
                Code::InvalidIndex,
                "The Stable release listing is incomplete or invalid.".into(),
            ),
            Self::MissingRelease => (
                Code::NoRelease,
                "The Stable channel has no published immutable Forge release.".into(),
            ),
            Self::UntrustedRelease => (
                Code::UntrustedRelease,
                "Forge could not verify the published release and its signature.".into(),
            ),
            Self::VersionConflict => (
                Code::VersionConflict,
                "The published release conflicts with the installed version or digest.".into(),
            ),
            Self::SelectionChanged => (
                Code::SelectionChanged,
                "The Stable candidate changed. Check for updates again.".into(),
            ),
            Self::IncompatibleRelease => (
                Code::IncompatibleRelease,
                "The selected release requires a different Windows, updater or project schema version.".into(),
            ),
            Self::UnsupportedUpdatePolicy => (
                Code::UnsupportedUpdatePolicy,
                "The selected release cannot be installed through Settings. Check the release notes.".into(),
            ),
        };
        ChannelProblem {
            code,
            message,
            http,
        }
    }
}

#[derive(Debug, PartialEq, Serialize)]
pub struct ChannelProblem {
    code: UpdateFailureCode,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    http: Option<UpdateHttpFailure>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    installed_version: String,
    installed_package_sha256: String,
    last_job: Option<JobSummary>,
    #[serde(flatten)]
    outcome: Outcome,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(
    tag = "state",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
enum Outcome {
    Ready,
    UpToDate,
    Available {
        candidate: Candidate,
    },
    Incompatible {
        version: String,
    },
    Offline,
    Error {
        #[serde(flatten)]
        problem: ChannelProblem,
    },
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct Candidate {
    version: String,
    notes: String,
    package_bytes: u64,
    package_sha256: String,
    can_stage: bool,
}

#[derive(Deserialize)]
struct Release {
    tag_name: String,
    draft: bool,
    prerelease: bool,
    #[serde(default)]
    immutable: bool,
    published_at: Option<String>,
    assets: Vec<Asset>,
}

#[derive(Deserialize)]
struct Asset {
    name: String,
    state: String,
}

#[derive(Clone, Copy)]
enum RequestKind {
    Index,
    Asset,
}

trait Source {
    fn get(
        &self,
        url: &str,
        limit: usize,
        kind: RequestKind,
    ) -> std::result::Result<Vec<u8>, Failure>;
}

pub(crate) struct Https {
    agent: Agent,
    timeout: Duration,
    #[cfg(feature = "qualification-discovery")]
    qualification: Option<qualification::Channel>,
}

#[cfg(feature = "qualification-discovery")]
#[path = "discovery_qualification.rs"]
mod qualification;

impl Https {
    pub(crate) fn metadata() -> Result<Self> {
        Self::new(Duration::from_secs(5))
    }

    fn new(timeout: Duration) -> Result<Self> {
        let config = Agent::config_builder()
            .https_only(true)
            .http_status_as_error(false)
            .max_redirects(0)
            .max_redirects_will_error(false)
            .max_response_header_size(32 * 1024)
            .timeout_global(Some(timeout))
            .timeout_per_read(Some(Duration::from_secs(15)));
        #[cfg(feature = "qualification-discovery")]
        let qualification = qualification::Channel::load()?;
        #[cfg(feature = "qualification-discovery")]
        let config = if let Some(channel) = &qualification {
            config.tls_config(channel.tls_config()).proxy(None)
        } else {
            config
        };
        Ok(Self {
            agent: config.build().new_agent(),
            timeout,
            #[cfg(feature = "qualification-discovery")]
            qualification,
        })
    }
}

fn offline(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        io::ErrorKind::ConnectionRefused
            | io::ErrorKind::ConnectionReset
            | io::ErrorKind::ConnectionAborted
            | io::ErrorKind::NetworkUnreachable
            | io::ErrorKind::HostUnreachable
            | io::ErrorKind::NotConnected
    )
}

fn transport_error(error: ureq::Error) -> Failure {
    match error {
        ureq::Error::Timeout(_) => Failure::Timeout,
        ureq::Error::HostNotFound => Failure::Dns,
        ureq::Error::Tls(_) | ureq::Error::Rustls(_) => Failure::Tls,
        ureq::Error::ConnectionFailed => Failure::Offline,
        ureq::Error::Io(error) if error.kind() == io::ErrorKind::TimedOut => Failure::Timeout,
        ureq::Error::Io(error) if error.kind() == io::ErrorKind::InvalidData => Failure::Tls,
        ureq::Error::Io(error) if offline(&error) => Failure::Offline,
        _ => Failure::Endpoint,
    }
}

fn allowed(url: &Url, kind: RequestKind, redirected: bool) -> bool {
    if url.scheme() != "https"
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return false;
    }
    match (kind, redirected) {
        (RequestKind::Index, false) => url.host_str() == Some("api.github.com"),
        (RequestKind::Asset, false) => matches!(
            url.host_str().and_then(AssetEndpoint::from_host),
            Some(AssetEndpoint::GitHub)
        ),
        (RequestKind::Asset, true) => matches!(
            url.host_str().and_then(AssetEndpoint::from_host),
            Some(AssetEndpoint::ReleaseAssets | AssetEndpoint::Objects)
        ),
        (RequestKind::Index, true) => false,
    }
}

impl Https {
    fn response(
        &self,
        url: &str,
        kind: RequestKind,
    ) -> std::result::Result<ureq::http::Response<ureq::Body>, Failure> {
        let deadline = Instant::now() + self.timeout;
        let mut result = self.request(url, kind, deadline);
        for retry in 0..ASSET_RETRIES {
            let Err(Failure::AssetHttp(failure, retry_after)) = result else {
                break;
            };
            if !matches!(failure.status, 502..=504) {
                break;
            }
            let delay = retry_delay(retry, retry_after, uuid::Uuid::new_v4().as_bytes()[0]);
            if delay >= deadline.saturating_duration_since(Instant::now()) {
                break;
            }
            thread::sleep(delay);
            if Instant::now() >= deadline {
                break;
            }
            result = self.request(url, kind, deadline);
        }
        result
    }

    fn request(
        &self,
        url: &str,
        kind: RequestKind,
        deadline: Instant,
    ) -> std::result::Result<ureq::http::Response<ureq::Body>, Failure> {
        let mut destination = Url::parse(url).map_err(|_| Failure::Endpoint)?;
        for redirects in 0..=1 {
            if !allowed(&destination, kind, redirects > 0) {
                return Err(Failure::Endpoint);
            }
            let target = destination.as_str();
            #[cfg(feature = "qualification-discovery")]
            let fixture = self
                .qualification
                .as_ref()
                .map(|channel| channel.target(&destination));
            #[cfg(feature = "qualification-discovery")]
            let target = fixture.as_ref().map_or(target, Url::as_str);
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(Failure::Timeout);
            }
            let mut request = self
                .agent
                .get(target)
                .config()
                .timeout_global(Some(remaining))
                .build()
                .header(
                    "User-Agent",
                    concat!("Forge-Update-Helper/", env!("CARGO_PKG_VERSION")),
                )
                .header("Cache-Control", "no-cache, no-store")
                .header("Pragma", "no-cache");
            request = match kind {
                RequestKind::Index => request
                    .header("Accept", "application/vnd.github+json")
                    .header("X-GitHub-Api-Version", "2026-03-10"),
                RequestKind::Asset => request.header("Accept", "application/octet-stream"),
            };
            let response = request
                .header("Accept-Encoding", "identity")
                .call()
                .map_err(transport_error)?;
            if response.status().is_redirection() {
                let location = response
                    .headers()
                    .get("location")
                    .and_then(|value| value.to_str().ok())
                    .ok_or(Failure::Endpoint)?;
                destination = destination.join(location).map_err(|_| Failure::Endpoint)?;
                continue;
            }
            if response.status().as_u16() != 200 {
                let status = response.status().as_u16();
                if !(100..600).contains(&status) {
                    return Err(Failure::Endpoint);
                }
                if matches!(kind, RequestKind::Index) {
                    return Err(Failure::IndexHttp(status));
                }
                if matches!(kind, RequestKind::Asset)
                    && let Some(endpoint) =
                        destination.host_str().and_then(AssetEndpoint::from_host)
                {
                    let failure = AssetHttpFailure { status, endpoint };
                    let retry_after = response.headers().get("retry-after").and_then(|value| {
                        value
                            .to_str()
                            .ok()
                            .and_then(|value| parse_retry_after(value, SystemTime::now()))
                    });
                    return Err(Failure::AssetHttp(failure, retry_after));
                }
                return Err(Failure::Endpoint);
            }
            return Ok(response);
        }
        Err(Failure::Endpoint)
    }

    pub(crate) fn download(
        manifest: &VerifiedManifest,
        output: &mut std::fs::File,
    ) -> std::result::Result<(), DownloadFailure> {
        let artifact = &manifest.data().artifact;
        let client = Self::new(Duration::from_secs(300)).map_err(|_| DownloadFailure::Transfer)?;
        let response = client
            .response(&artifact.url, RequestKind::Asset)
            .map_err(|error| match error {
                Failure::AssetHttp(failure, _) => DownloadFailure::Http(failure),
                _ => DownloadFailure::Transfer,
            })?;
        Self::write_download(response, artifact.bytes, output)
            .map_err(|_| DownloadFailure::Transfer)
    }

    fn write_download(
        mut response: ureq::http::Response<ureq::Body>,
        bytes: u64,
        output: &mut std::fs::File,
    ) -> Result<()> {
        if response
            .headers()
            .get("content-length")
            .is_some_and(|value| {
                value
                    .to_str()
                    .ok()
                    .and_then(|value| value.parse::<u64>().ok())
                    != Some(bytes)
            })
        {
            return Err("The server size differs from the signed package size".into());
        }
        let written = io::copy(&mut response.body_mut().as_reader().take(bytes + 1), output)?;
        if written != bytes {
            return Err("The downloaded size differs from the signed package size".into());
        }
        output.sync_all()?;
        Ok(())
    }
}

fn parse_retry_after(value: &str, now: SystemTime) -> Option<Duration> {
    let value = value.trim();
    if !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit()) {
        return Some(Duration::from_secs(value.parse().unwrap_or(u64::MAX)));
    }
    httpdate::parse_http_date(value)
        .ok()
        .map(|time| time.duration_since(now).unwrap_or(Duration::ZERO))
}

fn retry_delay(attempt: u32, retry_after: Option<Duration>, jitter: u8) -> Duration {
    let base = INITIAL_RETRY_MS << attempt;
    let delay = Duration::from_millis(base + base / 2 * u64::from(jitter) / 255);
    delay.max(retry_after.unwrap_or(Duration::ZERO))
}

impl Source for Https {
    fn get(
        &self,
        url: &str,
        limit: usize,
        kind: RequestKind,
    ) -> std::result::Result<Vec<u8>, Failure> {
        let mut bytes = Vec::new();
        self.response(url, kind)?
            .body_mut()
            .as_reader()
            .take((limit + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|error| match error.kind() {
                io::ErrorKind::TimedOut => Failure::Timeout,
                _ if offline(&error) => Failure::Offline,
                _ => Failure::Endpoint,
            })?;
        if bytes.len() > limit {
            return Err(Failure::Endpoint);
        }
        Ok(bytes)
    }
}

impl Release {
    fn has(&self, name: &str) -> std::result::Result<bool, Failure> {
        let mut entries = self.assets.iter().filter(|entry| entry.name == name);
        let first = entries.next();
        if entries.next().is_some() || first.is_some_and(|asset| asset.state != "uploaded") {
            return Err(Failure::InvalidIndex);
        }
        Ok(first.is_some())
    }

    fn asset(
        &self,
        source: &impl Source,
        name: &str,
        max: usize,
    ) -> std::result::Result<Vec<u8>, Failure> {
        if !self.has(name)? {
            return Err(Failure::UntrustedRelease);
        }
        source.get(
            &format!("{ASSETS}/{}/{name}", self.tag_name),
            max,
            RequestKind::Asset,
        )
    }

    fn eligible_version(&self) -> Option<Version> {
        if self.draft || self.prerelease || !self.immutable || self.published_at.is_none() {
            return None;
        }
        stable_version(self.tag_name.strip_prefix("forge-v")?).ok()
    }
}

fn newest(source: &impl Source) -> std::result::Result<Release, Failure> {
    let mut candidates = BTreeMap::new();
    for page in 1..=MAX_PAGES {
        let bytes = source.get(
            &format!("{SOURCE}?per_page={PAGE_SIZE}&page={page}"),
            INDEX_BYTES,
            RequestKind::Index,
        )?;
        let listed: Vec<Release> =
            serde_json::from_slice(&bytes).map_err(|_| Failure::InvalidIndex)?;
        let length = listed.len();
        if length > PAGE_SIZE {
            return Err(Failure::InvalidIndex);
        }
        for release in listed {
            if let Some(version) = release.eligible_version()
                && candidates.insert(version, release).is_some()
            {
                return Err(Failure::InvalidIndex);
            }
        }
        if length < PAGE_SIZE {
            return candidates
                .pop_last()
                .map(|(_, release)| release)
                .ok_or(Failure::MissingRelease);
        }
    }
    Err(Failure::InvalidIndex)
}

fn fetch_manifest(
    source: &impl Source,
    mut trust: Trust,
) -> std::result::Result<VerifiedManifest, Failure> {
    let release = newest(source)?;
    match (release.has(TRANSITION)?, release.has(TRANSITION_SIG)?) {
        (false, false) => {}
        (true, true) => {
            trust = trust
                .with_transition(
                    &release.asset(source, TRANSITION, METADATA_LIMIT)?,
                    &release.asset(source, TRANSITION_SIG, 64)?,
                )
                .map_err(|_| Failure::UntrustedRelease)?;
        }
        _ => return Err(Failure::UntrustedRelease),
    }
    let signed = trust
        .release(
            &release.asset(source, MANIFEST, METADATA_LIMIT)?,
            &release.asset(source, SIGNATURE, 64)?,
        )
        .map_err(|_| Failure::UntrustedRelease)?;
    let candidate = signed.data();
    if candidate.tag != release.tag_name
        || !release.has(&crate::manifest::file_name(&candidate.version))?
    {
        return Err(Failure::UntrustedRelease);
    }
    Ok(signed)
}

fn resolve(
    source: &impl Source,
    trust: Trust,
    installed: &str,
    installed_sha256: &str,
    build: u32,
) -> std::result::Result<Outcome, Failure> {
    let signed = fetch_manifest(source, trust)?;
    let candidate = signed.data();
    match signed
        .compare_installed(installed, installed_sha256)
        .map_err(|_| Failure::VersionConflict)?
    {
        Ordering::Equal => Ok(Outcome::UpToDate),
        Ordering::Greater
            if signed
                .ensure_compatible(HELPER_VERSION, PROJECT_SCHEMA, build)
                .is_err() =>
        {
            Ok(Outcome::Incompatible {
                version: candidate.version.clone(),
            })
        }
        Ordering::Greater => Ok(Outcome::Available {
            candidate: Candidate {
                version: candidate.version.clone(),
                notes: candidate.release_notes.clone(),
                package_bytes: candidate.artifact.bytes,
                package_sha256: candidate.artifact.sha256.clone(),
                can_stage: candidate.data_policy == Some(DataPolicy::NoMigrationV1),
            },
        }),
        Ordering::Less => Err(Failure::VersionConflict),
    }
}

pub(crate) fn verified_helper(root: &Path) -> Result<(Active, Trust)> {
    let (installed, slot, trust) = verified_active(root)?;
    if std::fs::canonicalize(std::env::current_exe()?)?
        != std::fs::canonicalize(slot.join("forge-update-helper.exe"))?
    {
        return Err("The updater must run from the verified active Forge slot".into());
    }
    Ok((installed, trust))
}

pub(crate) fn staging_manifest(
    trust: Trust,
    installed: &Active,
    version: &str,
    sha256: &str,
) -> std::result::Result<VerifiedManifest, Failure> {
    let signed = fetch_manifest(&Https::metadata().map_err(|_| Failure::Endpoint)?, trust)?;
    let candidate = signed.data();
    if candidate.version != version
        || candidate.artifact.sha256 != sha256
        || signed
            .compare_installed(&installed.version, &installed.package_sha256)
            .map_err(|_| Failure::SelectionChanged)?
            != Ordering::Greater
    {
        return Err(Failure::SelectionChanged);
    }
    let build = windows_build().map_err(|_| Failure::IncompatibleRelease)?;
    signed
        .ensure_compatible(HELPER_VERSION, PROJECT_SCHEMA, build)
        .map_err(|_| Failure::IncompatibleRelease)?;
    if candidate.data_policy != Some(DataPolicy::NoMigrationV1) {
        return Err(Failure::UnsupportedUpdatePolicy);
    }
    Ok(signed)
}

pub fn status(root: &Path, check: bool) -> Result<Status> {
    let (installed, trust) = verified_helper(root)?;
    let outcome = if check {
        resolve(
            &Https::metadata()?,
            trust,
            &installed.version,
            &installed.package_sha256,
            windows_build()?,
        )
        .unwrap_or_else(Failure::outcome)
    } else {
        Outcome::Ready
    };
    let last_job = job::summary(root, &installed)?;
    Ok(Status {
        installed_version: installed.version,
        installed_package_sha256: installed.package_sha256,
        last_job,
        outcome,
    })
}

#[cfg(test)]
mod tests {
    use std::{cell::RefCell, collections::HashMap};

    use ed25519_dalek::{Signer, SigningKey};
    use serde_json::json;

    use crate::manifest::{
        Artifact, CHANNEL, Compatibility, Manifest, PLATFORM, PRODUCT, canonical, file_name,
    };

    use super::*;

    const INSTALLED: &str = "0.0.2";
    const NEWEST: &str = "0.0.10";
    const BUILD: u32 = 22_000;
    const SHA: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    #[test]
    fn discovery_failures_distinguish_network_reason_and_safe_http_status() {
        let failures = [
            (
                transport_error(ureq::Error::HostNotFound),
                "channelDns",
                "resolve",
            ),
            (
                transport_error(ureq::Error::Tls("private certificate diagnostic")),
                "channelTls",
                "verify",
            ),
            (
                transport_error(ureq::Error::Io(io::ErrorKind::TimedOut.into())),
                "channelTimeout",
                "too long",
            ),
            (
                Failure::IndexHttp(401),
                "channelIndexHttp",
                "api.github.com returned HTTP 401",
            ),
            (
                Failure::IndexHttp(404),
                "channelIndexHttp",
                "api.github.com returned HTTP 404",
            ),
            (
                Failure::AssetHttp(
                    AssetHttpFailure {
                        status: 503,
                        endpoint: AssetEndpoint::ReleaseAssets,
                    },
                    None,
                ),
                "channelMetadataHttp",
                "release-assets.githubusercontent.com returned HTTP 503",
            ),
        ];
        for (failure, code, detail) in failures {
            let json = serde_json::to_value(failure.outcome()).unwrap();
            assert_eq!(json["state"], "error");
            assert_eq!(json["code"], code);
            assert!(json["message"].as_str().unwrap().contains(detail));
            assert!(!json.to_string().contains("private certificate diagnostic"));
        }
        assert_eq!(
            transport_error(ureq::Error::ConnectionFailed).outcome(),
            Outcome::Offline
        );
    }

    #[test]
    fn retry_after_accepts_http_date_and_uses_the_larger_of_the_server_wait_and_backoff() {
        let now = httpdate::parse_http_date("Wed, 21 Oct 2015 07:28:00 GMT").unwrap();
        assert_eq!(parse_retry_after("60", now), Some(Duration::from_secs(60)));
        assert_eq!(
            parse_retry_after("Wed, 21 Oct 2015 07:28:12 GMT", now),
            Some(Duration::from_secs(12))
        );
        assert_eq!(
            parse_retry_after("Wed, 21 Oct 2015 07:27:00 GMT", now),
            Some(Duration::ZERO)
        );
        assert_eq!(parse_retry_after("invalid", now), None);
        assert_eq!(
            parse_retry_after("999999999999999999999999999999", now),
            Some(Duration::from_secs(u64::MAX))
        );
        assert_eq!(retry_delay(0, None, 0), Duration::from_millis(250));
        assert_eq!(retry_delay(1, None, 255), Duration::from_millis(750));
        assert_eq!(
            retry_delay(0, Some(Duration::from_secs(1)), 255),
            Duration::from_secs(1)
        );
    }

    #[derive(Default)]
    struct Fixture {
        bytes: HashMap<String, Vec<u8>>,
        requests: RefCell<Vec<String>>,
    }

    impl Source for Fixture {
        fn get(
            &self,
            url: &str,
            limit: usize,
            _kind: RequestKind,
        ) -> std::result::Result<Vec<u8>, Failure> {
            self.requests.borrow_mut().push(url.into());
            let bytes = self.bytes.get(url).ok_or(Failure::Offline)?;
            if bytes.len() > limit {
                return Err(Failure::Endpoint);
            }
            Ok(bytes.clone())
        }
    }

    fn signing_key() -> SigningKey {
        SigningKey::from_bytes(&[9_u8; 32])
    }

    fn trust() -> Trust {
        let hex = signing_key()
            .verifying_key()
            .to_bytes()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        Trust::new(&hex).unwrap()
    }

    fn asset_url(version: &str, file: &str) -> String {
        format!("{ASSETS}/forge-v{version}/{file}")
    }

    fn listed(version: &str) -> serde_json::Value {
        let assets = [MANIFEST, SIGNATURE, &file_name(version)].map(|name| {
            json!({"name": name, "state": "uploaded", "browser_download_url": "https://untrusted.example/secret"})
        });
        json!({
            "tag_name": format!("forge-v{version}"), "draft": false, "prerelease": false, "immutable": true,
            "published_at": "2026-01-01T00:00:00Z",
            "assets": assets,
        })
    }

    fn published(version: &str) -> Manifest {
        Manifest {
            product: PRODUCT.into(),
            platform: PLATFORM.into(),
            channel: CHANNEL.into(),
            schema_version: 1,
            data_policy: Some(DataPolicy::NoMigrationV1),
            version: version.into(),
            tag: format!("forge-v{version}"),
            commit_sha: "e".repeat(40),
            artifact: Artifact {
                url: asset_url(version, &file_name(version)),
                bytes: 150_000,
                sha256: SHA.into(),
            },
            compatibility: Compatibility {
                helper_min: "0.0.1".into(),
                helper_max: "0.0.10".into(),
                minimum_windows_build: BUILD,
                project_schema_min: 1,
                project_schema_max: 1,
            },
            release_notes: "Signed sample notes.".into(),
        }
    }

    impl Fixture {
        fn page(&mut self, page: usize, releases: &[serde_json::Value]) {
            self.bytes.insert(
                format!("{SOURCE}?per_page={PAGE_SIZE}&page={page}"),
                serde_json::to_vec(releases).unwrap(),
            );
        }

        fn signed(&mut self, version: &str, manifest: &Manifest) {
            let body = canonical(manifest).unwrap();
            let signature = signing_key()
                .sign(&[b"forge.release.v1\0", body.as_slice()].concat())
                .to_bytes();
            self.bytes.insert(asset_url(version, MANIFEST), body);
            self.bytes
                .insert(asset_url(version, SIGNATURE), signature.to_vec());
        }

        fn check(&self) -> std::result::Result<Outcome, Failure> {
            resolve(self, trust(), INSTALLED, SHA, BUILD)
        }
    }

    #[test]
    fn selects_newest_semver_across_pages_and_authenticates_notes() {
        let mut source = Fixture::default();
        let mut draft = listed("0.0.999");
        draft["draft"] = true.into();
        let mut mutable = listed("0.0.42");
        mutable["immutable"] = false.into();
        let mut prerelease = listed("0.0.52");
        prerelease["prerelease"] = true.into();
        let mut page = vec![draft, mutable, prerelease, listed("0.0.9")];
        page.resize(PAGE_SIZE, listed("0.0.10-alpha"));
        source.page(1, &page);
        source.page(2, &[listed(NEWEST), listed(INSTALLED)]);
        source.signed(NEWEST, &published(NEWEST));
        let Outcome::Available { candidate } = source.check().unwrap() else {
            panic!("Expected a verified update")
        };
        assert_eq!(candidate.version, NEWEST);
        assert_eq!(candidate.notes, "Signed sample notes.");
        assert_eq!(candidate.package_sha256, SHA);
        assert_eq!(
            *source.requests.borrow(),
            [
                format!("{SOURCE}?per_page=100&page=1"),
                format!("{SOURCE}?per_page=100&page=2"),
                asset_url(NEWEST, MANIFEST),
                asset_url(NEWEST, SIGNATURE),
            ]
        );
    }

    #[test]
    fn reports_exact_installed_digest_and_rejects_replacement_and_downgrade() {
        let mut source = Fixture::default();
        source.page(1, &[listed(INSTALLED)]);
        let mut manifest = published(INSTALLED);
        source.signed(INSTALLED, &manifest);
        assert_eq!(source.check().unwrap(), Outcome::UpToDate);
        manifest.artifact.sha256 = "b".repeat(64);
        source.signed(INSTALLED, &manifest);
        assert!(matches!(source.check(), Err(Failure::VersionConflict)));
        source.page(1, &[listed("0.0.1")]);
        source.signed("0.0.1", &published("0.0.1"));
        assert!(matches!(source.check(), Err(Failure::VersionConflict)));
    }

    #[test]
    fn public_prerelease_is_ineligible_until_promoted_with_the_same_assets() {
        let mut source = Fixture::default();
        let mut staging = listed(NEWEST);
        staging["prerelease"] = true.into();
        source.page(1, &[staging.clone()]);
        source.signed(NEWEST, &published(NEWEST));
        assert!(matches!(source.check(), Err(Failure::MissingRelease)));
        assert_eq!(source.requests.borrow().len(), 1);
        staging["prerelease"] = false.into();
        source.page(1, &[staging]);
        let Outcome::Available { candidate } = source.check().unwrap() else {
            panic!("Expected a verified update after release promotion");
        };
        assert_eq!(candidate.version, NEWEST);
        assert_eq!(candidate.package_sha256, SHA);
    }

    #[test]
    fn differentiates_offline_empty_invalid_incompatible_and_untrusted() {
        let mut source = Fixture::default();
        assert!(matches!(source.check(), Err(Failure::Offline)));
        source.page(1, &[]);
        assert!(matches!(source.check(), Err(Failure::MissingRelease)));
        source.page(1, &[listed(NEWEST), listed(NEWEST)]);
        assert!(matches!(source.check(), Err(Failure::InvalidIndex)));
        source.page(1, &[listed(NEWEST)]);
        let mut candidate = published(NEWEST);
        candidate.compatibility.minimum_windows_build = BUILD + 1;
        source.signed(NEWEST, &candidate);
        assert_eq!(
            source.check().unwrap(),
            Outcome::Incompatible {
                version: NEWEST.into()
            }
        );
        source.bytes.get_mut(&asset_url(NEWEST, SIGNATURE)).unwrap()[0] ^= 1;
        assert!(matches!(source.check(), Err(Failure::UntrustedRelease)));
        source.signed(NEWEST, &published("0.0.9"));
        assert!(matches!(source.check(), Err(Failure::UntrustedRelease)));
        let mut listing = listed(NEWEST);
        listing["assets"]
            .as_array_mut()
            .unwrap()
            .push(json!({"name": TRANSITION, "state": "uploaded"}));
        source.page(1, &[listing]);
        assert!(matches!(source.check(), Err(Failure::UntrustedRelease)));
    }

    #[test]
    fn accepts_one_https_asset_redirect_to_the_release_cdn() {
        for (url, kind, redirected, expected) in [
            (SOURCE, RequestKind::Index, false, true),
            (SOURCE, RequestKind::Index, true, false),
            (
                "https://release-assets.githubusercontent.com/files/1?signature=synthetic",
                RequestKind::Asset,
                true,
                true,
            ),
            (
                "https://release-assets.githubusercontent.com.evil.test/",
                RequestKind::Asset,
                true,
                false,
            ),
            (
                "http://objects.githubusercontent.com/file",
                RequestKind::Asset,
                true,
                false,
            ),
            (
                "https://objects.githubusercontent.com:8443/file",
                RequestKind::Asset,
                true,
                false,
            ),
            (
                "https://user@objects.githubusercontent.com/file",
                RequestKind::Asset,
                true,
                false,
            ),
        ] {
            assert_eq!(
                allowed(&Url::parse(url).unwrap(), kind, redirected),
                expected
            );
        }
    }
}
