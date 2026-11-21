use std::io::Cursor;

use moxcms::{
    Chromaticity, CicpColorPrimaries, CicpProfile, ColorPrimaries, ColorProfile, DataColorSpace,
    Layout, MatrixCoefficients, ToneReprCurve, TransferCharacteristics, TransformOptions, XyY,
};
use png::{BitDepth, CodingIndependentCodePoints, ColorType, SourceChromaticities};

use crate::{Error, Result};

pub(crate) enum ColorSource {
    Decoder,
    Icc(Vec<u8>),
    Png(PngColor),
}

pub(crate) enum PngColor {
    Srgb,
    Cicp {
        codes: CodingIndependentCodePoints,
        depth: BitDepth,
    },
    Legacy {
        gamma: Option<f32>,
        chromaticities: Option<SourceChromaticities>,
    },
}

impl PngColor {
    pub(crate) fn read(bytes: &[u8]) -> Result<Self> {
        // The pixel decoder already loads the ICC profile. Here only the other color chunks are needed.
        let mut decoder = png::Decoder::new(Cursor::new(bytes));
        decoder.set_ignore_text_chunk(true);
        decoder.set_ignore_iccp_chunk(true);
        let png = decoder.read_info().map_err(|_| Error::AssetIntegrity)?;
        let info = png.info();
        if let Some(codes) = info.coding_independent_code_points {
            let depth = if info.color_type == ColorType::Indexed {
                BitDepth::Eight
            } else {
                info.bit_depth
            };
            Ok(Self::Cicp { codes, depth })
        } else if info.srgb.is_some() || info.gama_chunk.is_none() && info.chrm_chunk.is_none() {
            Ok(Self::Srgb)
        } else {
            Ok(Self::Legacy {
                gamma: info.gama_chunk.map(|gamma| gamma.into_value()),
                chromaticities: info.chrm_chunk,
            })
        }
    }
}

fn unsupported() -> Error {
    Error::Link(
        "COLOR_PROFILE_UNSUPPORTED",
        "Unable to normalize the image color profile to sRGB",
    )
}

#[derive(Clone, Copy)]
enum CodeRange {
    Full,
    Narrow { black: u16, white: u16 },
}

impl CodeRange {
    fn expand(self, sample: u16) -> u16 {
        match self {
            Self::Full => sample,
            Self::Narrow { black, white } => {
                let offset = u64::from(sample.clamp(black, white) - black);
                let span = u64::from(white - black);
                ((offset * u64::from(u16::MAX) + span / 2) / span) as u16
            }
        }
    }
}

fn png_cicp(
    codes: CodingIndependentCodePoints,
    depth: BitDepth,
) -> Result<(ColorProfile, CodeRange)> {
    if codes.matrix_coefficients != MatrixCoefficients::Identity as u8 {
        return Err(unsupported());
    }
    let color_primaries =
        CicpColorPrimaries::try_from(codes.color_primaries).map_err(|_| unsupported())?;
    let transfer_characteristics =
        TransferCharacteristics::try_from(codes.transfer_function).map_err(|_| unsupported())?;
    if matches!(
        transfer_characteristics,
        TransferCharacteristics::Smpte2084 | TransferCharacteristics::Hlg
    ) {
        return Err(Error::Link(
            "COLOR_PROFILE_UNSUPPORTED",
            "HDR PNG requires tone mapping before Palette analysis",
        ));
    }
    ColorPrimaries::try_from(color_primaries).map_err(|_| unsupported())?;
    ToneReprCurve::try_from(transfer_characteristics).map_err(|_| unsupported())?;
    let range = if codes.is_video_full_range_image {
        CodeRange::Full
    } else {
        let unit = match depth {
            BitDepth::Eight => 257,
            BitDepth::Sixteen => 256,
            _ => return Err(unsupported()),
        };
        CodeRange::Narrow {
            black: 16 * unit,
            white: 235 * unit,
        }
    };
    let mut profile = ColorProfile::new_from_cicp(CicpProfile {
        color_primaries,
        transfer_characteristics,
        matrix_coefficients: MatrixCoefficients::Identity,
        full_range: true,
    });
    // The generated matrix and transfer curve are sufficient. The original range was handled above.
    profile.cicp = None;
    validate_matrix(&profile)?;
    Ok((profile, range))
}

