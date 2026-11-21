use std::io::{Cursor, Read};

use quick_xml::{NsReader, events::Event, name::ResolveResult};

use crate::{Error, Result, research::MAX_TEXT};

pub(super) const MAX_DOCX_BYTES: u64 = 8 * 1024 * 1024;
const MAX_XML: u64 = 8 * 1024 * 1024;
const WORD_NAMESPACES: [&str; 2] = [
    "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
    "http://purl.oclc.org/ooxml/wordprocessingml/main",
];

fn unreadable() -> Error {
    Error::Link("DOCX_UNREADABLE", "The DOCX body text could not be read")
}

fn limit() -> Error {
    Error::Link("DOCX_LIMIT", "The DOCX exceeds the text extraction limits")
}

pub(super) fn docx_text(
    input: &[u8],
    checkpoint: &mut dyn FnMut() -> Result<()>,
) -> Result<String> {
    let mut archive = zip::ZipArchive::new(Cursor::new(input)).map_err(|_| unreadable())?;
    if archive.len() > 4096 {
        return Err(limit());
    }
    let mut member = archive
        .by_name("word/document.xml")
        .map_err(|_| unreadable())?;
    if !member.is_file() || member.is_symlink() || member.size() == 0 {
        return Err(unreadable());
    }
    if member.size() > MAX_XML {
        return Err(limit());
    }
    let expected = member.size();
    let mut xml = Vec::new();
    let mut buffer = [0; 64 * 1024];
    loop {
        checkpoint()?;
        let bytes = member.read(&mut buffer).map_err(|_| unreadable())?;
        if bytes == 0 {
            break;
        }
        if xml.len() as u64 + bytes as u64 > expected {
            return Err(unreadable());
        }
        xml.extend_from_slice(&buffer[..bytes]);
    }
    if xml.len() as u64 != expected {
        return Err(unreadable());
    }
    body_text(&xml, checkpoint)
}

fn body_text(xml: &[u8], checkpoint: &mut dyn FnMut() -> Result<()>) -> Result<String> {
    let mut reader = NsReader::from_reader(xml);
    reader.config_mut().expand_empty_elements = true;
    let mut root = false;
    let mut found_body = false;
    let mut body = false;
    let mut depth = 0usize;
    let mut skipped_depth = None;
    let mut text_depth = None;
    let mut paragraphs = 0usize;
    let mut output = String::new();
    loop {
        checkpoint()?;
        let (ns, event) = reader.read_resolved_event().map_err(|_| unreadable())?;
        let word = matches!(ns, ResolveResult::Bound(namespace) if WORD_NAMESPACES.contains(&namespace.as_ref()));
        match event {
            Event::Start(element) => {
                depth += 1;
                if depth > 256 {
                    return Err(limit());
                }
                let local = element.local_name();
                if depth == 1 {
                    if root || !word || local.as_ref() != "document" {
                        return Err(unreadable());
                    }
                    root = true;
                } else if depth == 2 && word && local.as_ref() == "body" {
                    if found_body {
                        return Err(unreadable());
                    }
                    found_body = true;
                    body = true;
                } else if body && word && skipped_depth.is_none() {
                    match local.as_ref() {
                        "del" | "moveFrom" => skipped_depth = Some(depth),
                        "p" => paragraphs += 1,
                        "t" if paragraphs > 0 => text_depth = Some(depth),
                        "tab" if paragraphs > 0 => output.push('\t'),
                        "br" | "cr" if paragraphs > 0 => output.push('\n'),
                        _ => {}
                    }
                }
            }
            Event::End(element) => {
                if skipped_depth == Some(depth) {
                    skipped_depth = None;
                } else if body && word && skipped_depth.is_none() {
                    match element.local_name().as_ref() {
                        "body" if depth == 2 => body = false,
                        "p" if paragraphs > 0 => {
                            paragraphs -= 1;
                            output.push('\n');
                        }
                        "t" if text_depth == Some(depth) => text_depth = None,
                        _ => {}
                    }
                }
                depth = depth.checked_sub(1).ok_or_else(unreadable)?;
            }
            Event::Text(text) if text_depth == Some(depth) => {
                output.push_str(&text.xml10_content());
            }
            Event::CData(text) if text_depth == Some(depth) => {
                output.push_str(&text.xml10_content());
            }
            Event::GeneralRef(reference) if text_depth == Some(depth) => {
                let character = match reference.as_ref() {
                    "amp" => '&',
                    "lt" => '<',
                    "gt" => '>',
                    "quot" => '"',
                    "apos" => '\'',
                    _ => reference
                        .resolve_char_ref()
                        .map_err(|_| unreadable())?
                        .ok_or_else(unreadable)?,
                };
                if !matches!(character, '\u{9}' | '\u{A}' | '\u{D}' | '\u{20}'..='\u{D7FF}' | '\u{E000}'..='\u{FFFD}' | '\u{10000}'..='\u{10FFFF}')
                {
                    return Err(unreadable());
                }
                output.push(character);
            }
            Event::DocType(_) => return Err(unreadable()),
            Event::Eof => break,
            _ => {}
        }
        if output.len() > MAX_TEXT {
            return Err(limit());
        }
    }
    if depth != 0 || !found_body {
        return Err(unreadable());
    }
    if output.contains('\0') {
        return Err(unreadable());
    }
    if output.trim().is_empty() {
        return Err(Error::Link(
            "NO_EXTRACTABLE_TEXT",
            "This DOCX has no extractable body text",
        ));
    }
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_namespaced_paragraphs_and_skips_removed_text() {
        let xml = br#"<d:document xmlns:d="http://purl.oclc.org/ooxml/wordprocessingml/main" xmlns:n="example"><d:body>
          <d:p><d:r><d:t>Lens &amp; &lt;blue&gt;&#x20;</d:t><d:tab/><d:t>&#x3B1;</d:t><d:br/><d:t><![CDATA[Next & <here>]]></d:t></d:r>
          <d:del><d:r><d:t>deleted</d:t></d:r></d:del><n:t>wrong namespace</n:t></d:p>
          <d:tbl><d:tr><d:tc><d:p><d:r><d:t>Cell</d:t></d:r></d:p></d:tc></d:tr></d:tbl>
        </d:body></d:document>"#;
        assert_eq!(
            body_text(xml, &mut || Ok(())).unwrap(),
            "Lens & <blue> \tα\nNext & <here>\nCell\n"
        );
    }

    #[test]
    fn rejects_incomplete_document_and_bounds_extracted_text() {
        let prefix = r#"<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>"#;
        let suffix = "</w:t></w:r></w:p></w:body></w:document>";
        let incomplete = body_text(prefix.as_bytes(), &mut || Ok(()));
        assert!(matches!(incomplete, Err(Error::Link("DOCX_UNREADABLE", _))));
        let large = format!("{prefix}{}{suffix}", "a".repeat(MAX_TEXT + 1));
        assert!(matches!(
            body_text(large.as_bytes(), &mut || Ok(())),
            Err(Error::Link("DOCX_LIMIT", _))
        ));
    }
}
