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

#[derive(Debug, Serialize)]
struct DocumentSourceArgs {
    uri: String,
}

#[derive(Debug, Deserialize)]
struct DocumentRead {
    data: String,
}

impl<R: Runtime> GallerySave<R> {
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
