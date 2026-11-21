use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};

use forge_core::{
    AnalysisPhase, AssetFormat, AssetPreview, Change, ComparisonRequest, Content, DataType,
    EditRequest, EditTextAssetRequest, Error, GalleryItem, ImportProgress, ImportRequest, LinkPort,
    MetadataRequest, Node, PaletteRequest, Position, Project, ReplaceAssetRequest,
};
use image::{DynamicImage, ImageFormat, Rgb, RgbImage};
use rusqlite::{Connection, params};
use sha2::{Digest, Sha256};
use uuid::Uuid;
use zip::{ZipWriter, write::SimpleFileOptions};

struct Fixture {
    root: PathBuf,
    project: PathBuf,
    inputs: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("forge-asset-test-{}", Uuid::new_v4()));
        let project = root.join("project");
        let inputs = root.join("inputs");
        fs::create_dir_all(&project).unwrap();
        fs::create_dir(&inputs).unwrap();
        Self {
            root,
            project,
            inputs,
        }
    }

    fn request(&self, revision: i64, paths: Vec<PathBuf>) -> ImportRequest {
        ImportRequest {
            operation_id: Uuid::new_v4(),
            base_revision: revision,
            paths,
            position: Position { x: 8.0, y: 16.0 },
        }
    }

    fn write(&self, name: &str, bytes: &[u8]) -> PathBuf {
        let path = self.inputs.join(name);
        fs::write(&path, bytes).unwrap();
        path
    }

    fn create_project(&self) -> Project {
        Project::create(&self.project, "File storage".into()).unwrap()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        assert_eq!(self.root.parent(), Some(std::env::temp_dir().as_path()));
        assert!(
            self.root
                .file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("forge-asset-test-")
        );
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn write_docx(path: &Path) {
    let mut archive = ZipWriter::new(fs::File::create(path).unwrap());
    let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    archive.start_file("[Content_Types].xml", options).unwrap();
    archive.write_all(br#"<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>"#).unwrap();
    archive.start_file("word/document.xml", options).unwrap();
    archive.write_all(br#"<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p/></w:body></w:document>"#).unwrap();
    archive.finish().unwrap();
}

#[test]
fn metadata_for_text_preserves_previous_result_on_cancel_and_validates_replay_scope() {
    let fixture = Fixture::new();
    let mut project = fixture.create_project();
    let path = fixture.write("note.md", b"# Verified text\n");
    let imported = project
        .import_assets(fixture.request(0, vec![path]))
        .unwrap();
    let file = &imported.items[0];
    let target_id = Uuid::new_v4();
    let edit = |base_revision, change| EditRequest {
        operation_id: Uuid::new_v4(),
        base_revision,
        change,
    };
    let added = project
        .apply(edit(
            imported.revision,
            Change::Add {
                node: Node {
                    id: target_id,
                    label: "Metadata".into(),
                    position: Position { x: 50.0, y: 50.0 },
                    content: Content::Portal {
                        plain_id: Uuid::new_v4(),
                        type_id: "forge.metadata".into(),
                        schema_version: 1,
                        payload: "{}".into(),
                    },
                },
            },
        ))
        .unwrap();
    let linked = project
        .apply(edit(
            added,
            Change::Connect {
                id: Uuid::new_v4(),
                source: LinkPort {
                    node_id: file.node_id.unwrap(),
                    port_id: "files".into(),
                },
                target: LinkPort {
                    node_id: target_id,
                    port_id: "files".into(),
                },
            },
        ))
        .unwrap();
    let request = MetadataRequest {
        operation_id: Uuid::new_v4(),
        base_revision: linked,
        target_id,
    };
    let summary = project.run_metadata(&request, |_| Ok(())).unwrap();
    let summary = serde_json::to_value(summary).unwrap();
    assert_eq!(summary["itemCount"], 1);
    let result = project
        .metadata_files(target_id, request.operation_id, 0, 1)
        .unwrap();
    let result = serde_json::to_value(result).unwrap();
    assert_eq!(result["files"][0]["asset"]["format"], "md");
    assert_eq!(
        result["files"][0]["asset"]["versionId"],
        file.asset.as_ref().unwrap().version_id.to_string()
    );
    assert!(result["files"][0]["image"].is_null());

    let rerun = MetadataRequest {
        operation_id: Uuid::new_v4(),
        ..request.clone()
    };
    assert_eq!(
        project
            .run_metadata(&rerun, |phase| {
                if phase == AnalysisPhase::Committing {
                    Err(Error::AnalysisCanceled)
                } else {
                    Ok(())
                }
            })
            .unwrap_err()
            .code(),
        "CANCELLED"
    );
    assert_eq!(project.metadata_history(target_id, None).unwrap().len(), 1);
    assert_eq!(
        serde_json::to_value(project.metadata_status(target_id).unwrap().latest).unwrap(),
        summary
    );
    let replayed = project
        .run_metadata(&request, |_| panic!("read already committed data"))
        .unwrap();
    assert_eq!(serde_json::to_value(replayed).unwrap(), summary);
    let cross_kind = PaletteRequest {
        operation_id: request.operation_id,
        base_revision: linked,
        target_id,
        colors: 4,
    };
    assert_eq!(
        project
            .run_palette(&cross_kind, |_| Ok(()))
            .unwrap_err()
            .code(),
        "INVALID_INPUT"
    );
}

#[test]
fn comparison_reads_note_against_markdown_and_keeps_success_on_cancellation() {
    let fixture = Fixture::new();
    let mut project = fixture.create_project();
    let path = fixture.write("revision.md", b"same\nnew\n");
    let imported = project
        .import_assets(fixture.request(0, vec![path]))
        .unwrap();
    let filename = &imported.items[0];
    let note = Uuid::new_v4();
    let target = Uuid::new_v4();
    let left_link = Uuid::new_v4();
    let right_link = Uuid::new_v4();
    let position = Position { x: 0.0, y: 0.0 };
    let mut revision = imported.revision;
    for change in [
        Change::Add {
            node: Node {
                id: note,
                label: "Note".into(),
                position,
                content: Content::Note {
                    text: "same\nold\n".into(),
                },
            },
        },
        Change::Add {
            node: Node {
                id: target,
                label: "Comparison".into(),
                position,
                content: Content::Portal {
                    plain_id: Uuid::new_v4(),
                    type_id: "forge.comparison".into(),
                    schema_version: 1,
                    payload: "{}".into(),
                },
            },
        },
        Change::Connect {
            id: left_link,
            source: LinkPort {
                node_id: note,
                port_id: "text".into(),
            },
            target: LinkPort {
                node_id: target,
                port_id: "sources".into(),
            },
        },
        Change::Connect {
            id: right_link,
            source: LinkPort {
                node_id: filename.node_id.unwrap(),
                port_id: "text".into(),
            },
            target: LinkPort {
                node_id: target,
                port_id: "sources".into(),
            },
        },
    ] {
        revision = project
            .apply(EditRequest {
                operation_id: Uuid::new_v4(),
                base_revision: revision,
                change,
            })
            .unwrap();
    }
    let choice = |link| {
        serde_json::to_value(
            project
                .comparison_choices(target, link, None, 0, 1)
                .unwrap(),
        )
        .unwrap()
    };
    let left = choice(left_link);
    assert_eq!(left["items"][0]["name"], "Note");
    assert!(left["items"][0]["asset"].is_null());
    let right = choice(right_link);
    let request = |id| -> ComparisonRequest {
        serde_json::from_value(serde_json::json!({
        "operationId": id, "baseRevision": revision, "targetId": target,
        "left": { "linkId": left_link, "sourceRevision": left["sourceRevision"], "versionId": null },
        "right": { "linkId": right_link, "sourceRevision": right["sourceRevision"], "versionId": right["items"][0]["asset"]["versionId"] },
    })).unwrap()
    };
    let first = Uuid::new_v4();
    let result = project.run_comparison(&request(first), |_| Ok(())).unwrap();
    let diff =
        serde_json::to_value(project.comparison_lines(target, first, 0, 10).unwrap()).unwrap();
    assert_eq!(diff["lines"][1]["text"], "old");
    assert_eq!(diff["lines"][2]["text"], "new");
    let canceled = project
        .run_comparison(&request(Uuid::new_v4()), |phase| {
            if phase == AnalysisPhase::Committing {
                Err(Error::AnalysisCanceled)
            } else {
                Ok(())
            }
        })
        .unwrap_err();
    assert_eq!(canceled.code(), "CANCELLED");
    assert_eq!(project.comparison_history(target, None).unwrap().len(), 1);
    assert_eq!(
        serde_json::to_value(project.comparison_status(target).unwrap().latest.unwrap()).unwrap(),
        serde_json::to_value(result).unwrap(),
    );
}

#[test]
fn palette_applies_png_color_chunk_precedence_with_an_embedded_icc_profile() {
    let fixture = Fixture::new();
    let icc = moxcms::ColorProfile::new_srgb().encode().unwrap();
    let mut paths = Vec::new();
    for (name, linear_cicp) in [("icc.png", false), ("cicp.png", true)] {
        let mut data = Vec::new();
        let mut info = png::Info::with_size(1, 1);
        info.color_type = png::ColorType::Rgb;
        info.icc_profile = Some(std::borrow::Cow::Borrowed(&icc));
        info.source_gamma = Some(png::ScaledFloat::new(1.0));
        let mut writer = png::Encoder::with_info(&mut data, info)
            .unwrap()
            .write_header()
            .unwrap();
        if linear_cicp {
            writer
                .write_chunk(png::chunk::ChunkType(*b"cICP"), &[1, 8, 0, 1])
                .unwrap();
        }
        writer.write_image_data(&[128, 128, 128]).unwrap();
        writer.finish().unwrap();
        paths.push(fixture.write(name, &data));
    }
    let mut project = fixture.create_project();
    let gallery = Uuid::new_v4();
    let target = Uuid::new_v4();
    let edit = |base_revision, change| EditRequest {
        operation_id: Uuid::new_v4(),
        base_revision,
        change,
    };
    for (index, (id, kind, payload)) in [
        (gallery, "forge.gallery", r#"{"items":[]}"#),
        (target, "forge.palette", "{}"),
    ]
    .into_iter()
    .enumerate()
    {
        project
            .apply(edit(
                index as i64,
                Change::Add {
                    node: Node {
                        id,
                        label: kind.into(),
                        position: Position { x: 0.0, y: 0.0 },
                        content: Content::Portal {
                            plain_id: Uuid::new_v4(),
                            type_id: kind.into(),
                            schema_version: 1,
                            payload: payload.into(),
                        },
                    },
                },
            ))
            .unwrap();
    }
    let result = project
        .import_batch_with_progress(fixture.request(2, paths), Some(gallery), |_| Ok(()))
        .unwrap();
    let revision = project
        .apply(edit(
            result.revision,
            Change::Connect {
                id: Uuid::new_v4(),
                source: LinkPort {
                    node_id: gallery,
                    port_id: "images".into(),
                },
                target: LinkPort {
                    node_id: target,
                    port_id: "images".into(),
                },
            },
        ))
        .unwrap();
    let request = PaletteRequest {
        operation_id: Uuid::new_v4(),
        base_revision: revision,
        target_id: target,
        colors: 4,
    };
    project.run_palette(&request, |_| Ok(())).unwrap();
    let files = serde_json::to_value(
        project
            .palette_files(target, request.operation_id, 0, 2)
            .unwrap(),
    )
    .unwrap();
    assert_eq!(files["files"][0]["swatches"][0]["hex"], "#808080");
    assert_eq!(files["files"][1]["swatches"][0]["hex"], "#BCBCBC");
}

#[test]
fn batch_validates_all_supported_formats_and_preserves_original_bytes() {
    let fixture = Fixture::new();
    let mut project = fixture.create_project();
    let image = DynamicImage::ImageRgb8(RgbImage::from_pixel(2, 2, Rgb([21, 40, 50])));
    for (name, format) in [
        ("sample.png", ImageFormat::Png),
        ("sample.JPG", ImageFormat::Jpeg),
        ("sample.webp", ImageFormat::WebP),
    ] {
        image
            .save_with_format(fixture.inputs.join(name), format)
            .unwrap();
    }
    let docx = fixture.inputs.join("sample.docx");
    write_docx(&docx);
    let first_text = "Привет".repeat(15000);
    let paths = [
        fixture.inputs.join("sample.png"),
        fixture.inputs.join("sample.JPG"),
        fixture.inputs.join("sample.webp"),
        fixture.write("same.txt", first_text.as_bytes()),
        fixture.write("notes.md", b"# Hello\n"),
        fixture.write(
            "document.pdf",
            b"%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n",
        ),
        docx,
        fixture.write("masquerading.png", b"this is not a png"),
        fixture.write("bad.txt", &[0, 255]),
        fixture.write("empty.md", b""),
        fixture.write("bad-package.docx", b"not a ZIP"),
        fixture.write("truncated.pdf", b"%PDF-1.7\nmissing end of file"),
    ];
    let request = fixture.request(0, paths.to_vec());
    let batch = project.import_assets(request.clone()).unwrap();
    assert_eq!(batch.revision, 1);
    let formats = [
        AssetFormat::Png,
        AssetFormat::Jpeg,
        AssetFormat::Webp,
        AssetFormat::Txt,
        AssetFormat::Md,
        AssetFormat::Pdf,
        AssetFormat::Docx,
    ];
    for (index, format) in formats.into_iter().enumerate() {
        let asset = batch.items[index].asset.as_ref().unwrap();
        let node_id = batch.items[index].node_id.unwrap();
        let node = project
            .view()
            .unwrap()
            .space
            .nodes
            .into_iter()
            .find(|node| node.id == node_id)
            .unwrap();
        assert!(matches!(node.content, Content::Asset { asset: reference } if reference == *asset));
        assert_eq!(asset.format, format);
        let original = fs::read(&paths[index]).unwrap();
        let blob = fixture.project.join("assets").join(format!(
            "asset-{}.{}",
            asset.version_id,
            format.suffix()
        ));
        assert_eq!(fs::read(blob).unwrap(), original);
        assert_eq!(asset.sha256, format!("{:x}", Sha256::digest(&original)));
        let export = fixture.root.join(format!("export.{}", format.suffix()));
        project
            .export_asset(node_id, asset.version_id, &export)
            .unwrap();
        assert_eq!(fs::read(&export).unwrap(), original);
        fs::remove_file(export).unwrap();
        let preview = project.preview_asset(node_id, asset.version_id).unwrap();
        match format {
            AssetFormat::Png | AssetFormat::Jpeg | AssetFormat::Webp => {
                let AssetPreview::Image { png } = preview else {
                    panic!("expected PNG preview");
                };
                let decoded = image::load_from_memory_with_format(&png, ImageFormat::Png).unwrap();
                assert_eq!((decoded.width(), decoded.height()), (2, 2));
            }
            AssetFormat::Txt | AssetFormat::Md => {
                let AssetPreview::Text { text, truncated } = preview else {
                    panic!("expected text preview");
                };
                assert!(original.starts_with(text.as_bytes()));
                assert_eq!(truncated, format == AssetFormat::Txt);
            }
            AssetFormat::Pdf
            | AssetFormat::Docx
            | AssetFormat::Wav
            | AssetFormat::Webm
            | AssetFormat::Mp4 => {
                assert!(matches!(preview, AssetPreview::Document))
            }
        }
    }
    for item in &batch.items[7..] {
        assert!(item.asset.is_none());
        assert!(item.node_id.is_none());
        assert!(item.error_code.is_some());
    }
    let replay = project.import_assets(request).unwrap();
    assert_eq!(replay.revision, 1);
    assert_eq!(replay.items[0].node_id, batch.items[0].node_id);
    assert_eq!(
        fs::read_dir(fixture.project.join(".forge/staging"))
            .unwrap()
            .count(),
        0
    );
    assert_eq!(project.view().unwrap().space.nodes.len(), 7);
    let original = batch.items[3].asset.as_ref().unwrap();
    let nested = fixture.inputs.join("another");
    fs::create_dir(&nested).unwrap();
    let same_name = nested.join("same.txt");
    fs::write(&same_name, b"Different material").unwrap();
    let second = project
        .import_assets(fixture.request(1, vec![same_name]))
        .unwrap();
    let added = second.items[0].asset.as_ref().unwrap();
    assert_eq!(original.name, added.name);
    assert_ne!(original.asset_id, added.asset_id);
    drop(project);
    let mut reopened = Project::open(&fixture.project).unwrap();
    assert_eq!(reopened.view().unwrap().space.nodes.len(), 8);
    reopened
        .apply(EditRequest {
            operation_id: Uuid::new_v4(),
            base_revision: 2,
            change: Change::Undo,
        })
        .unwrap();
    assert_eq!(reopened.view().unwrap().space.nodes.len(), 7);
    assert_eq!(
        fs::read_dir(fixture.project.join("assets"))
            .unwrap()
            .count(),
        8,
        "history keeps old bytes"
    );
}

#[test]
fn canceled_import_rolls_back_copied_prefix_and_can_replay() {
    let fixture = Fixture::new();
    let small = fixture.write("small.txt", b"Already copied");
    let large = fixture.write("large.txt", &vec![b'x'; 200_000]);
    let mut project = fixture.create_project();
    let import = fixture.request(0, vec![small, large]);
    let mut bytes_at_cancel = 0;
    let error = project
        .import_assets_with_progress(import.clone(), |progress| {
            if let ImportProgress::Copying {
                file_index: 2,
                bytes,
                file_bytes: 200_000,
                ..
            } = progress
                && bytes > 0
            {
                bytes_at_cancel = bytes;
                return Err(forge_core::Error::ImportCanceled);
            }
            Ok(())
        })
        .unwrap_err();
    assert_eq!(error.code(), "IMPORT_CANCELED");
    assert!(bytes_at_cancel > 0 && bytes_at_cancel < 200_000);
    assert_eq!(project.view().unwrap().revision, 0);
    assert_eq!(
        fs::read_dir(fixture.project.join("assets"))
            .unwrap()
            .count(),
        0
    );
    assert_eq!(
        fs::read_dir(fixture.project.join(".forge/staging"))
            .unwrap()
            .count(),
        0
    );
    let mut finish_observed = false;
    let result = project
        .import_assets_with_progress(import, |progress| {
            finish_observed |= matches!(progress, ImportProgress::Committing { total_files: 2 });
            Ok(())
        })
        .unwrap();
    assert!(finish_observed);
    assert_eq!(result.revision, 1);
    assert!(result.items.iter().all(|item| item.asset.is_some()));
}

#[test]
fn gallery_and_links_keep_order_versions_and_endpoint_rules_across_reopen() {
    let fixture = Fixture::new();
    let red = fixture.inputs.join("red.png");
    let blue = fixture.inputs.join("blue.png");
    RgbImage::from_pixel(2, 2, Rgb([255, 0, 0]))
        .save(&red)
        .unwrap();
    RgbImage::from_pixel(2, 2, Rgb([0, 0, 255]))
        .save(&blue)
        .unwrap();
    let note = fixture.write("not-an-image.txt", b"Literal text");
    let gallery_id = Uuid::new_v4();
    let palette_id = Uuid::new_v4();
    let comparison_id = Uuid::new_v4();
    let change = |base_revision, change| EditRequest {
        operation_id: Uuid::new_v4(),
        base_revision,
        change,
    };
    let mut project = fixture.create_project();
    for (index, (id, type_id, payload)) in [
        (gallery_id, "forge.gallery", r#"{"items":[]}"#),
        (palette_id, "forge.palette", "{}"),
        (comparison_id, "forge.comparison", "{}"),
    ]
    .into_iter()
    .enumerate()
    {
        project
            .apply(change(
                index as i64,
                Change::Add {
                    node: Node {
                        id,
                        label: type_id.into(),
                        position: Position { x: 0.0, y: 0.0 },
                        content: Content::Portal {
                            plain_id: Uuid::new_v4(),
                            type_id: type_id.into(),
                            schema_version: 1,
                            payload: payload.into(),
                        },
                    },
                },
            ))
            .unwrap();
    }
    let request = fixture.request(3, vec![red.clone(), note.clone(), blue]);
    let imported = project
        .import_batch_with_progress(request.clone(), Some(gallery_id), |_| Ok(()))
        .unwrap();
    assert_eq!(imported.revision, 4);
    assert!(imported.items[0].asset.is_some());
    assert_eq!(
        imported.items[1].error_code.as_deref(),
        Some("INVALID_INPUT")
    );
    assert!(imported.items[2].asset.is_some());
    assert!(imported.items.iter().all(|item| item.node_id.is_none()));
    assert_eq!(
        project
            .import_batch_with_progress(request, Some(gallery_id), |_| Ok(()))
            .unwrap()
            .revision,
        4
    );
    let page = project.gallery_page(gallery_id, None, 0, 1).unwrap();
    assert_eq!(page.total, 2);
    assert_eq!(page.items[0].name, "red.png");
    assert_eq!(page.next_offset, Some(1));
    let image = project
        .gallery_preview(gallery_id, &page.source_revision, page.items[0].version_id)
        .unwrap();
    assert!(matches!(image, AssetPreview::Image { .. }));
    let imported_text = project
        .import_assets(fixture.request(4, vec![note, red]))
        .unwrap();
    let text_node = imported_text.items[0].node_id.unwrap();
    let endpoint = |node_id, port: &str| LinkPort {
        node_id,
        port_id: port.into(),
    };
    let link = |id, from, source, to, target| Change::Connect {
        id,
        source: endpoint(from, source),
        target: endpoint(to, target),
    };
    let palette_link = Uuid::new_v4();
    assert_eq!(
        project
            .apply(change(
                5,
                link(Uuid::new_v4(), gallery_id, "files", palette_id, "images")
            ))
            .unwrap_err()
            .code(),
        "LINK_INCOMPATIBLE"
    );
    assert_eq!(
        project
            .apply(change(
                5,
                link(Uuid::new_v4(), palette_id, "palette", palette_id, "images")
            ))
            .unwrap_err()
            .code(),
        "LINK_CYCLE"
    );
    project
        .apply(change(
            5,
            link(palette_link, gallery_id, "images", palette_id, "images"),
        ))
        .unwrap();
    assert_eq!(
        project
            .apply(change(
                6,
                link(Uuid::new_v4(), gallery_id, "images", palette_id, "images")
            ))
            .unwrap_err()
            .code(),
        "LINK_DUPLICATE"
    );
    let file_image = imported_text.items[1].node_id.unwrap();
    assert_eq!(
        project
            .apply(change(
                6,
                link(Uuid::new_v4(), file_image, "images", palette_id, "images")
            ))
            .unwrap_err()
            .code(),
        "LINK_CARDINALITY"
    );
    assert_eq!(
        project
            .apply(change(
                6,
                link(
                    Uuid::new_v4(),
                    Uuid::new_v4(),
                    "images",
                    palette_id,
                    "images"
                )
            ))
            .unwrap_err()
            .code(),
        "LINK_ENDPOINT"
    );
    assert_eq!(
        project.view().unwrap().space.links[0].data_type,
        DataType::ImageCollection
    );
    let second = project
        .linked_assets(palette_id, palette_link, Some(&page.source_revision), 1, 1)
        .unwrap();
    assert_eq!(second.items[0].name(), "blue.png");
    assert_eq!(
        project
            .linked_assets(comparison_id, palette_link, None, 0, 1)
            .unwrap_err()
            .code(),
        "SOURCE_NOT_FOUND"
    );
    let text_link = Uuid::new_v4();
    project
        .apply(change(
            6,
            link(text_link, text_node, "text", comparison_id, "sources"),
        ))
        .unwrap();
    assert_eq!(
        project
            .linked_text(comparison_id, text_link, None)
            .unwrap()
            .text,
        "Literal text"
    );
    let text = imported_text.items[0].asset.as_ref().unwrap();
    assert!(
        project
            .apply(change(
                7,
                Change::EditGallery {
                    id: gallery_id,
                    items: vec![GalleryItem {
                        asset_id: text.asset_id,
                        version_id: text.version_id
                    }]
                }
            ))
            .is_err()
    );
    let blue_asset = imported.items[2].asset.as_ref().unwrap();
    assert_eq!(second.items[0].version_id(), blue_asset.version_id);
    let items = [blue_asset, &page.items[0]]
        .into_iter()
        .map(|asset| GalleryItem {
            asset_id: asset.asset_id,
            version_id: asset.version_id,
        })
        .collect();
    project
        .apply(change(
            7,
            Change::EditGallery {
                id: gallery_id,
                items,
            },
        ))
        .unwrap();
    assert_eq!(
        project
            .linked_assets(palette_id, palette_link, Some(&page.source_revision), 0, 2)
            .unwrap_err()
            .code(),
        "SOURCE_CHANGED"
    );
    let reordered = project
        .linked_assets(palette_id, palette_link, None, 0, 2)
        .unwrap();
    assert_eq!(reordered.items[0].name(), "blue.png");
    project
        .apply(change(8, Change::ArchiveNode { id: gallery_id }))
        .unwrap();
    assert_eq!(project.view().unwrap().space.links.len(), 1);
    project.apply(change(9, Change::Undo)).unwrap();
    drop(project);
    let mut project = Project::open(&fixture.project).unwrap();
    let restored = project
        .linked_assets(
            palette_id,
            palette_link,
            Some(&reordered.source_revision),
            0,
            2,
        )
        .unwrap();
    assert_eq!(restored.items, reordered.items);
    let restored_view = project.view().unwrap();
    assert_eq!(restored_view.space.links.len(), 2);
    let copied = restored_view
        .space
        .nodes
        .into_iter()
        .filter(|node| node.id == gallery_id || node.id == palette_id)
        .collect();
    let original = restored_view
        .space
        .links
        .iter()
        .find(|link| link.id == palette_link)
        .unwrap();
    project
        .apply(change(
            10,
            Change::Paste {
                nodes: copied,
                groups: vec![],
                links: vec![original.clone()],
            },
        ))
        .unwrap();
    let pasted = project.view().unwrap();
    assert_eq!(pasted.space.links.len(), 3);
    let cloned = pasted.space.links.last().unwrap();
    assert_ne!(cloned.id, original.id);
    assert_ne!(cloned.source.node_id, original.source.node_id);
    assert_ne!(cloned.target.node_id, original.target.node_id);
    assert_eq!(
        project
            .linked_assets(
                cloned.target.node_id,
                cloned.id,
                Some(&restored.source_revision),
                0,
                2
            )
            .unwrap()
            .items,
        restored.items
    );
}

#[test]
fn verified_reads_reject_stale_versions_and_same_length_corruption_without_publishing() {
    let fixture = Fixture::new();
    let mut project = fixture.create_project();
    let long_text = "€".repeat(22_000);
    let source = fixture.write("source.txt", long_text.as_bytes());
    let batch = project
        .import_assets(fixture.request(0, vec![source]))
        .unwrap();
    let node_id = batch.items[0].node_id.unwrap();
    let asset = batch.items[0].asset.as_ref().unwrap();
    let version_id = asset.version_id;
    let AssetPreview::Text { text, truncated } =
        project.preview_asset(node_id, version_id).unwrap()
    else {
        panic!("expected text preview");
    };
    assert!(truncated);
    assert_eq!(text.len(), 65_535);
    assert_eq!(text.as_bytes(), &long_text.as_bytes()[..65_535]);
    assert_eq!(
        project
            .preview_asset(node_id, Uuid::new_v4())
            .unwrap_err()
            .code(),
        "ASSET_UNAVAILABLE"
    );

    let existing = fixture.write("existing.txt", b"keep this file");
    assert_eq!(
        project
            .export_asset(node_id, version_id, &existing)
            .unwrap_err()
            .code(),
        "EXPORT_EXISTS"
    );
    assert_eq!(fs::read(&existing).unwrap(), b"keep this file");
    let invalid = fixture.inputs.join("copy.png");
    assert_eq!(
        project
            .export_asset(node_id, version_id, &invalid)
            .unwrap_err()
            .code(),
        "INVALID_INPUT"
    );
    assert!(!invalid.exists());

    let blob = fixture
        .project
        .join("assets")
        .join(format!("asset-{version_id}.txt"));
    let mut changed = long_text.into_bytes();
    *changed.last_mut().unwrap() = 0xAD;
    fs::write(blob, changed).unwrap();
    assert_eq!(
        project
            .preview_asset(node_id, version_id)
            .unwrap_err()
            .code(),
        "ASSET_INTEGRITY"
    );
    let destination = fixture.inputs.join("copy.txt");
    assert_eq!(
        project
            .export_asset(node_id, version_id, &destination)
            .unwrap_err()
            .code(),
        "ASSET_INTEGRITY"
    );
    assert!(!destination.exists());
    assert_eq!(fs::read_dir(&fixture.inputs).unwrap().count(), 2);
    assert_eq!(project.view().unwrap().revision, 1);

    project
        .apply(EditRequest {
            operation_id: Uuid::new_v4(),
            base_revision: 1,
            change: Change::Undo,
        })
        .unwrap();
    assert_eq!(
        project
            .preview_asset(node_id, version_id)
            .unwrap_err()
            .code(),
        "ASSET_UNAVAILABLE"
    );
}

#[test]
fn replacement_reuses_asset_identity_and_keeps_both_versions_in_history() {
    let fixture = Fixture::new();
    let mut project = fixture.create_project();
    let original = fixture.write("original.txt", b"first version");
    let batch = project
        .import_assets(fixture.request(0, vec![original]))
        .unwrap();
    let node_id = batch.items[0].node_id.unwrap();
    let before = batch.items[0].asset.as_ref().unwrap();
    let source = fixture.write("replacement.txt", b"second version");
    let mut request = ReplaceAssetRequest {
        operation_id: Uuid::new_v4(),
        base_revision: 0,
        node_id,
        version_id: before.version_id,
        source,
    };
    assert_eq!(
        project.replace_asset(request.clone()).unwrap_err().code(),
        "REVISION_CONFLICT"
    );
    request.base_revision = 1;
    let invalid = ReplaceAssetRequest {
        source: fixture.write("replacement.md", b"wrong format"),
        ..request.clone()
    };
    assert_eq!(
        project.replace_asset(invalid).unwrap_err().code(),
        "INVALID_INPUT"
    );
    let invalid = ReplaceAssetRequest {
        source: fixture.write("invalid.txt", b"not text\0"),
        ..request.clone()
    };
    assert_eq!(
        project.replace_asset(invalid).unwrap_err().code(),
        "INVALID_INPUT"
    );
    assert_eq!(project.view().unwrap().revision, 1);

    let db = Connection::open(fixture.project.join(".forge/workspace.sqlite")).unwrap();
    db.execute_batch("CREATE TRIGGER fail_replace BEFORE INSERT ON revisions WHEN NEW.reason='replaceAsset' BEGIN SELECT RAISE(ABORT, 'fixture'); END;").unwrap();
    assert!(project.replace_asset(request.clone()).is_err());
    assert_eq!(project.view().unwrap().revision, 1);
    assert_eq!(
        fs::read_dir(fixture.project.join("assets"))
            .unwrap()
            .count(),
        1
    );
    db.execute_batch("DROP TRIGGER fail_replace;").unwrap();
    drop(db);

    assert_eq!(project.replace_asset(request.clone()).unwrap(), 2);
    assert_eq!(project.replace_asset(request.clone()).unwrap(), 2);
    assert_eq!(
        fs::read_dir(fixture.project.join("assets"))
            .unwrap()
            .count(),
        2
    );
    let view = project.view().unwrap();
    assert_eq!(view.space.nodes.len(), 1);
    let node = &view.space.nodes[0];
    assert_eq!(node.id, node_id);
    assert_eq!(node.label, "replacement.txt");
    let Content::Asset { asset: after } = &node.content else {
        panic!("expected asset");
    };
    assert_eq!(before.asset_id, after.asset_id);
    assert_ne!(before.version_id, after.version_id);
    request.operation_id = Uuid::new_v4();
    request.base_revision = 2;
    assert_eq!(
        project.replace_asset(request).unwrap_err().code(),
        "ASSET_UNAVAILABLE"
    );
    drop(project);
    let mut project = Project::open(&fixture.project).unwrap();
    assert_eq!(
        &project.asset_details(node_id, after.version_id).unwrap(),
        after
    );
    project
        .apply(EditRequest {
            operation_id: Uuid::new_v4(),
            base_revision: 2,
            change: Change::Undo,
        })
        .unwrap();
    assert_eq!(
        &project.asset_details(node_id, before.version_id).unwrap(),
        before
    );
    project
        .apply(EditRequest {
            operation_id: Uuid::new_v4(),
            base_revision: 3,
            change: Change::Redo,
        })
        .unwrap();
    assert_eq!(
        &project.asset_details(node_id, after.version_id).unwrap(),
        after
    );
}

#[test]
fn text_editor_checks_byte_limit_integrity_and_revision_and_keeps_original() {
    let fixture = Fixture::new();
    let mut project = fixture.create_project();
    let original = "\u{feff}First\r\nПривет\r\n";
    let files = vec![
        fixture.write("original.md", original.as_bytes()),
        fixture.write("large.txt", &vec![b'x'; 256 * 1024 + 1]),
        fixture.write("manual.pdf", b"%PDF-1.7\n%%EOF\n"),
    ];
    let batch = project.import_assets(fixture.request(0, files)).unwrap();
    let (node, asset) = (
        batch.items[0].node_id.unwrap(),
        batch.items[0].asset.as_ref().unwrap(),
    );
    assert_eq!(
        project.read_asset_text(node, asset.version_id).unwrap(),
        original
    );
    for item in &batch.items[1..] {
        let err = project
            .read_asset_text(
                item.node_id.unwrap(),
                item.asset.as_ref().unwrap().version_id,
            )
            .unwrap_err();
        assert_eq!(err.code(), "INVALID_INPUT");
    }
    let mut request = EditTextAssetRequest {
        operation_id: Uuid::new_v4(),
        base_revision: 1,
        node_id: node,
        version_id: asset.version_id,
        text: String::new(),
    };
    for invalid in ["", "\0", original, &"𐍈".repeat(65_537)] {
        request.text = invalid.into();
        assert_eq!(
            project.edit_text_asset(request.clone()).unwrap_err().code(),
            "INVALID_INPUT"
        );
    }
    let file = fixture
        .project
        .join("assets")
        .join(format!("asset-{}.md", asset.version_id));
    let mut changed = original.as_bytes().to_vec();
    changed[3] = b'J';
    fs::write(&file, &changed).unwrap();
    let expected = "𐍈".repeat(65_536);
    request.text = expected.clone();
    assert_eq!(
        project.edit_text_asset(request.clone()).unwrap_err().code(),
        "ASSET_INTEGRITY"
    );
    assert_eq!(project.view().unwrap().revision, 1);
    fs::write(&file, original.as_bytes()).unwrap();
    assert_eq!(project.edit_text_asset(request.clone()).unwrap(), 2);
    assert_eq!(project.edit_text_asset(request).unwrap(), 2);
    let view = project.view().unwrap();
    let Content::Asset { asset: revised } = &view.space.nodes[0].content else {
        panic!("expected text asset");
    };
    assert_eq!(revised.asset_id, asset.asset_id);
    assert_eq!(revised.name, asset.name);
    assert_eq!(revised.bytes, 256 * 1024);
    assert_ne!(revised.version_id, asset.version_id);
    assert_eq!(fs::read_to_string(file).unwrap(), original);
    drop(project);
    let mut reopened = Project::open(&fixture.project).unwrap();
    assert_eq!(
        reopened.read_asset_text(node, revised.version_id).unwrap(),
        expected
    );
    reopened
        .apply(EditRequest {
            operation_id: Uuid::new_v4(),
            base_revision: 2,
            change: Change::Undo,
        })
        .unwrap();
    assert_eq!(
        reopened.read_asset_text(node, asset.version_id).unwrap(),
        original
    );
}

#[cfg(target_os = "linux")]
#[test]
#[ignore = "requires the isolated 16 MiB container mount /forge-full-test"]
fn import_handles_real_storage_exhaustion() {
    let fixture = Fixture::new();
    let mount = Path::new("/forge-full-test");
    assert!(mount.is_dir(), "mount a 16 MiB tmpfs on /forge-full-test");
    let project_dir = mount.join(format!("forge-asset-test-{}", Uuid::new_v4()));
    fs::create_dir(&project_dir).unwrap();
    let kept = fixture.write("kept.txt", b"Committed original");
    let small = fixture.write("small.txt", b"Retry succeeded");
    let too_large = fixture.write("large.txt", &vec![b'a'; 24 * 1024 * 1024]);

    let mut project = Project::create(&project_dir, "Full volume".into()).unwrap();
    let first = project
        .import_assets(fixture.request(0, vec![kept]))
        .unwrap();
    let original = first.items[0].asset.as_ref().unwrap();
    let node = first.items[0].node_id.unwrap();
    let failed = project
        .import_assets(fixture.request(1, vec![too_large]))
        .unwrap();
    assert_eq!(failed.revision, 1);
    assert_eq!(failed.items[0].error_code.as_deref(), Some("STORAGE_FULL"));
    assert_eq!(fs::read_dir(project_dir.join("assets")).unwrap().count(), 1);
    assert_eq!(
        fs::read_dir(project_dir.join(".forge/staging"))
            .unwrap()
            .count(),
        0
    );
    drop(project);
    let mut project = Project::open(&project_dir).unwrap();
    assert_eq!(project.view().unwrap().revision, 1);
    assert_eq!(
        project.read_asset_text(node, original.version_id).unwrap(),
        "Committed original"
    );
    let reopened = project
        .import_assets(fixture.request(1, vec![small]))
        .unwrap();
    assert_eq!(reopened.revision, 2);
    assert!(reopened.items[0].asset.is_some());
    println!(
        "storageFull: file rejected at revision 1; committed bytes recovered on reopen; next import advanced to revision 2"
    );
}

#[test]
fn recovery_removes_only_uncommitted_asset_and_preserves_committed_revision() {
    let fixture = Fixture::new();
    let mut project = fixture.create_project();
    let input = fixture.write("kept.txt", b"committed");
    project
        .import_assets(fixture.request(0, vec![input]))
        .unwrap();
    drop(project);
    let new_version = Uuid::new_v4();
    let loose = fixture
        .project
        .join("assets")
        .join(format!("asset-{new_version}.txt"));
    let stage = fixture
        .project
        .join(".forge")
        .join("staging")
        .join(format!("asset-{new_version}.part"));
    let data = b"incomplete import";
    fs::write(&stage, data).unwrap();
    fs::hard_link(&stage, &loose).unwrap();
    let connection = Connection::open(fixture.project.join(".forge/workspace.sqlite")).unwrap();
    connection
        .execute(
            "INSERT INTO asset_intents(version_id,suffix,bytes,sha256) VALUES (?1,'txt',?2,?3)",
            params![
                new_version.to_string(),
                data.len() as i64,
                format!("{:x}", Sha256::digest(data))
            ],
        )
        .unwrap();
    drop(connection);
    let project = Project::open(&fixture.project).unwrap();
    assert!(!loose.exists() && !stage.exists());
    assert_eq!(project.view().unwrap().revision, 1);
    assert_eq!(project.view().unwrap().space.nodes.len(), 1);
    assert_eq!(
        fs::read_dir(fixture.project.join("assets"))
            .unwrap()
            .count(),
        1
    );
}

#[test]
fn failed_database_publication_rolls_back_blob_and_preserves_head() {
    let fixture = Fixture::new();
    let mut project = fixture.create_project();
    let source = fixture.write("valid.txt", b"Valid but not published");
    let external = Connection::open(fixture.project.join(".forge/workspace.sqlite")).unwrap();
    external.execute_batch("CREATE TRIGGER deny_publish BEFORE INSERT ON asset_versions BEGIN SELECT RAISE(ABORT, 'fixture failure'); END;").unwrap();
    assert!(
        project
            .import_assets(fixture.request(0, vec![source]))
            .is_err()
    );
    assert_eq!(project.view().unwrap().revision, 0);
    assert_eq!(
        fs::read_dir(fixture.project.join("assets"))
            .unwrap()
            .count(),
        0
    );
    assert_eq!(
        fs::read_dir(fixture.project.join(".forge/staging"))
            .unwrap()
            .count(),
        0
    );
    let outstanding: u32 = external
        .query_row("SELECT COUNT(*) FROM asset_intents", [], |r| r.get(0))
        .unwrap();
    assert_eq!(outstanding, 0);
}

#[cfg(unix)]
#[test]
fn import_rejects_symbolic_links_and_destination_escape() {
    use std::os::unix::fs::symlink;
    let fixture = Fixture::new();
    let mut project = fixture.create_project();
    let source = fixture.write("real.txt", b"Allowed source");
    let alias = fixture.inputs.join("symlink.txt");
    symlink(&source, &alias).unwrap();
    let rejected = project
        .import_assets(fixture.request(0, vec![alias]))
        .unwrap();
    assert!(rejected.items[0].asset.is_none());
    assert_eq!(rejected.revision, 0);

    let outside = fixture.root.join("other");
    fs::create_dir(&outside).unwrap();
    let assets = fixture.project.join("assets");
    fs::remove_dir(&assets).unwrap();
    symlink(&outside, &assets).unwrap();
    assert!(
        project
            .import_assets(fixture.request(0, vec![source]))
            .is_err()
    );
    assert_eq!(fs::read_dir(outside).unwrap().count(), 0);
}
