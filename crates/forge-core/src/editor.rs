use std::{collections::HashSet, io::Cursor};

use image::{
    DynamicImage, ExtendedColorType, ImageDecoder, ImageEncoder, Rgba, RgbaImage,
    codecs::{jpeg::JpegEncoder, png::PngEncoder},
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{
    AssetFormat, AssetRef, Content, Error, Result, assets::image_reader, data_links::is_image,
};

pub(crate) const TYPE_ID: &str = "forge.editor";
pub(crate) const MAX_INPUT_BYTES: u64 = 48 * 1024 * 1024;
const MAX_EDGE: u32 = 8192;
const MAX_PIXELS: u64 = 12_000_000;
const MAX_NODES: usize = 12;
pub(crate) const MAX_EXPORTS: usize = 32;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Selection {
    pub(crate) link_id: Uuid,
    pub(crate) source_revision: String,
    pub(crate) version_id: Uuid,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Graph {
    pub(crate) nodes: Vec<Step>,
    pub(crate) output: Option<Uuid>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Step {
    id: Uuid,
    input: Option<Uuid>,
    operation: Operation,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum Operation {
    Crop {
        x: u32,
        y: u32,
        width: u32,
        height: u32,
    },
    Resize {
        width: u32,
        height: u32,
    },
    Exposure {
        quarter_stops: i8,
    },
    Color {
        red: u16,
        green: u16,
        blue: u16,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Recipe {
    pub(crate) source: AssetRef,
    pub(crate) graph: Graph,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Export {
    pub(crate) asset: AssetRef,
    pub(crate) recipe: Recipe,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Document {
    pub(crate) recipe: Option<Recipe>,
    pub(crate) exports: Vec<Export>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum OutputFormat {
    Png,
    Jpeg,
}

impl OutputFormat {
    pub(crate) fn format(self) -> AssetFormat {
        match self {
            Self::Png => AssetFormat::Png,
            Self::Jpeg => AssetFormat::Jpeg,
        }
    }
}

fn invalid_graph() -> Error {
    Error::Link(
        "EDITOR_GRAPH",
        "Connect all processing nodes in one path from Input to Output",
    )
}

fn dimensions(width: u32, height: u32) -> Result<()> {
    if width == 0
        || height == 0
        || width > MAX_EDGE
        || height > MAX_EDGE
        || u64::from(width) * u64::from(height) > MAX_PIXELS
    {
        return Err(Error::Link(
            "EDITOR_SIZE",
            "Editor supports up to 8192 pixels per edge and 12 million pixels",
        ));
    }
    Ok(())
}

impl Graph {
    fn ordered(&self) -> Result<Vec<Operation>> {
        if self.nodes.len() > MAX_NODES {
            return Err(Error::Link(
                "EDITOR_GRAPH",
                "An Editor recipe supports up to 12 processing nodes",
            ));
        }
        let mut ids = HashSet::new();
        if self
            .nodes
            .iter()
            .any(|node| node.id.is_nil() || !ids.insert(node.id))
        {
            return Err(invalid_graph());
        }
        let mut visited = HashSet::new();
        let mut ordered = Vec::new();
        let mut current = self.output;
        while let Some(id) = current {
            let node = self
                .nodes
                .iter()
                .find(|node| node.id == id)
                .ok_or_else(invalid_graph)?;
            if !visited.insert(id) {
                return Err(invalid_graph());
            }
            node.operation.validate()?;
            ordered.push(node.operation);
            current = node.input;
        }
        if ordered.len() != self.nodes.len() {
            return Err(invalid_graph());
        }
        ordered.reverse();
        Ok(ordered)
    }
}

impl Operation {
    fn validate(self) -> Result<()> {
        match self {
            Self::Crop {
                x,
                y,
                width,
                height,
            } => {
                if x >= MAX_EDGE || y >= MAX_EDGE {
                    return Err(Error::Link(
                        "EDITOR_CROP",
                        "Crop origin exceeds the Editor edge limit",
                    ));
                }
                dimensions(width, height)
            }
            Self::Resize { width, height } => dimensions(width, height),
            Self::Exposure { quarter_stops } if !(-16..=16).contains(&quarter_stops) => {
                Err(Error::Link(
                    "EDITOR_EXPOSURE",
                    "Exposure must be between -4 and +4 stops",
                ))
            }
            Self::Color { red, green, blue }
                if [red, green, blue].into_iter().any(|value| value > 200) =>
            {
                Err(Error::Link(
                    "EDITOR_COLOR",
                    "Channel gain must be between 0 and 200 percent",
                ))
            }
            _ => Ok(()),
        }
    }
}

impl Recipe {
    pub(crate) fn validate(&self) -> Result<()> {
        self.source.validate()?;
        if !is_image(self.source.format) {
            return Err(Error::Invalid("Choose a PNG, JPEG or WebP image"));
        }
        if self.source.bytes > MAX_INPUT_BYTES {
            return Err(Error::Link(
                "EDITOR_SIZE",
                "Editor supports source files up to 48 MiB",
            ));
        }
        self.graph.ordered()?;
        Ok(())
    }
}

impl Document {
    pub(crate) fn decode(payload: &str) -> Result<Self> {
        let document: Self =
            serde_json::from_str(payload).map_err(|_| Error::Invalid("Invalid Editor payload"))?;
        document.validate()?;
        Ok(document)
    }

    pub(crate) fn from_content(content: &Content) -> Result<Self> {
        match content {
            Content::Portal {
                type_id,
                schema_version: 1,
                payload,
                ..
            } if type_id == TYPE_ID => Self::decode(payload),
            _ => Err(Error::Invalid("Open an Editor card in this project")),
        }
    }

    pub(crate) fn save(&self, content: &mut Content) -> Result<()> {
        self.validate()?;
        match content {
            Content::Portal {
                type_id,
                schema_version: 1,
                payload,
                ..
            } if type_id == TYPE_ID => {
                *payload = serde_json::to_string(self)?;
                Ok(())
            }
            _ => Err(Error::Invalid("Open an Editor card in this project")),
        }
    }

    fn validate(&self) -> Result<()> {
        if let Some(recipe) = &self.recipe {
            recipe.validate()?;
        }
        if self.exports.len() > MAX_EXPORTS {
            return Err(Error::Limit);
        }
        let mut versions = HashSet::new();
        for entry in &self.exports {
            entry.asset.validate()?;
            if !matches!(entry.asset.format, AssetFormat::Png | AssetFormat::Jpeg)
                || entry.asset.asset_id == entry.recipe.source.asset_id
                || !versions.insert(entry.asset.version_id)
            {
                return Err(Error::Invalid("Invalid Editor export history"));
            }
            entry.recipe.validate()?;
        }
        Ok(())
    }
}

pub(crate) fn render(
    recipe: &Recipe,
    bytes: &[u8],
    mut checkpoint: impl FnMut() -> Result<()>,
) -> Result<RgbaImage> {
    recipe.validate()?;
    let mut decoder = image_reader(Cursor::new(bytes), recipe.source.format)?
        .into_decoder()
        .map_err(|_| Error::AssetIntegrity)?;
    let (width, height) = decoder.dimensions();
    dimensions(width, height)?;
    let orientation = decoder.orientation().map_err(|_| Error::AssetIntegrity)?;
    checkpoint()?;
    let mut image = DynamicImage::from_decoder(decoder).map_err(|_| Error::AssetIntegrity)?;
    image.apply_orientation(orientation);
    let mut image = image.into_rgba8();
    for operation in recipe.graph.ordered()? {
        checkpoint()?;
        match operation {
            Operation::Crop {
                x,
                y,
                width,
                height,
            } => {
                if x + width > image.width() || y + height > image.height() {
                    return Err(Error::Link(
                        "EDITOR_CROP",
                        "The crop must fit the image entering this node",
                    ));
                }
                let mut output = RgbaImage::new(width, height);
                let row_bytes = width as usize * 4;
                for line in 0..height {
                    checkpoint()?;
                    let source = ((y + line) as usize * image.width() as usize + x as usize) * 4;
                    let target = line as usize * row_bytes;
                    output.as_mut()[target..target + row_bytes]
                        .copy_from_slice(&image.as_raw()[source..source + row_bytes]);
                }
                image = output;
            }
            Operation::Resize { width, height } => {
                image = resize(&image, width, height, &mut checkpoint)?;
            }
            Operation::Exposure { quarter_stops } => {
                let gain = (2.0_f64.powf(f64::from(quarter_stops) / 4.0) * 65536.0).round() as u32;
                adjust(&mut image, [gain; 3], 65536, &mut checkpoint)?;
            }
            Operation::Color { red, green, blue } => {
                adjust(
                    &mut image,
                    [red, green, blue].map(u32::from),
                    100,
                    &mut checkpoint,
                )?;
            }
        }
    }
    checkpoint()?;
    Ok(image)
}

fn adjust(
    image: &mut RgbaImage,
    gain: [u32; 3],
    scale: u32,
    checkpoint: &mut impl FnMut() -> Result<()>,
) -> Result<()> {
    for (index, pixel) in image.pixels_mut().enumerate() {
        if index % 4096 == 0 {
            checkpoint()?;
        }
        for (channel, gain) in pixel.0[..3].iter_mut().zip(gain) {
            *channel = ((u32::from(*channel) * gain + scale / 2) / scale).min(255) as u8;
        }
    }
    Ok(())
}

const WEIGHT: u64 = 256;

fn sample(index: u32, input: u32, output: u32) -> (u32, u32, u64) {
    let position = ((u64::from(index) * 2 + 1) * u64::from(input) * WEIGHT
        / (u64::from(output) * 2))
        .saturating_sub(WEIGHT / 2)
        .min(u64::from(input - 1) * WEIGHT);
    let first = (position / WEIGHT) as u32;
    (first, (first + 1).min(input - 1), position % WEIGHT)
}

fn resize(
    input: &RgbaImage,
    width: u32,
    height: u32,
    checkpoint: &mut impl FnMut() -> Result<()>,
) -> Result<RgbaImage> {
    let mut output = RgbaImage::new(width, height);
    let columns: Vec<_> = (0..width)
        .map(|x| sample(x, input.width(), width))
        .collect();
    for y in 0..height {
        checkpoint()?;
        let (top, bottom, fy) = sample(y, input.height(), height);
        for (x, &(left, right, fx)) in columns.iter().enumerate() {
            let contributors = [
                (input.get_pixel(left, top), (WEIGHT - fx) * (WEIGHT - fy)),
                (input.get_pixel(right, top), fx * (WEIGHT - fy)),
                (input.get_pixel(left, bottom), (WEIGHT - fx) * fy),
                (input.get_pixel(right, bottom), fx * fy),
            ];
            let mut alpha = 0;
            let mut rgb = [0; 3];
            for (pixel, weight) in contributors {
                let opacity = u64::from(pixel.0[3]) * weight;
                alpha += opacity;
                for (total, component) in rgb.iter_mut().zip(pixel.0) {
                    *total += u64::from(component) * opacity;
                }
            }
            let resolved = ((alpha + WEIGHT * WEIGHT / 2) / (WEIGHT * WEIGHT)) as u8;
            let [r, g, b] = if resolved == 0 {
                [0; 3]
            } else {
                rgb.map(|value| ((value + alpha / 2) / alpha) as u8)
            };
            output.put_pixel(x as u32, y, Rgba([r, g, b, resolved]));
        }
    }
    Ok(output)
}

pub(crate) fn encode_output(
    image: RgbaImage,
    format: OutputFormat,
    mut checkpoint: impl FnMut() -> Result<()>,
) -> Result<Vec<u8>> {
    let (width, height) = image.dimensions();
    let mut output = Vec::new();
    match format {
        OutputFormat::Png => PngEncoder::new(&mut output).write_image(
            image.as_raw(),
            width,
            height,
            ExtendedColorType::Rgba8,
        ),
        OutputFormat::Jpeg => {
            let mut rgb = Vec::with_capacity(width as usize * height as usize * 3);
            for (index, pixel) in image.pixels().enumerate() {
                if index % 4096 == 0 {
                    checkpoint()?;
                }
                let alpha = u16::from(pixel.0[3]);
                rgb.extend(pixel.0[..3].iter().map(|&channel| {
                    ((u16::from(channel) * alpha + 255 * (255 - alpha) + 127) / 255) as u8
                }));
            }
            JpegEncoder::new_with_quality(&mut output, 90).encode(
                &rgb,
                width,
                height,
                ExtendedColorType::Rgb8,
            )
        }
    }
    .map_err(|_| Error::Invalid("Could not encode the Editor output"))?;
    checkpoint()?;
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn graph_rejects_cycles_and_unused_nodes() {
        let id = Uuid::new_v4();
        let step = Step {
            id,
            input: Some(id),
            operation: Operation::Resize {
                width: 2,
                height: 2,
            },
        };
        for output in [None, Some(id)] {
            let graph = Graph {
                nodes: vec![step.clone()],
                output,
            };
            assert!(matches!(
                graph.ordered(),
                Err(Error::Link("EDITOR_GRAPH", _))
            ));
        }
    }

    #[test]
    fn resize_interpolates_alpha_without_transparent_color_bleed() {
        let image = RgbaImage::from_raw(2, 1, vec![200, 30, 60, 255, 0, 10, 255, 0]).unwrap();
        let result = resize(&image, 1, 1, &mut || Ok(())).unwrap();
        assert_eq!(result.as_raw(), &[200, 30, 60, 128]);
        let canceled = resize(&image, 1, 1, &mut || Err(Error::AnalysisCanceled));
        assert!(matches!(canceled, Err(Error::AnalysisCanceled)));
    }
}
