//! Files beside a local HTML document, for its live page.
//!
//! A local page runs in a sandboxed `srcdoc` frame, so `3.7.mp4` or
//! `official/p-1.png` resolve against nothing. Opening the page registers the
//! folder of its linked file under a random token, and the `lcasset` protocol
//! serves that folder and its subfolders, nothing above it. Byte ranges are
//! honoured so a video can seek without being read whole.

use std::collections::HashMap;
use std::sync::Mutex;

use serde::Serialize;
use tauri::http::{header, Request, Response, StatusCode};
use tauri::{AppHandle, Manager};

#[cfg(target_os = "android")]
use tauri_plugin_gallerysave::GallerySaveExt;

pub const SCHEME: &str = "lcasset";

/// A whole file is sent only up to this size; past it, as if `bytes=0-` was asked.
const WHOLE_LIMIT: u64 = 64 * 1024 * 1024;
/// Largest slice per ranged response: a media loader's `bytes=N-` is answered
/// to its end, a lecture video in one go, rather than over many requests.
const CHUNK: u64 = 64 * 1024 * 1024;

#[derive(Clone, PartialEq, Eq)]
enum Root {
    /// The canonical folder on a desktop file system.
    #[cfg(not(target_os = "android"))]
    Path(std::path::PathBuf),
    /// A folder inside a document tree this app holds a grant on.
    #[cfg(target_os = "android")]
    Tree { tree: String, dir: String },
}

#[derive(Default)]
pub struct HtmlAssets {
    roots: Mutex<HashMap<String, Root>>,
    /// Android: files the plugin opened, by `<token>/<path>`, read here from then on.
    #[cfg(target_os = "android")]
    files: Mutex<HashMap<String, std::sync::Arc<std::fs::File>>>,
}

impl HtmlAssets {
    /// One token per folder for the life of the app; opening again reuses it.
    fn register(&self, root: Root) -> String {
        let mut roots = self.roots.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some((token, _)) = roots.iter().find(|(_, known)| **known == root) {
            return token.clone();
        }
        let token = new_token();
        roots.insert(token.clone(), root);
        token
    }

    fn root(&self, token: &str) -> Option<Root> {
        self.roots.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).get(token).cloned()
    }
}

/// 128 unguessable bits: other web views in the app can reach the scheme too.
fn new_token() -> String {
    use std::hash::{BuildHasher, Hasher};
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos()).unwrap_or_default();
    (0..2u64).map(|salt| {
        let mut hasher = std::collections::hash_map::RandomState::new().build_hasher();
        hasher.write_u64(salt);
        hasher.write_u128(nanos);
        format!("{:016x}", hasher.finish())
    }).collect()
}

#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum FolderAccess {
    Ready { token: String },
    /// Android: only the file itself was granted. Its folder has to be picked.
    #[serde(rename_all = "camelCase")]
    NeedsAccess { folder: Option<String> },
    /// Android: the folder picked for the grant does not hold the file.
    WrongFolder,
    Unavailable,
}

/// Make the folder of a linked HTML file reachable from its live page.
#[tauri::command]
pub async fn open_html_folder(app: AppHandle, kind: String, location: String) -> Result<FolderAccess, String> {
    #[cfg(not(target_os = "android"))]
    {
        if kind != "path" { return Ok(FolderAccess::Unavailable) }
        let Some(folder) = std::path::Path::new(&location).parent() else { return Ok(FolderAccess::Unavailable) };
        let Ok(folder) = folder.canonicalize() else { return Ok(FolderAccess::Unavailable) };
        if !folder.is_dir() { return Ok(FolderAccess::Unavailable) }
        let token = app.state::<HtmlAssets>().register(Root::Path(folder));
        Ok(FolderAccess::Ready { token })
    }
    #[cfg(target_os = "android")]
    {
        if kind != "uri" { return Ok(FolderAccess::Unavailable) }
        let found = app.gallery_save().ok_or("gallery save plugin unavailable")?
            .html_folder(&location).map_err(|err| err.to_string())?;
        Ok(access(&app, found))
    }
}

