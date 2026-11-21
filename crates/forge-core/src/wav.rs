use crate::{Error, Result, assets::MAX_FILE_BYTES};

const MIN_SAMPLE_RATE: u32 = 8_000;
pub(crate) const MAX_DURATION_MS: u64 = MAX_FILE_BYTES * 1000 / MIN_SAMPLE_RATE as u64;

fn unsupported() -> Error {
    Error::Link(
        "WAV_UNSUPPORTED",
        "Use a mono or stereo PCM WAV file with a readable header",
    )
}

fn uint<const N: usize>(data: &[u8], offset: usize) -> Result<[u8; N]> {
    data.get(offset..offset + N)
        .and_then(|value| value.try_into().ok())
        .ok_or_else(unsupported)
}

fn format(data: &[u8]) -> Result<(u32, u32)> {
    let tag = u16::from_le_bytes(uint(data, 0)?);
    let channels = u32::from(u16::from_le_bytes(uint(data, 2)?));
    let rate = u32::from_le_bytes(uint(data, 4)?);
    let bytes_per_second = u32::from_le_bytes(uint(data, 8)?);
    let block = u32::from(u16::from_le_bytes(uint(data, 12)?));
    let bits = u32::from(u16::from_le_bytes(uint(data, 14)?));
    if tag != 1
        || !matches!(channels, 1 | 2)
        || !(MIN_SAMPLE_RATE..=192_000).contains(&rate)
        || !matches!(bits, 8 | 16 | 24 | 32)
        || block != channels * (bits / 8)
        || bytes_per_second != rate * block
    {
        return Err(unsupported());
    }
    Ok((block, bytes_per_second))
}

pub(crate) fn duration(prefix: &[u8], file_bytes: u64) -> Result<u64> {
    if prefix.get(..4) != Some(b"RIFF") || prefix.get(8..12) != Some(b"WAVE") {
        return Err(unsupported());
    }
    let end = u64::from(u32::from_le_bytes(uint(prefix, 4)?)) + 8;
    if end != file_bytes || end > MAX_FILE_BYTES {
        return Err(unsupported());
    }
    let mut cursor = 12;
    let mut audio = None;
    while cursor + 8 <= prefix.len() {
        let kind = &prefix[cursor..cursor + 4];
        let bytes = u32::from_le_bytes(uint(prefix, cursor + 4)?);
        let start = cursor + 8;
        let next = start as u64 + u64::from(bytes) + u64::from(bytes % 2);
        if next > end {
            return Err(unsupported());
        }
        if kind == b"data" {
            let (block, bytes_per_second) = audio.ok_or_else(unsupported)?;
            let ms = u64::from(bytes) * 1000 / u64::from(bytes_per_second);
            return if bytes % block == 0 && ms > 0 {
                Ok(ms)
            } else {
                Err(unsupported())
            };
        }
        if kind == b"fmt " {
            if audio.is_some() || bytes < 16 {
                return Err(unsupported());
            }
            audio = Some(format(
                prefix.get(start..start + 16).ok_or_else(unsupported)?,
            )?);
        }
        cursor = next as usize;
    }
    Err(unsupported())
}