fn legacy_png(
    gamma: Option<f32>,
    chromaticities: Option<SourceChromaticities>,
) -> Result<ColorProfile> {
    let mut profile = ColorProfile::new_srgb();
    profile.cicp = None;
    if let Some(chrm) = chromaticities {
        let white = png_xy(chrm.white)?;
        profile.update_rgb_colorimetry(
            XyY::new(white.x.into(), white.y.into(), 1.0),
            ColorPrimaries {
                red: png_xy(chrm.red)?,
                green: png_xy(chrm.green)?,
                blue: png_xy(chrm.blue)?,
            },
        );
        validate_matrix(&profile)?;
    }
    if let Some(gamma) = gamma {
        if !gamma.is_finite() || gamma <= 0.0 {
            return Err(unsupported());
        }
        // gAMA describes the encoding exponent. ICC TRCs linearize the stored samples.
        let curve = ToneReprCurve::Parametric(vec![gamma.recip()]);
        profile.red_trc = Some(curve.clone());
        profile.green_trc = Some(curve.clone());
        profile.blue_trc = Some(curve);
    }
    Ok(profile)
}

fn png_xy((x, y): (png::ScaledFloat, png::ScaledFloat)) -> Result<Chromaticity> {
    let (x, y) = (x.into_value(), y.into_value());
    // cHRM is stored with five decimal places. Allow for rounding at the chromaticity boundary.
    if (0.0..=1.0).contains(&x) && y > 0.0 && x + y <= 1.000_01 {
        Ok(Chromaticity { x, y })
    } else {
        Err(unsupported())
    }
}

fn validate_matrix(profile: &ColorProfile) -> Result<()> {
    let determinant = profile.rgb_to_xyz_matrix().determinant();
    if determinant.is_some_and(|value| value.is_finite() && value.abs() > 1e-8) {
        Ok(())
    } else {
        Err(unsupported())
    }
}

impl ColorSource {
    pub(crate) fn srgb_samples(&self, samples: &[[u16; 4]]) -> Result<Vec<[u8; 3]>> {
        if samples.is_empty() {
            return Ok(vec![]);
        }
        let (source, range) = match self {
            Self::Decoder | Self::Png(PngColor::Srgb) => {
                return Ok(samples
                    .iter()
                    .map(|pixel| [pixel[0], pixel[1], pixel[2]].map(to_byte))
                    .collect());
            }
            Self::Icc(bytes) => (
                ColorProfile::new_from_slice(bytes).map_err(|_| unsupported())?,
                CodeRange::Full,
            ),
            Self::Png(PngColor::Legacy {
                gamma,
                chromaticities,
            }) => (legacy_png(*gamma, *chromaticities)?, CodeRange::Full),
            Self::Png(PngColor::Cicp { codes, depth }) => png_cicp(*codes, *depth)?,
        };
        let (layout, input) = match source.color_space {
            DataColorSpace::Rgb => (
                Layout::Rgb,
                samples
                    .iter()
                    .flat_map(|pixel| [pixel[0], pixel[1], pixel[2]].map(|v| range.expand(v)))
                    .collect::<Vec<_>>(),
            ),
            DataColorSpace::Gray => (
                Layout::Gray,
                samples.iter().map(|pixel| range.expand(pixel[0])).collect(),
            ),
            _ => return Err(unsupported()),
        };
        let transform = source
            .create_transform_16bit(
                layout,
                &ColorProfile::new_srgb(),
                Layout::Rgb,
                TransformOptions::default(),
            )
            .map_err(|_| unsupported())?;
        let mut output = vec![0u16; samples.len() * 3];
        transform
            .transform(&input, &mut output)
            .map_err(|_| unsupported())?;
        Ok(output
            .chunks_exact(3)
            .map(|rgb| [rgb[0], rgb[1], rgb[2]].map(to_byte))
            .collect())
    }
}

fn to_byte(sample: u16) -> u8 {
    ((u32::from(sample) + 128) / 257) as u8
}