/// Android: ask for the folder of a file that was granted on its own.
#[tauri::command]
pub async fn grant_html_folder(app: AppHandle, location: String) -> Result<FolderAccess, String> {
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, location);
        Ok(FolderAccess::Unavailable)
    }
    #[cfg(target_os = "android")]
    {
        let found = app.gallery_save().ok_or("gallery save plugin unavailable")?
            .grant_html_folder(&location).map_err(|err| err.to_string())?;
        Ok(if found.wrong_folder { FolderAccess::WrongFolder }
            else if found.tree.is_some() { access(&app, found) }
            else { FolderAccess::Unavailable })
    }
}

#[cfg(target_os = "android")]
fn access(app: &AppHandle, found: tauri_plugin_gallerysave::HtmlFolder) -> FolderAccess {
    match (found.tree, found.dir) {
        (Some(tree), Some(dir)) => FolderAccess::Ready { token: app.state::<HtmlAssets>().register(Root::Tree { tree, dir }) },
        _ if found.needs_access => FolderAccess::NeedsAccess { folder: found.folder },
        _ => FolderAccess::Unavailable,
    }
}

/// The path under the token, one decoded segment each. None for anything that
/// could leave the folder: `..`, separators or drive letters inside a segment.
fn relative_segments(encoded: &str) -> Option<Vec<String>> {
    let segments = encoded.split('/').map(percent_decode).collect::<Option<Vec<_>>>()?;
    let valid = |segment: &String| !segment.is_empty() && segment != "." && segment != ".."
        && !segment.contains(['/', '\\', ':', '\0']);
    (!segments.is_empty() && segments.iter().all(valid)).then_some(segments)
}

fn percent_decode(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at] == b'%' {
            let hex = std::str::from_utf8(bytes.get(at + 1..at + 3)?).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            at += 3;
        } else {
            out.push(bytes[at]);
            at += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// A single `bytes=` range: `a-b`, `a-` or the last `n` bytes as `-n`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ByteRange { From(u64, Option<u64>), Last(u64) }

fn parse_range(value: &str) -> Option<ByteRange> {
    let spec = value.trim().strip_prefix("bytes=")?;
    if spec.contains(',') { return None }
    let (start, end) = spec.split_once('-')?;
    let (start, end) = (start.trim(), end.trim());
    if start.is_empty() { return end.parse().ok().filter(|n| *n > 0).map(ByteRange::Last) }
    let start = start.parse().ok()?;
    let end = if end.is_empty() { None } else { Some(end.parse().ok()?) };
    if end.is_some_and(|end| end < start) { return None }
    Some(ByteRange::From(start, end))
}

/// The slice to send, capped at `CHUNK`, or None when it starts past the end.
fn slice(range: ByteRange, size: u64) -> Option<(u64, u64)> {
    let (start, end) = match range {
        ByteRange::From(start, end) => (start, end.unwrap_or(u64::MAX).min(size.checked_sub(1)?)),
        ByteRange::Last(count) => (size.checked_sub(count.min(size))?, size.checked_sub(1)?),
    };
    (start <= end).then(|| (start, end.min(start + CHUNK - 1)))
}

fn mime_for(name: &str) -> &'static str {
    let extension = name.rsplit_once('.').map(|(_, ext)| ext.to_ascii_lowercase()).unwrap_or_default();
    match extension.as_str() {
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "ogv" => "video/ogg",
        "mov" => "video/quicktime",
        "mp3" => "audio/mpeg",
        "m4a" => "audio/mp4",
        "wav" => "audio/wav",
        "ogg" | "oga" => "audio/ogg",
        "vtt" => "text/vtt",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        "bmp" => "image/bmp",
        "css" => "text/css",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        _ => "application/octet-stream",
    }
}

