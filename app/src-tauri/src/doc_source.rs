//! Device-local document sources. Paths and persisted Android grants stay here.

use serde::Serialize;
use tauri::AppHandle;

#[cfg(target_os = "android")]
use tauri_plugin_gallerysave::GallerySaveExt;

#[derive(Debug, Serialize)]
pub struct SourcePick {
    kind: &'static str,
    location: String,
    name: String,
    size: Option<u64>,
    modified: Option<u64>,
}

#[derive(Debug, Serialize)]
pub struct SourceStat {
    size: Option<u64>,
    modified: Option<u64>,
}

#[derive(Debug, Serialize)]
pub struct FolderPick {
    kind: &'static str,
    location: String,
    name: String,
}

#[derive(Debug, Serialize)]
pub struct FolderEntry {
    kind: &'static str,
    location: String,
    name: String,
    size: Option<u64>,
    modified: Option<u64>,
    relative: String,
}

#[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
fn path_stat(path: &std::path::Path) -> Result<Option<SourceStat>, String> {
    match std::fs::metadata(path) {
        Ok(meta) if meta.is_file() => Ok(Some(SourceStat {
            size: Some(meta.len()),
            modified: meta.modified().ok()
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .and_then(|duration| u64::try_from(duration.as_millis()).ok()),
        })),
        Ok(_) => Ok(None),
        Err(err) if matches!(err.kind(), std::io::ErrorKind::NotFound | std::io::ErrorKind::PermissionDenied) => Ok(None),
        Err(err) => Err(format!("stat document source: {err}")),
    }
}

#[tauri::command]
pub async fn pick_document_source(app: AppHandle, only: Option<String>) -> Result<Option<SourcePick>, String> {
    #[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
    {
        use tauri_plugin_dialog::DialogExt;
        // The Web pad's Load offers HTML pages only; the app still checks what comes back.
        let dialog = app.dialog().file();
        let dialog = if only.as_deref() == Some("web") {
            dialog.add_filter("Web pages", &["html", "htm"])
        } else {
            dialog.add_filter("Documents", &[
                    "pdf", "epub", "md", "markdown", "mdown", "mkd",
                    "py", "pyi", "pyw", "js", "jsx", "mjs", "cjs", "ts", "tsx", "mts", "cts",
                    "rs", "go", "c", "h", "cpp", "cc", "cxx", "hpp", "hh", "hxx", "m", "mm",
                    "java", "kt", "kts", "swift", "rb", "php", "cs", "fs", "fsx", "scala", "sc",
                    "hs", "lhs", "lua", "r", "jl", "sql", "sh", "bash", "zsh", "fish", "ps1", "psm1",
                    "bat", "cmd", "yaml", "yml", "toml", "json", "jsonc", "json5", "xml", "xsl", "xslt",
                    "svg", "css", "scss", "sass", "less", "html", "htm", "xhtml", "vue", "svelte", "astro",
                    "mdx", "graphql", "gql", "proto", "tf", "hcl", "nix", "zig", "dart", "ex", "exs",
                    "erl", "hrl", "clj", "cljs", "cljc", "edn", "lisp", "el", "scm", "rkt", "ml", "mli",
                    "sv", "vhd", "vhdl", "asm", "s", "pl", "pm", "groovy", "gradle", "cmake", "diff", "patch",
                    "ini", "cfg", "conf", "env", "properties", "gitignore", "dockerignore", "editorconfig",
                    "txt", "log", "csv", "tsv", "wat", "sol", "move", "cairo", "lean", "adb", "ads", "d",
                    "pas", "pp", "f", "f90", "f95", "for", "cob", "cbl", "nim", "cr", "v",
                ])
        };
        let picked = dialog
            .add_filter("All files", &["*"])
            .blocking_pick_file();
        let Some(picked) = picked else { return Ok(None) };
        let path = picked.into_path().map_err(|err| format!("document path: {err}"))?;
        let stat = path_stat(&path)?.ok_or("Document source is unavailable")?;
        let name = path.file_name().map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| "document".into());
        return Ok(Some(SourcePick {
            kind: "path", location: path.to_string_lossy().into_owned(), name,
            size: stat.size, modified: stat.modified,
        }));
    }
    #[cfg(target_os = "android")]
    {
        // Android providers often mislabel HTML, so the picker stays open to any file.
        let _ = only;
        let picked = app.gallery_save().ok_or("gallery save plugin unavailable")?
            .pick_document().map_err(|err| err.to_string())?;
        if picked.uri.is_empty() { return Ok(None) }
        return Ok(Some(SourcePick {
            kind: "uri", location: picked.uri,
            name: picked.name.unwrap_or_else(|| "document".into()),
            size: picked.size, modified: picked.modified,
        }));
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux", target_os = "android")))]
    {
        let _ = (app, only);
        Ok(None)
    }
}

