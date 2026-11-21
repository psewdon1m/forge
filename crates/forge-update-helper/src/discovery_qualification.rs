use std::{env, path::Path};

use ureq::tls::{Certificate, RootCerts, TlsConfig};
use url::Url;

use crate::{Result, manifest::METADATA_LIMIT, read_bounded};

pub(super) struct Channel {
    origin: Url,
    certificate: Certificate<'static>,
}

impl Channel {
    pub(super) fn load() -> Result<Option<Self>> {
        let Some(value) = env::var_os("FORGE_TEST_DISCOVERY_ORIGIN") else {
            return Ok(None);
        };
        let origin = Url::parse(value.to_str().ok_or("Invalid test release origin")?)?;
        if origin.scheme() != "https"
            || origin.host_str() != Some("127.0.0.1")
            || origin.port().is_none()
            || origin.path() != "/"
            || origin.query().is_some()
            || origin.fragment().is_some()
            || !origin.username().is_empty()
            || origin.password().is_some()
        {
            return Err(
                "The qualification channel requires an explicit HTTPS loopback origin".into(),
            );
        }
        let path = env::var_os("FORGE_TEST_DISCOVERY_CA").ok_or("Test release CA is missing")?;
        let certificate = Certificate::from_pem(&read_bounded(Path::new(&path), METADATA_LIMIT)?)?;
        Ok(Some(Self {
            origin,
            certificate,
        }))
    }

    pub(super) fn tls_config(&self) -> TlsConfig {
        TlsConfig::builder()
            .root_certs(RootCerts::new_with_certs(std::slice::from_ref(
                &self.certificate,
            )))
            .build()
    }

    pub(super) fn target(&self, official: &Url) -> Url {
        let mut local = self.origin.clone();
        local.set_path(official.path());
        local.set_query(official.query());
        local
    }
}
