use serde::{Deserialize, Serialize};
use url::Url;

use crate::{Content, Error, Result};

pub(crate) const TYPE_ID: &str = "forge.site";

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Site {
    pub reference: Option<Reference>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Reference {
    pub url: String,
    pub title: String,
    pub quote: String,
}

impl Site {
    pub(crate) fn decode(payload: &str) -> Result<Self> {
        if payload.len() > 112 * 1024 {
            return Err(Error::Invalid("Site reference exceeds its size limit"));
        }
        let site: Self =
            serde_json::from_str(payload).map_err(|_| Error::Invalid("Invalid Site payload"))?;
        site.validate()?;
        Ok(site)
    }

    fn validate(&self) -> Result<()> {
        let Some(reference) = &self.reference else {
            return Ok(());
        };
        Self::validate_reference(reference)
    }

    pub(crate) fn validate_reference(reference: &Reference) -> Result<()> {
        if reference.url.len() > 4_096
            || reference.title.len() > 1_024
            || reference.quote.len() > 16 * 1024
            || reference.title.trim().is_empty()
            || reference.title.chars().any(char::is_control)
            || reference
                .quote
                .chars()
                .any(|c| c.is_control() && !matches!(c, '\r' | '\n' | '\t'))
        {
            return Err(Error::Invalid("Invalid Site address, title or quote"));
        }
        let url = Url::parse(&reference.url).map_err(|_| Error::Invalid("Invalid Site URL"))?;
        if url.as_str() != reference.url
            || url.scheme() != "https"
            || !url.has_host()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err(Error::Invalid(
                "Site references require HTTPS without credentials, query or fragment",
            ));
        }
        Ok(())
    }

    pub(crate) fn store(self, content: &mut Content) -> Result<()> {
        let Content::Portal {
            type_id,
            schema_version: 1,
            payload,
            ..
        } = content
        else {
            return Err(Error::Invalid("Only Site cards can store a Site reference"));
        };
        if type_id != TYPE_ID {
            return Err(Error::Invalid("Only Site cards can store a Site reference"));
        }
        self.validate()?;
        *payload = serde_json::to_string(&self)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_portable_site_fields_and_canonical_https_are_accepted() {
        let make = |url| {
            serde_json::json!({ "reference": { "url": url, "title": "Source", "quote": "Лампа\nnotes" } }).to_string()
        };
        let accepted = make("https://example.test:8443/light%20kit");
        assert_eq!(
            Site::decode(&accepted).unwrap().reference.unwrap().quote,
            "Лампа\nnotes"
        );
        for url in [
            "https://example.test/a?token=demo",
            "https://example.test/a#key",
            "https://user@example.test/",
            "https://example.test",
            "http://example.test/",
            "file:///tmp/a",
        ] {
            assert!(Site::decode(&make(url)).is_err(), "{url}");
        }
        assert!(Site::decode(r#"{"reference":null,"cookies":["no"]}"#).is_err());
    }
}