#[tauri::command]
pub async fn pick_source_folder(app: AppHandle) -> Result<Option<FolderPick>, String> {
    #[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
    {
        use tauri_plugin_dialog::DialogExt;
        let picked = app.dialog().file().blocking_pick_folder();
        let Some(picked) = picked else { return Ok(None) };
        let path = picked.into_path().map_err(|err| format!("folder path: {err}"))?;
        let name = path.file_name().map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.to_string_lossy().into_owned());
        return Ok(Some(FolderPick {
            kind: "path", location: path.to_string_lossy().into_owned(), name,
        }));
    }
    #[cfg(target_os = "android")]
    {
        let picked = app.gallery_save().ok_or("gallery save plugin unavailable")?
            .pick_folder_info().map_err(|err| err.to_string())?;
        if picked.uri.is_empty() { return Ok(None) }
        let name = picked.name.unwrap_or_else(|| picked.uri.rsplit('/').next().unwrap_or("folder").into());
        return Ok(Some(FolderPick { kind: "uri", location: picked.uri, name }));
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux", target_os = "android")))]
    {
        let _ = app;
        Ok(None)
    }
}

#[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
fn list_path_folder(root: &std::path::Path, directory: &std::path::Path, depth: usize, entries: &mut Vec<FolderEntry>) -> Result<(), String> {
    for entry in std::fs::read_dir(directory).map_err(|err| format!("list source folder: {err}"))? {
        let entry = entry.map_err(|err| format!("list source folder: {err}"))?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') { continue }
        let file_type = entry.file_type().map_err(|err| format!("source folder entry: {err}"))?;
        let path = entry.path();
        if file_type.is_dir() {
            if depth < 3 { list_path_folder(root, &path, depth + 1, entries)?; }
        } else if file_type.is_file() {
            let Some(stat) = path_stat(&path)? else { continue };
            let relative = path.strip_prefix(root).map_err(|err| format!("source relative path: {err}"))?
                .components().map(|part| part.as_os_str().to_string_lossy().into_owned())
                .collect::<Vec<_>>().join("/");
            entries.push(FolderEntry {
                kind: "path", location: path.to_string_lossy().into_owned(), name,
                size: stat.size, modified: stat.modified, relative,
            });
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn list_source_folder(app: AppHandle, kind: String, location: String) -> Result<Vec<FolderEntry>, String> {
    #[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
    {
        let _ = app;
        if kind != "path" { return Err("Source folder must be a path on desktop".into()) }
        let root = std::path::Path::new(&location);
        let mut entries = Vec::new();
        list_path_folder(root, root, 0, &mut entries)?;
        return Ok(entries);
    }
    #[cfg(target_os = "android")]
    {
        if kind != "uri" { return Err("Source folder must be a URI on Android".into()) }
        let entries = app.gallery_save().ok_or("gallery save plugin unavailable")?
            .list_folder(&location).map_err(|err| err.to_string())?;
        return Ok(entries.into_iter().map(|entry| FolderEntry {
            kind: "uri", location: entry.uri, name: entry.name,
            size: entry.size, modified: entry.modified, relative: entry.relative,
        }).collect());
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux", target_os = "android")))]
    {
        let _ = (app, kind, location);
        Err("Source folders are unavailable on this platform".into())
    }
}

#[tauri::command]
pub async fn stat_document_source(app: AppHandle, kind: String, location: String) -> Result<Option<SourceStat>, String> {
    #[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
    {
        let _ = app;
        if kind != "path" { return Ok(None) }
        return path_stat(std::path::Path::new(&location));
    }
    #[cfg(target_os = "android")]
    {
        if kind != "uri" { return Ok(None) }
        let stat = app.gallery_save().ok_or("gallery save plugin unavailable")?
            .stat_document(&location).map_err(|err| err.to_string())?;
        return Ok(stat.exists.then_some(SourceStat { size: stat.size, modified: stat.modified }));
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux", target_os = "android")))]
    {
        let _ = (app, kind, location);
        Ok(None)
    }
}

#[tauri::command]
pub async fn read_document_source(app: AppHandle, kind: String, location: String) -> Result<tauri::ipc::Response, String> {
    #[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
    {
        let _ = app;
        if kind != "path" { return Err("Document source must be a path on desktop".into()) }
        let bytes = std::fs::read(&location).map_err(|err| format!("read document source: {err}"))?;
        return Ok(tauri::ipc::Response::new(bytes));
    }
    #[cfg(target_os = "android")]
    {
        use base64::Engine as _;
        if kind != "uri" { return Err("Document source must be a URI on Android".into()) }
        let data = app.gallery_save().ok_or("gallery save plugin unavailable")?
            .read_document(&location).map_err(|err| err.to_string())?;
        let bytes = base64::engine::general_purpose::STANDARD.decode(data.as_bytes())
            .map_err(|err| format!("invalid document base64: {err}"))?;
        return Ok(tauri::ipc::Response::new(bytes));
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux", target_os = "android")))]
    {
        let _ = (app, kind, location);
        Err("Document sources are unavailable on this platform".into())
    }
}
