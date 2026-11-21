use std::collections::BTreeMap;

use image::{DynamicImage, GenericImageView, metadata::Cicp};
use serde::{Deserialize, Serialize};

use crate::{Error, Result};

mod color;
pub(crate) use color::{ColorSource, PngColor};

pub const ALGORITHM: &str = "forge.palette.srgb-median-cut.v2";
const MAX_SAMPLES: u64 = 16_384;
const IMAGE_WEIGHT: u64 = 1_000_000_000;
const MAX_BINS: usize = 65_536;

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Swatch {
    pub hex: String,
    pub basis_points: u16,
}

#[derive(Clone, Copy, Default)]
struct Bin {
    weight: u64,
    components: [u64; 3],
}

impl Bin {
    fn add(&mut self, rgb: [u8; 3], weight: u64) {
        self.weight += weight;
        for (sum, channel) in self.components.iter_mut().zip(rgb) {
            *sum += u64::from(channel) * weight;
        }
    }

    fn color(self) -> [u8; 3] {
        self.components
            .map(|sum| ((sum + self.weight / 2) / self.weight) as u8)
    }
}

#[derive(Default)]
pub struct Histogram {
    shift: u32,
    buckets: BTreeMap<[u8; 3], Bin>,
}

impl Histogram {
    fn add(&mut self, rgb: [u8; 3], weight: u64) {
        if weight == 0 {
            return;
        }
        self.buckets
            .entry(rgb.map(|channel| channel >> self.shift))
            .or_default()
            .add(rgb, weight);
        while self.buckets.len() > MAX_BINS {
            self.shift += 1;
            for (key, bin) in std::mem::take(&mut self.buckets) {
                let reduced = self
                    .buckets
                    .entry(key.map(|channel| channel >> 1))
                    .or_default();
                reduced.weight += bin.weight;
                for (sum, part) in reduced.components.iter_mut().zip(bin.components) {
                    *sum += part;
                }
            }
        }
    }

    pub fn colors(self, count: u8) -> Vec<Swatch> {
        let bins = self.buckets;
        if bins.is_empty() {
            return vec![];
        }
        let mut clusters = vec![bins.into_values().collect::<Vec<_>>()];
        while clusters.len() < usize::from(count) {
            let Some((index, axis, _)) = clusters
                .iter()
                .enumerate()
                .filter(|(_, bins)| bins.len() > 1)
                .map(|(index, bins)| {
                    let (axis, span) = widest_channel(bins);
                    (index, axis, u64::from(span) * cluster_weight(bins))
                })
                .max_by_key(|(index, _, score)| (*score, std::cmp::Reverse(*index)))
            else {
                break;
            };
            let bins = &mut clusters[index];
            bins.sort_by_key(|bin| (bin.color()[axis], bin.color()));
            let middle = cluster_weight(bins).div_ceil(2);
            let mut weight = 0;
            let split = bins
                .iter()
                .position(|bin| {
                    weight += bin.weight;
                    weight >= middle
                })
                .expect("nonempty cluster weight")
                + 1;
            let split = split.min(bins.len() - 1);
            let tail = bins.split_off(split);
            clusters.push(tail);
        }
        let mut weights = BTreeMap::new();
        for bins in clusters {
            let mut cluster = Bin::default();
            for bin in bins {
                cluster.weight += bin.weight;
                for (sum, part) in cluster.components.iter_mut().zip(bin.components) {
                    *sum += part;
                }
            }
            *weights.entry(cluster.color()).or_insert(0) += cluster.weight;
        }
        let mut weights: Vec<_> = weights.into_iter().collect();
        weights.sort_by_key(|(rgb, weight)| (std::cmp::Reverse(*weight), *rgb));
        let total: u64 = weights.iter().map(|(_, weight)| weight).sum();
        let mut shares: Vec<_> = weights
            .iter()
            .map(|(_, weight)| (weight * 10_000 / total) as u16)
            .collect();
        let remaining = 10_000 - shares.iter().sum::<u16>();
        let mut remainders: Vec<_> = (0..weights.len()).collect();
        remainders
            .sort_by_key(|&index| (std::cmp::Reverse(weights[index].1 * 10_000 % total), index));
        for index in remainders.into_iter().take(usize::from(remaining)) {
            shares[index] += 1;
        }
        weights
            .into_iter()
            .zip(shares)
            .map(|(([r, g, b], _), basis_points)| Swatch {
                hex: format!("#{r:02X}{g:02X}{b:02X}"),
                basis_points,
            })
            .collect()
    }
}

fn cluster_weight(bins: &[Bin]) -> u64 {
    bins.iter().map(|bin| bin.weight).sum()
}

fn widest_channel(bins: &[Bin]) -> (usize, u8) {
    let mut min = [255; 3];
    let mut max = [0; 3];
    for bin in bins {
        for (index, value) in bin.color().into_iter().enumerate() {
            min[index] = min[index].min(value);
            max[index] = max[index].max(value);
        }
    }
    (0..3)
        .map(|index| (index, max[index] - min[index]))
        .max_by_key(|&(index, span)| (span, std::cmp::Reverse(index)))
        .expect("RGB channels")
}

