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

    pub fn read_document(&self, uri: &str) -> Result<String> {
        let response: DocumentRead = self.0.run_mobile_plugin("read_document", DocumentSourceArgs { uri: uri.into() })?;
        Ok(response.data)
    }
}