fn status(code: StatusCode) -> Response<Vec<u8>> {
    Response::builder().status(code).header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*").body(Vec::new())
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

/// Opened file: its size, and a way to read a slice of it.
trait Source {
    fn size(&self) -> u64;
    fn read(&mut self, start: u64, length: u64) -> Result<Vec<u8>, StatusCode>;
}

#[cfg(not(target_os = "android"))]
struct PathSource { file: std::fs::File, size: u64 }

#[cfg(not(target_os = "android"))]
impl Source for PathSource {
    fn size(&self) -> u64 { self.size }
    fn read(&mut self, start: u64, length: u64) -> Result<Vec<u8>, StatusCode> {
        use std::io::{Read, Seek, SeekFrom};
        self.file.seek(SeekFrom::Start(start)).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        let mut bytes = Vec::with_capacity(length as usize);
        (&mut self.file).take(length).read_to_end(&mut bytes).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        Ok(bytes)
    }
}

#[cfg(not(target_os = "android"))]
fn open(root: &Root, segments: &[String]) -> Result<PathSource, StatusCode> {
    let Root::Path(folder) = root;
    let path = segments.iter().fold(folder.clone(), |path, segment| path.join(segment));
    // A link inside the folder can still point out of it.
    let path = path.canonicalize().map_err(|_| StatusCode::NOT_FOUND)?;
    if !path.starts_with(folder) { return Err(StatusCode::FORBIDDEN) }
    let file = std::fs::File::open(&path).map_err(|_| StatusCode::NOT_FOUND)?;
    let meta = file.metadata().map_err(|_| StatusCode::NOT_FOUND)?;
    if !meta.is_file() { return Err(StatusCode::NOT_FOUND) }
    Ok(PathSource { file, size: meta.len() })
}

#[cfg(target_os = "android")]
struct FileSource { file: std::sync::Arc<std::fs::File>, size: u64 }

#[cfg(target_os = "android")]
impl Source for FileSource {
    fn size(&self) -> u64 { self.size }
    fn read(&mut self, start: u64, length: u64) -> Result<Vec<u8>, StatusCode> {
        use std::os::unix::fs::FileExt;
        let mut bytes = vec![0; length as usize];
        let mut filled = 0;
        while filled < bytes.len() {
            match self.file.read_at(&mut bytes[filled..], start + filled as u64) {
                Ok(0) => break,
                Ok(read) => filled += read,
                Err(err) if err.kind() == std::io::ErrorKind::Interrupted => {}
                Err(_) => return Err(StatusCode::INTERNAL_SERVER_ERROR),
            }
        }
        bytes.truncate(filled);
        Ok(bytes)
    }
}

/// The plugin finds and opens a file once and hands its descriptor over; every
/// read after that is a plain file read here, with nothing crossing the bridge.
#[cfg(target_os = "android")]
fn open(app: &AppHandle, token: &str, root: &Root, segments: &[String]) -> Result<FileSource, StatusCode> {
    use std::os::fd::FromRawFd;
    let Root::Tree { tree, dir } = root;
    let path = segments.join("/");
    let key = format!("{token}/{path}");
    let assets = app.state::<HtmlAssets>();
    let cached = assets.files.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).get(&key).cloned();
    if let Some(file) = cached {
        if let Ok(meta) = file.metadata() { return Ok(FileSource { file, size: meta.len() }) }
    }
    let opened = app.gallery_save().ok_or(StatusCode::INTERNAL_SERVER_ERROR)?
        .open_asset(tree, dir, &path).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let fd = opened.fd.filter(|_| opened.found).ok_or(StatusCode::NOT_FOUND)?;
    // SAFETY: the plugin detached this descriptor for this call; nothing else owns or closes it.
    let file = std::sync::Arc::new(unsafe { std::fs::File::from_raw_fd(fd) });
    let size = file.metadata().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?.len();
    let mut files = assets.files.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if files.len() >= 64 { files.clear() }
    files.insert(key, file.clone());
    Ok(FileSource { file, size })
}

/// The body for a ranged answer.
///
/// Android's WebView applies the request's Range itself to the stream it is
/// handed: it skips `start` bytes, then reads on. Handed the range alone, it
/// skipped past its end and failed every request that did not start at 0, so
/// a video's index at the end of the file never loaded and the player gave up.
/// There the body starts at byte 0; what is skipped is zero-filled, never read.
fn range_body(start: u64, bytes: Vec<u8>, from_zero: bool) -> Vec<u8> {
    if !from_zero || start == 0 { return bytes }
    let mut body = Vec::with_capacity(start as usize + bytes.len());
    body.resize(start as usize, 0);
    body.extend_from_slice(&bytes);
    body
}