pub fn image_palette(
    mut image: DynamicImage,
    color: &ColorSource,
    count: u8,
    combined: &mut Histogram,
    checkpoint: &mut impl FnMut() -> Result<()>,
) -> Result<Vec<Swatch>> {
    let unsupported = || {
        Error::Link(
            "COLOR_PROFILE_UNSUPPORTED",
            "Unable to normalize the image color profile to sRGB",
        )
    };
    if matches!(color, ColorSource::Decoder) {
        image
            .apply_color_space(Cicp::SRGB, Default::default())
            .map_err(|_| unsupported())?;
    }
    let width = u64::from(image.width());
    let size = width * u64::from(image.height());
    let sample_count = size.min(MAX_SAMPLES);
    let pixel_at = |i| sample(&image, (i % width) as u32, (i / width) as u32);
    let mut samples = Vec::with_capacity(sample_count as usize);
    for i in 0..sample_count {
        let pixel = pixel_at((2 * i + 1) * size / (2 * sample_count));
        if pixel[3] != 0 {
            samples.push(pixel);
        }
    }
    // Preserve a visible pixel in sparse images whose regular samples all fall on transparency.
    if samples.is_empty() && size > sample_count {
        for i in 0..size {
            if i.is_multiple_of(16_384) {
                checkpoint()?;
            }
            let pixel = pixel_at(i);
            if pixel[3] != 0 {
                samples.push(pixel);
                break;
            }
        }
    }
    let colors = color.srgb_samples(&samples)?;
    checkpoint()?;
    let total_alpha: u64 = samples.iter().map(|p| u64::from(p[3])).sum();
    let mut accumulated = 0;
    let mut previous = 0;
    let mut per_file = Histogram::default();
    for (rgb, sample) in colors.into_iter().zip(samples) {
        let alpha = u64::from(sample[3]);
        accumulated += alpha;
        let weighted = accumulated * IMAGE_WEIGHT / total_alpha;
        combined.add(rgb, weighted - previous);
        previous = weighted;
        per_file.add(rgb, alpha);
    }
    Ok(per_file.colors(count))
}

fn sample(image: &DynamicImage, x: u32, y: u32) -> [u16; 4] {
    match image {
        DynamicImage::ImageRgba16(pixels) => pixels.get_pixel(x, y).0,
        DynamicImage::ImageRgb16(pixels) => {
            let [r, g, b] = pixels.get_pixel(x, y).0;
            [r, g, b, u16::MAX]
        }
        DynamicImage::ImageLumaA16(pixels) => {
            let [luma, alpha] = pixels.get_pixel(x, y).0;
            [luma, luma, luma, alpha]
        }
        DynamicImage::ImageLuma16(pixels) => {
            let [luma] = pixels.get_pixel(x, y).0;
            [luma, luma, luma, u16::MAX]
        }
        _ => image.get_pixel(x, y).0.map(|value| u16::from(value) * 257),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{Rgba, RgbaImage};
    use moxcms::ColorProfile;

    #[test]
    fn normalizes_alpha_and_excludes_fully_transparent_pixels() {
        let image =
            RgbaImage::from_raw(3, 1, vec![255, 0, 0, 255, 0, 0, 255, 51, 0, 255, 0, 0]).unwrap();
        let mut combined = Histogram::default();
        let colors = image_palette(
            image.into(),
            &ColorSource::Decoder,
            4,
            &mut combined,
            &mut || Ok(()),
        )
        .unwrap();
        assert_eq!(
            colors,
            [
                Swatch {
                    hex: "#FF0000".into(),
                    basis_points: 8333
                },
                Swatch {
                    hex: "#0000FF".into(),
                    basis_points: 1667
                },
            ]
        );
        assert_eq!(combined.colors(4), colors);
    }

    #[test]
    fn embedded_wide_gamut_profile_changes_intermediate_srgb_colors() {
        let profile = ColorProfile::new_display_p3().encode().unwrap();
        let image = RgbaImage::from_pixel(1, 1, Rgba([220, 85, 40, 255]));
        let colors = image_palette(
            image.clone().into(),
            &ColorSource::Icc(profile),
            4,
            &mut Histogram::default(),
            &mut || Ok(()),
        )
        .unwrap();
        let original = image_palette(
            image.into(),
            &ColorSource::Decoder,
            4,
            &mut Histogram::default(),
            &mut || Ok(()),
        )
        .unwrap();
        assert_eq!(original[0].hex, "#DC5528");
        assert_eq!(colors[0].basis_points, 10_000);
        assert_ne!(original, colors);
    }

    #[test]
    fn close_but_distinct_swatches_preserve_requested_counts() {
        let pixels: Vec<_> = (0..32).flat_map(|index| [index, 12, 16, 255]).collect();
        let image = RgbaImage::from_raw(32, 1, pixels).unwrap();
        for count in [4, 8, 16] {
            let colors = image_palette(
                image.clone().into(),
                &ColorSource::Decoder,
                count,
                &mut Histogram::default(),
                &mut || Ok(()),
            )
            .unwrap();
            assert_eq!(colors.len(), usize::from(count));
            assert_eq!(
                colors.iter().map(|swatch| swatch.basis_points).sum::<u16>(),
                10_000
            );
        }
    }
}
