use std::io::{Read, Seek, SeekFrom};

use crate::{AssetFormat, Error, Result};

pub(crate) fn is_video(format: AssetFormat) -> bool {
    matches!(format, AssetFormat::Webm | AssetFormat::Mp4)
}

pub(crate) fn validate(
    input: &mut (impl Read + Seek),
    bytes: u64,
    format: AssetFormat,
) -> Result<()> {
    match format {
        AssetFormat::Webm => {
            let mut prefix = Vec::new();
            input.take(4096).read_to_end(&mut prefix)?;
            if webm_header(&prefix, bytes).is_none() {
                return Err(Error::Invalid("Invalid WebM video container"));
            }
            Ok(())
        }
        AssetFormat::Mp4 => validate_mp4(input, bytes),
        _ => Err(Error::Invalid("Unsupported video format")),
    }
}

fn element_number(bytes: &[u8], is_id: bool) -> Option<(u64, usize)> {
    let first = *bytes.first()?;
    let width = first.leading_zeros() as usize + 1;
    let max = if is_id { 4 } else { 8 };
    if width > max || width > bytes.len() {
        return None;
    }
    let mask = 1 << (8 - width);
    let initial = if is_id { first } else { first - mask };
    let value = bytes[1..width]
        .iter()
        .fold(u64::from(initial), |value, byte| {
            (value << 8) | u64::from(*byte)
        });
    Some((value, width))
}

fn webm_header(prefix: &[u8], file_size: u64) -> Option<()> {
    let body = prefix.strip_prefix(&[0x1a, 0x45, 0xdf, 0xa3])?;
    let (length, width) = element_number(body, false)?;
    let end = width.checked_add(usize::try_from(length).ok()?)?;
    let mut fields = body.get(width..end)?;
    let mut webm = false;
    while !fields.is_empty() {
        let (id, consumed) = element_number(fields, true)?;
        fields = fields.get(consumed..)?;
        let (length, consumed) = element_number(fields, false)?;
        let next = consumed.checked_add(usize::try_from(length).ok()?)?;
        if id == 0x4282 {
            if webm || fields.get(consumed..next)? != b"webm" {
                return None;
            }
            webm = true;
        }
        fields = fields.get(next..)?;
    }
    let segment = body.get(end..)?.strip_prefix(&[0x18, 0x53, 0x80, 0x67])?;
    let (segment_size, segment_width) = element_number(segment, false)?;
    let remaining = file_size.checked_sub((8 + end + segment_width) as u64)?;
    let unknown_size = (1 << (segment_width * 7)) - 1;
    (webm
        && remaining > 0
        && (segment_size == unknown_size || (1..=remaining).contains(&segment_size)))
    .then_some(())
}

fn mp4_error() -> Error {
    Error::Invalid("Invalid MP4 video container")
}

fn validate_mp4(input: &mut (impl Read + Seek), bytes: u64) -> Result<()> {
    let (mut offset, mut header, mut samples, mut boxes) = (0, false, false, 0);
    while offset < bytes {
        boxes += 1;
        if boxes > 4096 || bytes - offset < 8 {
            return Err(mp4_error());
        }
        input.seek(SeekFrom::Start(offset))?;
        let mut box_header = [0; 8];
        input.read_exact(&mut box_header)?;
        let raw_size = u32::from_be_bytes(box_header[..4].try_into().expect("size field"));
        let (size, header_size) = match raw_size {
            0 => (bytes - offset, 8),
            1 => {
                let mut extended = [0; 8];
                input.read_exact(&mut extended).map_err(|_| mp4_error())?;
                (u64::from_be_bytes(extended), 16)
            }
            value => (u64::from(value), 8),
        };
        if size < header_size || size > bytes - offset {
            return Err(mp4_error());
        }
        let kind = &box_header[4..];
        if boxes == 1 && (kind != b"ftyp" || !(8..=4096).contains(&(size - header_size))) {
            return Err(mp4_error());
        }
        match kind {
            b"moov" if size > header_size => header = true,
            b"mdat" if size > header_size => samples = true,
            _ => {}
        }
        offset += size;
    }
    if !header || !samples {
        return Err(mp4_error());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use super::*;

    #[test]
    fn qualifies_container_headers_and_rejects_wrong_or_truncated_inputs() {
        let clips: [(&[u8], AssetFormat); 3] = [
            (
                include_bytes!("../../../tests/fixtures/gallery-video/swatches-vp8.webm"),
                AssetFormat::Webm,
            ),
            (
                include_bytes!("../../../tests/fixtures/gallery-video/swatches-vp9.webm"),
                AssetFormat::Webm,
            ),
            (
                include_bytes!("../../../tests/fixtures/gallery-video/swatches-h264.mp4"),
                AssetFormat::Mp4,
            ),
        ];
        for (clip, format) in clips {
            assert!(validate(&mut Cursor::new(clip), clip.len() as u64, format).is_ok());
            assert!(validate(&mut Cursor::new(&clip[..12]), 12, format).is_err());
            let wrong = if format == AssetFormat::Webm {
                AssetFormat::Mp4
            } else {
                AssetFormat::Webm
            };
            assert!(validate(&mut Cursor::new(clip), clip.len() as u64, wrong).is_err());
        }
    }
}
