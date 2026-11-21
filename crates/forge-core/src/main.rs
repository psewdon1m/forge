use std::{
    collections::HashMap,
    io::{self, BufRead, Read, Write},
    path::PathBuf,
    sync::{
        Arc, Weak,
        atomic::{AtomicU8, Ordering},
        mpsc::{self, SyncSender},
    },
    time::{Duration, Instant},
};

use forge_core::diagnostics::{Cursor, Diagnostics, Observation, UpdateArchiveContext};
use forge_core::git;
use forge_core::settings::{Preferences, ProfileSettings};
use forge_core::{
    AnalysisPhase, ComparisonRequest, ComparisonSide, DirectoryChange, EditRequest,
    EditTextAssetRequest, EditorExportRequest, EditorPreviewRequest, Error, ImportProgress,
    ImportRequest, MetadataRequest, PaletteRequest, Project, ReplaceAssetRequest, Result, Viewport,
    create_settings_backup, inspect_settings_backup, read_settings_backup,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use uuid::Uuid;

#[cfg(windows)]
mod open_with;
mod pdf_worker;

const MAX_LINE: usize = 2 * 1024 * 1024;
const RUNNING: u8 = 0;
const CANCELED: u8 = 1;
const COMMITTING: u8 = 2;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    id: u64,
    command: Command,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
enum Cancel {
    #[serde(rename = "cancelImport")]
    Import(Uuid),
    #[serde(rename = "cancelAnalysis")]
    Analysis(Uuid),
}

#[derive(Deserialize)]
#[serde(untagged)]
enum InputFrame {
    Request(Box<Request>),
    Cancel(Cancel),
}

struct Incoming {
    request: Request,
    operation_state: Option<Arc<AtomicU8>>,
}

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum Command {
    SettingsOpen {
        profile: PathBuf,
    },
    SettingsRead,
    SettingsSave {
        base_revision: i64,
        preferences: Preferences,
    },
    SettingsBackupExport {
        destination: PathBuf,
        base_revision: i64,
    },
    SettingsBackupInspect {
        path: PathBuf,
    },
    SettingsBackupRestore {
        path: PathBuf,
        archive_sha256: String,
        base_revision: i64,
    },
    DiagnosticsOpen {
        profile: PathBuf,
    },
    DiagnosticsRecord {
        observation: Observation,
    },
    DiagnosticsPage {
        before: Option<Cursor>,
    },
    DiagnosticsExport {
        destination: PathBuf,
        update: Option<UpdateArchiveContext>,
    },
    Create {
        directory: PathBuf,
        title: String,
    },
    Open {
        directory: PathBuf,
        expected_project_id: Option<Uuid>,
    },
    Close,
    View,
    VerifyProjectIntegrity,
    CreateBackup {
        destination: PathBuf,
        base_revision: i64,
    },
    InspectBackup {
        path: PathBuf,
    },
    RestoreBackup {
        path: PathBuf,
        destination: PathBuf,
        archive_sha256: String,
    },
    DirectoryList {
        node_id: Uuid,
        folder: Vec<String>,
    },
    DirectoryChange {
        node_id: Uuid,
        base_revision: i64,
        change: DirectoryChange,
    },
    GitCheck {
        node_id: Uuid,
    },
    GitRead {
        node_id: Uuid,
        repository: PathBuf,
    },
    GitDiff {
        node_id: Uuid,
        repository: PathBuf,
        path: String,
        side: git::DiffSide,
        revision: String,
    },
    GitMutate {
        node_id: Uuid,
        repository: PathBuf,
        revision: String,
        action: git::Action,
    },
    Apply {
        request: EditRequest,
    },
    ImportAssets {
        request: ImportRequest,
        gallery_id: Option<Uuid>,
    },
    GalleryPage {
        node_id: Uuid,
        source_revision: Option<String>,
        offset: usize,
        limit: usize,
    },
    GalleryPreview {
        node_id: Uuid,
        source_revision: String,
        version_id: Uuid,
    },
    ExportGalleryVideo {
        node_id: Uuid,
        source_revision: String,
        version_id: Uuid,
        destination: PathBuf,
    },
    LinkedAssets {
        target_id: Uuid,
        link_id: Uuid,
        source_revision: Option<String>,
        offset: usize,
        limit: usize,
    },
    LinkedText {
        target_id: Uuid,
        link_id: Uuid,
        source_revision: Option<String>,
    },
    ResearchStatus {
        target_id: Uuid,
    },
    ResearchTranscription {
        request: forge_core::research::TranscriptionRequest,
        destination: Option<PathBuf>,
        operation_id: Option<Uuid>,
    },
    ModelContext {
        request: forge_core::intelligent::ContextRequest,
    },
    ResearchPreview {
        target_id: Uuid,
        source_id: Uuid,
        revision: String,
    },
    ExportResearchAudio {
        project_id: Uuid,
        target_id: Uuid,
        source_id: Uuid,
        revision: String,
        destination: PathBuf,
    },
    ChecklistCompletions {
        node_id: Uuid,
        source_revision: Option<String>,
        offset: usize,
        limit: usize,
    },
    DatasetRead {
        path: PathBuf,
    },
    DatasetPreview {
        text: String,
        options: forge_core::dataset::ImportOptions,
    },
    DatasetPage {
        node_id: Uuid,
        query: forge_core::dataset::Query,
    },
    DatasetExport {
        node_id: Uuid,
        source_revision: String,
        delimiter: forge_core::dataset::Delimiter,
        destination: PathBuf,
    },
    SchemeRead {
        path: PathBuf,
    },
    SchemeGraph {
        node_id: Uuid,
        source_revision: Option<String>,
    },
    SchemeExport {
        node_id: Uuid,
        base_revision: i64,
        destination: PathBuf,
    },
    RunPalette {
        request: PaletteRequest,
    },
    PaletteStatus {
        target_id: Uuid,
    },
    PaletteHistory {
        target_id: Uuid,
        before: Option<i64>,
    },
    PaletteFiles {
        target_id: Uuid,
        result_id: Uuid,
        offset: usize,
        limit: usize,
    },
    RunMetadata {
        request: MetadataRequest,
    },
    MetadataStatus {
        target_id: Uuid,
    },
    MetadataHistory {
        target_id: Uuid,
        before: Option<i64>,
    },
    MetadataFiles {
        target_id: Uuid,
        result_id: Uuid,
        offset: usize,
        limit: usize,
    },
    MetadataLocation {
        target_id: Uuid,
        result_id: Uuid,
        version_id: Uuid,
    },
    ComparisonChoices {
        target_id: Uuid,
        link_id: Uuid,
        source_revision: Option<String>,
        offset: usize,
        limit: usize,
    },
    RunComparison {
        request: ComparisonRequest,
    },
    EditorPreview {
        request: EditorPreviewRequest,
    },
    EditorExport {
        request: EditorExportRequest,
    },
    ComparisonStatus {
        target_id: Uuid,
    },
    ComparisonHistory {
        target_id: Uuid,
        before: Option<i64>,
    },
    ComparisonLines {
        target_id: Uuid,
        result_id: Uuid,
        offset: usize,
        limit: usize,
    },
    ComparisonPreview {
        target_id: Uuid,
        result_id: Uuid,
        side: ComparisonSide,
    },
    ReplaceAsset {
        request: ReplaceAssetRequest,
    },
    ImportEditedDocument {
        request: ReplaceAssetRequest,
    },
    ReadAssetText {
        node_id: Uuid,
        version_id: Uuid,
    },
    EditTextAsset {
        request: EditTextAssetRequest,
    },
    AssetDetails {
        node_id: Uuid,
        version_id: Uuid,
    },
    PreviewAsset {
        node_id: Uuid,
        version_id: Uuid,
    },
    ExportAsset {
        node_id: Uuid,
        version_id: Uuid,
        destination: PathBuf,
    },
    SaveViewport {
        viewport: Viewport,
    },
    History {
        before: Option<i64>,
        limit: u16,
    },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Response {
    id: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<CommandError>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CommandError {
    code: &'static str,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    current_revision: Option<i64>,
}

fn execute(
    state: &mut Option<Project>,
    diagnostics: &mut Option<Diagnostics>,
    settings: &mut Option<ProfileSettings>,
    command: Command,
    observe_import: impl FnMut(ImportProgress) -> Result<()>,
    mut observe_analysis: impl FnMut(AnalysisPhase) -> Result<()>,
) -> Result<Value> {
    match command {
        Command::SettingsOpen { profile } => {
            if settings.is_some() {
                return Err(Error::Invalid("A settings profile is already open"));
            }
            *settings = Some(ProfileSettings::open(&profile)?);
            Ok(Value::Null)
        }
        Command::SettingsRead => Ok(serde_json::to_value(settings_store(settings)?.read()?)?),
        Command::SettingsSave {
            base_revision,
            preferences,
        } => Ok(serde_json::to_value(
            settings_store(settings)?.replace(base_revision, preferences)?,
        )?),
        Command::SettingsBackupExport {
            destination,
            base_revision,
        } => {
            let state = settings_store(settings)?.read()?;
            if state.revision != base_revision {
                return Err(Error::Link(
                    "SETTINGS_CHANGED",
                    "The settings changed. Refresh them and export again.",
                ));
            }
            Ok(serde_json::to_value(create_settings_backup(
                &destination,
                state.preferences,
            )?)?)
        }
        Command::SettingsBackupInspect { path } => {
            Ok(serde_json::to_value(inspect_settings_backup(&path)?)?)
        }
        Command::SettingsBackupRestore {
            path,
            archive_sha256,
            base_revision,
        } => {
            let preferences = read_settings_backup(&path, &archive_sha256)?;
            Ok(serde_json::to_value(
                settings_store(settings)?.replace(base_revision, preferences)?,
            )?)
        }
        Command::DiagnosticsOpen { profile } => {
            if diagnostics.is_some() {
                return Err(Error::Invalid("Diagnostics are already open"));
            }
            *diagnostics = Some(Diagnostics::open(&profile)?);
            Ok(Value::Null)
        }
        Command::DiagnosticsRecord { observation } => {
            let space_low = diagnostics_store(diagnostics)?.record(observation)?;
            Ok(json!({ "spaceLow": space_low }))
        }
        Command::DiagnosticsPage { before } => Ok(serde_json::to_value(
            diagnostics_store(diagnostics)?.page(before)?,
        )?),
        Command::DiagnosticsExport {
            destination,
            update,
        } => {
            diagnostics_store(diagnostics)?.export(&destination, update.as_ref())?;
            Ok(Value::Null)
        }
        Command::Create { directory, title } => {
            let project = Project::create(&directory, title)?;
            let view = serde_json::to_value(project.view()?)?;
            *state = Some(project);
            Ok(view)
        }
        Command::Open {
            directory,
            expected_project_id,
        } => {
            let project = Project::open_expected(&directory, expected_project_id)?;
            let view = serde_json::to_value(project.view()?)?;
            *state = Some(project);
            Ok(view)
        }
        Command::Close => {
            *state = None;
            Ok(Value::Null)
        }
        Command::InspectBackup { path } => {
            Ok(serde_json::to_value(Project::inspect_backup(&path)?)?)
        }
        Command::RestoreBackup {
            path,
            destination,
            archive_sha256,
        } => Ok(serde_json::to_value(Project::restore_backup(
            &path,
            &destination,
            &archive_sha256,
        )?)?),
        operation => {
            let project = state.as_mut().ok_or(Error::Invalid("No project is open"))?;
            match operation {
                Command::View => Ok(serde_json::to_value(project.view()?)?),
                Command::VerifyProjectIntegrity => {
                    project.verify_integrity()?;
                    Ok(Value::Null)
                }
                Command::CreateBackup {
                    destination,
                    base_revision,
                } => Ok(serde_json::to_value(
                    project.create_backup(&destination, base_revision)?,
                )?),
                Command::DirectoryList { node_id, folder } => Ok(serde_json::to_value(
                    project.directory_listing(node_id, &folder)?,
                )?),
                Command::DirectoryChange {
                    node_id,
                    base_revision,
                    change,
                } => {
                    project.change_directory(node_id, base_revision, change)?;
                    Ok(Value::Null)
                }
                Command::GitCheck { node_id } => {
                    project.check_git_card(node_id)?;
                    Ok(Value::Null)
                }
                Command::GitRead {
                    node_id,
                    repository,
                } => {
                    project.check_git_card(node_id)?;
                    Ok(serde_json::to_value(git::inspect(&repository)?)?)
                }
                Command::GitDiff {
                    node_id,
                    repository,
                    path,
                    side,
                    revision,
                } => {
                    project.check_git_card(node_id)?;
                    Ok(serde_json::to_value(git::diff(
                        &repository,
                        &path,
                        side,
                        &revision,
                    )?)?)
                }
                Command::GitMutate {
                    node_id,
                    repository,
                    revision,
                    action,
                } => {
                    project.check_git_card(node_id)?;
                    Ok(serde_json::to_value(git::mutate(
                        &repository,
                        &revision,
                        action,
                    )?)?)
                }
                Command::Apply { request } => Ok(
                    json!({ "revision": project.apply_with_pdf_extractor(request, pdf_worker::extract)? }),
                ),
                Command::ImportAssets {
                    request,
                    gallery_id,
                } => Ok(serde_json::to_value(project.import_batch_with_progress(
                    request,
                    gallery_id,
                    observe_import,
                )?)?),
                Command::GalleryPage {
                    node_id,
                    source_revision,
                    offset,
                    limit,
                } => Ok(serde_json::to_value(project.gallery_page(
                    node_id,
                    source_revision.as_deref(),
                    offset,
                    limit,
                )?)?),
                Command::GalleryPreview {
                    node_id,
                    source_revision,
                    version_id,
                } => Ok(serde_json::to_value(project.gallery_preview(
                    node_id,
                    &source_revision,
                    version_id,
                )?)?),
                Command::ExportGalleryVideo {
                    node_id,
                    source_revision,
                    version_id,
                    destination,
                } => {
                    project.export_gallery_video(
                        node_id,
                        &source_revision,
                        version_id,
                        &destination,
                    )?;
                    Ok(Value::Null)
                }
                Command::LinkedAssets {
                    target_id,
                    link_id,
                    source_revision,
                    offset,
                    limit,
                } => Ok(serde_json::to_value(project.linked_assets(
                    target_id,
                    link_id,
                    source_revision.as_deref(),
                    offset,
                    limit,
                )?)?),
                Command::LinkedText {
                    target_id,
                    link_id,
                    source_revision,
                } => Ok(serde_json::to_value(project.linked_text(
                    target_id,
                    link_id,
                    source_revision.as_deref(),
                )?)?),
                Command::ResearchStatus { target_id } => {
                    Ok(serde_json::to_value(project.research_status(target_id)?)?)
                }
                Command::ResearchTranscription {
                    request,
                    destination,
                    ..
                } => Ok(serde_json::to_value(project.research_transcription(
                    &request,
                    destination.as_deref(),
                    || observe_analysis(AnalysisPhase::Working),
                )?)?),
                Command::ModelContext { request } => {
                    Ok(serde_json::to_value(project.model_context(request)?)?)
                }
                Command::ResearchPreview {
                    target_id,
                    source_id,
                    revision,
                } => Ok(serde_json::to_value(
                    project.research_preview(target_id, source_id, &revision)?,
                )?),
                Command::ExportResearchAudio {
                    project_id,
                    target_id,
                    source_id,
                    revision,
                    destination,
                } => {
                    project.export_research_audio(
                        project_id,
                        target_id,
                        source_id,
                        &revision,
                        &destination,
                    )?;
                    Ok(Value::Null)
                }
                Command::ChecklistCompletions {
                    node_id,
                    source_revision,
                    offset,
                    limit,
                } => Ok(serde_json::to_value(project.checklist_completions(
                    node_id,
                    source_revision.as_deref(),
                    offset,
                    limit,
                )?)?),
                Command::DatasetRead { path } => Ok(serde_json::to_value(
                    forge_core::dataset::read_input(&path)?,
                )?),
                Command::DatasetPreview { text, options } => Ok(serde_json::to_value(
                    forge_core::dataset::preview(&text, &options),
                )?),
                Command::DatasetPage { node_id, query } => Ok(serde_json::to_value(
                    project.dataset_page(node_id, &query)?,
                )?),
                Command::DatasetExport {
                    node_id,
                    source_revision,
                    delimiter,
                    destination,
                } => {
                    project.export_dataset(node_id, &source_revision, delimiter, &destination)?;
                    Ok(Value::Null)
                }
                Command::SchemeRead { path } => Ok(serde_json::to_value(
                    forge_core::scheme::read_input(&path)?,
                )?),
                Command::SchemeGraph {
                    node_id,
                    source_revision,
                } => Ok(serde_json::to_value(
                    project.scheme_graph(node_id, source_revision.as_deref())?,
                )?),
                Command::SchemeExport {
                    node_id,
                    base_revision,
                    destination,
                } => {
                    project.export_scheme(node_id, base_revision, &destination)?;
                    Ok(Value::Null)
                }
                Command::RunPalette { request } => Ok(serde_json::to_value(
                    project.run_palette(&request, observe_analysis)?,
                )?),
                Command::PaletteStatus { target_id } => {
                    Ok(serde_json::to_value(project.palette_status(target_id)?)?)
                }
                Command::PaletteHistory { target_id, before } => Ok(serde_json::to_value(
                    project.palette_history(target_id, before)?,
                )?),
                Command::PaletteFiles {
                    target_id,
                    result_id,
                    offset,
                    limit,
                } => Ok(serde_json::to_value(
                    project.palette_files(target_id, result_id, offset, limit)?,
                )?),
                Command::RunMetadata { request } => Ok(serde_json::to_value(
                    project.run_metadata(&request, observe_analysis)?,
                )?),
                Command::MetadataStatus { target_id } => {
                    Ok(serde_json::to_value(project.metadata_status(target_id)?)?)
                }
                Command::MetadataHistory { target_id, before } => Ok(serde_json::to_value(
                    project.metadata_history(target_id, before)?,
                )?),
                Command::MetadataFiles {
                    target_id,
                    result_id,
                    offset,
                    limit,
                } => Ok(serde_json::to_value(
                    project.metadata_files(target_id, result_id, offset, limit)?,
                )?),
                Command::MetadataLocation {
                    target_id,
                    result_id,
                    version_id,
                } => Ok(serde_json::to_value(
                    project.metadata_location(target_id, result_id, version_id)?,
                )?),
                Command::ComparisonChoices {
                    target_id,
                    link_id,
                    source_revision,
                    offset,
                    limit,
                } => Ok(serde_json::to_value(project.comparison_choices(
                    target_id,
                    link_id,
                    source_revision.as_deref(),
                    offset,
                    limit,
                )?)?),
                Command::RunComparison { request } => Ok(serde_json::to_value(
                    project.run_comparison_with_pdf_extractor(
                        &request,
                        observe_analysis,
                        pdf_worker::extract_with_checkpoint,
                    )?,
                )?),
                Command::EditorPreview { request } => Ok(serde_json::to_value(
                    project.editor_preview(&request, observe_analysis)?,
                )?),
                Command::EditorExport { request } => Ok(serde_json::to_value(
                    project.editor_export(&request, observe_analysis)?,
                )?),
                Command::ComparisonStatus { target_id } => {
                    Ok(serde_json::to_value(project.comparison_status(target_id)?)?)
                }
                Command::ComparisonHistory { target_id, before } => Ok(serde_json::to_value(
                    project.comparison_history(target_id, before)?,
                )?),
                Command::ComparisonLines {
                    target_id,
                    result_id,
                    offset,
                    limit,
                } => Ok(serde_json::to_value(
                    project.comparison_lines(target_id, result_id, offset, limit)?,
                )?),
                Command::ComparisonPreview {
                    target_id,
                    result_id,
                    side,
                } => Ok(serde_json::to_value(
                    project.comparison_preview(target_id, result_id, side)?,
                )?),
                Command::ReplaceAsset { request } => {
                    Ok(json!({ "revision": project.replace_asset(request)? }))
                }
                Command::ImportEditedDocument { request } => {
                    Ok(json!({ "revision": project.import_edited_document(request)? }))
                }
                Command::ReadAssetText {
                    node_id,
                    version_id,
                } => Ok(Value::String(project.read_asset_text(node_id, version_id)?)),
                Command::EditTextAsset { request } => {
                    Ok(json!({ "revision": project.edit_text_asset(request)? }))
                }
                Command::AssetDetails {
                    node_id,
                    version_id,
                } => Ok(serde_json::to_value(
                    project.asset_details(node_id, version_id)?,
                )?),
                Command::PreviewAsset {
                    node_id,
                    version_id,
                } => Ok(serde_json::to_value(
                    project.preview_asset(node_id, version_id)?,
                )?),
                Command::ExportAsset {
                    node_id,
                    version_id,
                    destination,
                } => {
                    project.export_asset(node_id, version_id, &destination)?;
                    Ok(Value::Null)
                }
                Command::SaveViewport { viewport } => {
                    project.save_viewport(viewport)?;
                    Ok(Value::Null)
                }
                Command::History { before, limit } => {
                    Ok(serde_json::to_value(project.revisions(before, limit)?)?)
                }
                Command::Open { .. }
                | Command::Create { .. }
                | Command::Close
                | Command::InspectBackup { .. }
                | Command::RestoreBackup { .. }
                | Command::DiagnosticsOpen { .. }
                | Command::DiagnosticsRecord { .. }
                | Command::DiagnosticsPage { .. }
                | Command::DiagnosticsExport { .. }
                | Command::SettingsOpen { .. }
                | Command::SettingsRead
                | Command::SettingsSave { .. }
                | Command::SettingsBackupExport { .. }
                | Command::SettingsBackupInspect { .. }
                | Command::SettingsBackupRestore { .. } => unreachable!(),
            }
        }
    }
}

fn diagnostics_store(store: &mut Option<Diagnostics>) -> Result<&mut Diagnostics> {
    store.as_mut().ok_or(Error::Link(
        "LOGS_UNAVAILABLE",
        "Forge diagnostics are unavailable",
    ))
}

fn settings_store(store: &mut Option<ProfileSettings>) -> Result<&mut ProfileSettings> {
    store.as_mut().ok_or(Error::Link(
        "SETTINGS_UNAVAILABLE",
        "Forge settings are unavailable",
    ))
}

fn read_input(sender: &SyncSender<io::Result<Option<Incoming>>>) -> io::Result<()> {
    let mut input = io::stdin().lock();
    let mut line = Vec::new();
    let mut operations = HashMap::<(bool, Uuid), Weak<AtomicU8>>::new();
    loop {
        line.clear();
        let count = (&mut input)
            .take((MAX_LINE + 1) as u64)
            .read_until(b'\n', &mut line)?;
        if count == 0 {
            return Ok(());
        }
        if count > MAX_LINE {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "Forge input limit exceeded",
            ));
        }
        operations.retain(|_, state| state.strong_count() > 0);
        let incoming = match serde_json::from_slice::<InputFrame>(&line) {
            Ok(InputFrame::Request(request)) => {
                let operation_id = match &request.command {
                    Command::ImportAssets { request, .. } => Some((false, request.operation_id)),
                    Command::RunPalette { request } => Some((true, request.operation_id)),
                    Command::RunMetadata { request } => Some((true, request.operation_id)),
                    Command::RunComparison { request } => Some((true, request.operation_id)),
                    Command::EditorPreview { request } => Some((true, request.operation_id)),
                    Command::EditorExport { request } => Some((true, request.operation_id)),
                    Command::ResearchTranscription {
                        operation_id: Some(id),
                        ..
                    } => Some((true, *id)),
                    _ => None,
                };
                let operation_state = operation_id.map(|key| {
                    let entry = operations.entry(key).or_default();
                    let state = entry
                        .upgrade()
                        .unwrap_or_else(|| Arc::new(AtomicU8::new(RUNNING)));
                    *entry = Arc::downgrade(&state);
                    state
                });
                Some(Incoming {
                    request: *request,
                    operation_state,
                })
            }
            Ok(InputFrame::Cancel(cancel)) => {
                let key = match cancel {
                    Cancel::Import(id) => (false, id),
                    Cancel::Analysis(id) => (true, id),
                };
                if let Some(state) = operations.get(&key).and_then(Weak::upgrade) {
                    let _ = state.compare_exchange(
                        RUNNING,
                        CANCELED,
                        Ordering::AcqRel,
                        Ordering::Acquire,
                    );
                }
                continue;
            }
            Err(_) => None,
        };
        if sender.send(Ok(incoming)).is_err() {
            return Ok(());
        }
    }
}

fn write_frame(output: &mut impl Write, frame: &impl Serialize) -> io::Result<()> {
    serde_json::to_writer(&mut *output, frame)?;
    output.write_all(b"\n")?;
    output.flush()
}

fn send_import_progress(
    id: u64,
    state: &AtomicU8,
    output: &mut impl Write,
) -> impl FnMut(ImportProgress) -> Result<()> {
    let mut last = None;
    let mut sent_at = Instant::now();
    move |progress| {
        if matches!(progress, ImportProgress::Committing { .. }) {
            // The competing successful CAS defines whether this batch will roll back or commit.
            // A repeated request with the same ID may already be committing.
            if state.compare_exchange(RUNNING, COMMITTING, Ordering::AcqRel, Ordering::Acquire)
                == Err(CANCELED)
            {
                return Err(Error::ImportCanceled);
            }
        } else if state.load(Ordering::Acquire) == CANCELED {
            return Err(Error::ImportCanceled);
        }
        let milestone = match (last, progress) {
            (
                Some(ImportProgress::Copying {
                    file_index: previous,
                    bytes,
                    file_bytes: size,
                    ..
                }),
                ImportProgress::Copying {
                    file_index,
                    bytes: current,
                    file_bytes,
                    ..
                },
            ) => previous != file_index || size != file_bytes || bytes == 0 && current > 0,
            _ => true,
        };
        if milestone || sent_at.elapsed() >= Duration::from_millis(75) {
            write_frame(output, &json!({ "id": id, "progress": progress }))
                .map_err(|_| Error::ImportCanceled)?;
            sent_at = Instant::now();
            last = Some(progress);
        }
        Ok(())
    }
}

fn check_analysis(state: &AtomicU8, phase: AnalysisPhase) -> Result<()> {
    let canceled = match phase {
        AnalysisPhase::Working => state.load(Ordering::Acquire) == CANCELED,
        AnalysisPhase::Committing => {
            state.compare_exchange(RUNNING, COMMITTING, Ordering::AcqRel, Ordering::Acquire)
                == Err(CANCELED)
        }
    };
    if canceled {
        Err(Error::AnalysisCanceled)
    } else {
        Ok(())
    }
}

fn main() -> io::Result<()> {
    if std::env::args_os().nth(1).as_deref() == Some(std::ffi::OsStr::new(pdf_worker::ARGUMENT)) {
        return pdf_worker::run();
    }
    #[cfg(windows)]
    if std::env::args_os().nth(1).as_deref() == Some(std::ffi::OsStr::new("--open-with")) {
        std::process::exit(open_with::run());
    }

    let (sender, receiver) = mpsc::sync_channel(8);
    std::thread::spawn(move || {
        if let Err(error) = read_input(&sender) {
            let _ = sender.send(Err(error));
        }
    });
    let mut output = io::BufWriter::new(io::stdout().lock());
    let mut project = None;
    let mut diagnostics = None;
    let mut settings = None;
    for incoming in receiver {
        let response = match incoming? {
            Some(Incoming {
                request,
                operation_state,
            }) => {
                let fallback = AtomicU8::new(RUNNING);
                let control = operation_state.as_deref().unwrap_or(&fallback);
                let observer = send_import_progress(request.id, control, &mut output);
                let result = execute(
                    &mut project,
                    &mut diagnostics,
                    &mut settings,
                    request.command,
                    observer,
                    |phase| check_analysis(control, phase),
                );
                match result {
                    Ok(value) => Response {
                        id: Some(request.id),
                        result: Some(value),
                        error: None,
                    },
                    Err(error) => {
                        let current_revision = match &error {
                            Error::StaleRevision { current } => Some(*current),
                            _ => None,
                        };
                        Response {
                            id: Some(request.id),
                            result: None,
                            error: Some(CommandError {
                                code: error.code(),
                                message: error.to_string(),
                                current_revision,
                            }),
                        }
                    }
                }
            }
            None => Response {
                id: None,
                result: None,
                error: Some(CommandError {
                    code: "INVALID_INPUT",
                    message: "Malformed Forge command".into(),
                    current_revision: None,
                }),
            },
        };
        write_frame(&mut output, &response)?;
    }
    Ok(())
}
