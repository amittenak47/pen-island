use serde::{Deserialize, Serialize};
use tauri::Runtime;

use crate::{GallerySave, Result};

#[derive(Debug, Deserialize)]
pub struct DocumentPick {
    pub uri: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub size: Option<u64>,
    #[serde(default)]
    pub modified: Option<u64>,
}

#[derive(Debug, Deserialize)]
pub struct DocumentStat {
    pub exists: bool,
    #[serde(default)]
    pub size: Option<u64>,
    #[serde(default)]
    pub modified: Option<u64>,
}

#[derive(Debug, Deserialize)]
pub struct FolderPick {
    pub uri: String,
    #[serde(default)]
    pub name: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct FolderEntry {
    pub uri: String,
    pub name: String,
    #[serde(default)]
    pub size: Option<u64>,
    #[serde(default)]
    pub modified: Option<u64>,
    pub relative: String,
}

#[derive(Debug, Deserialize)]
struct FolderList {
    entries: Vec<FolderEntry>,
}

/// Where a linked HTML file's folder sits in a granted document tree.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HtmlFolder {
    #[serde(default)]
    pub tree: Option<String>,
    #[serde(default)]
    pub dir: Option<String>,
    /// Only the file was granted: its folder has to be picked first.
    #[serde(default)]
    pub needs_access: bool,
    /// The folder's name, to say which one to pick.
    #[serde(default)]
    pub folder: Option<String>,
    /// The folder picked for the grant does not hold the file.
    #[serde(default)]
    pub wrong_folder: bool,
}

#[derive(Debug, Deserialize)]
pub struct AssetRead {
    pub found: bool,
    #[serde(default)]
    pub size: Option<u64>,
    #[serde(default)]
    pub data: Option<String>,
}

#[derive(Debug, Serialize)]
struct AssetArgs<'a> {
    tree: &'a str,
    dir: &'a str,
    path: &'a str,
    offset: u64,
    length: u64,
}

#[derive(Debug, Serialize)]
struct DocumentSourceArgs {
    uri: String,
}

#[derive(Debug, Deserialize)]
struct DocumentRead {
    data: String,
}

impl<R: Runtime> GallerySave<R> {
    pub fn pick_folder_info(&self) -> Result<FolderPick> {
        Ok(self.0.run_mobile_plugin("pick_folder", ())?)
    }

    pub fn list_folder(&self, uri: &str) -> Result<Vec<FolderEntry>> {
        let response: FolderList = self.0.run_mobile_plugin("list_folder", DocumentSourceArgs { uri: uri.into() })?;
        Ok(response.entries)
    }

    pub fn pick_document(&self) -> Result<DocumentPick> {
        Ok(self.0.run_mobile_plugin("pick_document", ())?)
    }

    pub fn stat_document(&self, uri: &str) -> Result<DocumentStat> {
        Ok(self.0.run_mobile_plugin("stat_document", DocumentSourceArgs { uri: uri.into() })?)
    }

    pub fn html_folder(&self, uri: &str) -> Result<HtmlFolder> {
        Ok(self.0.run_mobile_plugin("html_folder", DocumentSourceArgs { uri: uri.into() })?)
    }

    pub fn grant_html_folder(&self, uri: &str) -> Result<HtmlFolder> {
        Ok(self.0.run_mobile_plugin("grant_html_folder", DocumentSourceArgs { uri: uri.into() })?)
    }

    /// `length` bytes from `offset` of `path` inside the tree folder `dir`; 0 reads only its size.
    pub fn read_asset(&self, tree: &str, dir: &str, path: &str, offset: u64, length: u64) -> Result<AssetRead> {
        Ok(self.0.run_mobile_plugin("read_asset", AssetArgs { tree, dir, path, offset, length })?)
    }

    pub fn read_document(&self, uri: &str) -> Result<String> {
        let response: DocumentRead = self.0.run_mobile_plugin("read_document", DocumentSourceArgs { uri: uri.into() })?;
        Ok(response.data)
    }
}