/// Answer one `lcasset` request: `/<token>/<path inside the folder>`.
pub fn respond(app: &AppHandle, request: Request<Vec<u8>>) -> Response<Vec<u8>> {
    let path = request.uri().path().trim_start_matches('/');
    let Some((token, rest)) = path.split_once('/') else { return status(StatusCode::NOT_FOUND) };
    let Some(root) = app.state::<HtmlAssets>().root(token) else { return status(StatusCode::NOT_FOUND) };
    let Some(segments) = relative_segments(rest) else { return status(StatusCode::FORBIDDEN) };
    let name = segments.last().cloned().unwrap_or_default();
    #[cfg(not(target_os = "android"))]
    let source = open(&root, &segments);
    #[cfg(target_os = "android")]
    let source = open(app, token, &root, &segments);
    let mut source = match source { Ok(source) => source, Err(code) => return status(code) };
    let size = source.size();
    let asked = request.headers().get(header::RANGE).and_then(|value| value.to_str().ok());
    let range = match asked {
        Some(value) => match parse_range(value) { Some(range) => Some(range), None => return status(StatusCode::RANGE_NOT_SATISFIABLE) },
        None if size > WHOLE_LIMIT => Some(ByteRange::From(0, None)),
        None => None,
    };
    let builder = Response::builder()
        .header(header::CONTENT_TYPE, mime_for(&name))
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CACHE_CONTROL, "no-cache")
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*");
    let response = match range {
        None => source.read(0, size).map(|bytes| builder.status(StatusCode::OK).body(bytes)),
        Some(range) => match slice(range, size) {
            None => return Response::builder().status(StatusCode::RANGE_NOT_SATISFIABLE)
                .header(header::CONTENT_RANGE, format!("bytes */{size}")).body(Vec::new())
                .unwrap_or_else(|_| status(StatusCode::RANGE_NOT_SATISFIABLE)),
            Some((start, end)) => match source.read(start, end - start + 1) {
                // Shorter than its size said: changed while being read.
                Ok(bytes) if bytes.is_empty() => Err(StatusCode::INTERNAL_SERVER_ERROR),
                read => read.map(|bytes| builder
                    .status(StatusCode::PARTIAL_CONTENT)
                    .header(header::CONTENT_RANGE, format!("bytes {start}-{}/{size}", start + bytes.len() as u64 - 1))
                    .body(range_body(start, bytes, cfg!(target_os = "android")))),
            },
        },
    };
    match response {
        Ok(Ok(response)) => response,
        Ok(Err(_)) => status(StatusCode::INTERNAL_SERVER_ERROR),
        Err(code) => status(code),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_paths_inside_the_folder() {
        assert_eq!(relative_segments("official/hw3_p-1.png"), Some(vec!["official".into(), "hw3_p-1.png".into()]));
        assert_eq!(relative_segments("My%20Notes/a%2Bb.mp4"), Some(vec!["My Notes".into(), "a+b.mp4".into()]));
        for escape in ["../secret", "a/../../b", "%2e%2e/x", "a%2Fb", "a%5Cb", "C:/x", "", "a//b", "%zz"] {
            assert_eq!(relative_segments(escape), None, "{escape}");
        }
    }

    #[test]
    fn reads_single_byte_ranges() {
        assert_eq!(parse_range("bytes=0-"), Some(ByteRange::From(0, None)));
        assert_eq!(parse_range("bytes=10-19"), Some(ByteRange::From(10, Some(19))));
        assert_eq!(parse_range("bytes=-500"), Some(ByteRange::Last(500)));
        assert_eq!(parse_range("bytes=5-1"), None);
        assert_eq!(parse_range("bytes=0-1,4-5"), None);
        assert_eq!(parse_range("items=0-1"), None);
    }

    #[test]
    fn starts_the_android_body_at_byte_zero() {
        assert_eq!(range_body(3, vec![7, 8], true), vec![0, 0, 0, 7, 8]);
        assert_eq!(range_body(0, vec![7, 8], true), vec![7, 8]);
        assert_eq!(range_body(3, vec![7, 8], false), vec![7, 8]);
    }

    #[test]
    fn slices_within_the_file_and_the_chunk() {
        assert_eq!(slice(ByteRange::From(0, None), 100), Some((0, 99)));
        assert_eq!(slice(ByteRange::From(10, Some(500)), 100), Some((10, 99)));
        assert_eq!(slice(ByteRange::Last(30), 100), Some((70, 99)));
        assert_eq!(slice(ByteRange::Last(300), 100), Some((0, 99)));
        assert_eq!(slice(ByteRange::From(100, None), 100), None);
        assert_eq!(slice(ByteRange::From(0, None), 0), None);
        assert_eq!(slice(ByteRange::From(0, None), CHUNK * 3), Some((0, CHUNK - 1)));
    }
}
