//! Page-range annotation job routes. The device creates, polls and acks; an
//! assistant (through `lc mcp`) lists, reads pages, submits and finishes.

use axum::extract::{Path as UrlPath, Query};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use super::footnotes::{into_anyhow, map_store_error, now_ms};
use super::{blocking, AppError};
use crate::pads::annotation_jobs::{self, Annotation, JobSummary, NewJob};

fn conn() -> anyhow::Result<rusqlite::Connection> {
    crate::pads::open(&crate::pads::db_path()?)
}

pub async fn create_annotation_job(Json(body): Json<Value>) -> Result<Json<JobSummary>, AppError> {
    let job: NewJob = serde_json::from_value(body)
        .map_err(|err| AppError::bad_request(anyhow::anyhow!("invalid annotation job: {err}")))?;
    let now = now_ms();
    let row = blocking(move || annotation_jobs::create_job(&conn()?, job, now).map_err(into_anyhow))
        .await
        .map_err(map_store_error)?;
    Ok(Json(row))
}

#[derive(Debug, Deserialize)]
pub struct JobsQuery {
    #[serde(default)]
    pub device: Option<String>,
    #[serde(default)]
    pub doc: Option<String>,
}

/// Open jobs for an assistant, or (with `device` and `doc`) one device's jobs on a document.
pub async fn list_annotation_jobs(Query(query): Query<JobsQuery>) -> Result<Json<Vec<JobSummary>>, AppError> {
    let rows = blocking(move || {
        let conn = conn()?;
        match (query.device.filter(|d| !d.is_empty()), query.doc.filter(|d| !d.is_empty())) {
            (Some(device), Some(doc)) => annotation_jobs::list_for_doc(&conn, &device, &doc),
            _ => annotation_jobs::list_open(&conn),
        }
        .map_err(into_anyhow)
    })
    .await
    .map_err(map_store_error)?;
    Ok(Json(rows))
}

#[derive(Debug, Deserialize)]
pub struct PagesQuery {
    #[serde(default)]
    pub from: Option<i64>,
    #[serde(default)]
    pub to: Option<i64>,
}

pub async fn read_annotation_pages(
    UrlPath(id): UrlPath<String>,
    Query(query): Query<PagesQuery>,
) -> Result<Json<Value>, AppError> {
    let from = query.from.unwrap_or(1);
    let to = query.to.unwrap_or(i64::MAX);
    let value = blocking(move || annotation_jobs::read_pages(&conn()?, &id, from, to).map_err(into_anyhow))
        .await
        .map_err(map_store_error)?;
    Ok(Json(value))
}

#[derive(Debug, Deserialize)]
pub struct ReferenceQuery {
    #[serde(default)]
    pub offset: Option<usize>,
}

/// Part of a job's reference (problem pages, a homework file), from `offset`.
pub async fn read_annotation_reference(
    UrlPath((id, index)): UrlPath<(String, usize)>,
    Query(query): Query<ReferenceQuery>,
) -> Result<Json<Value>, AppError> {
    let offset = query.offset.unwrap_or(0);
    let value = blocking(move || annotation_jobs::read_reference(&conn()?, &id, index, offset).map_err(into_anyhow))
        .await
        .map_err(map_store_error)?;
    Ok(Json(value))
}

#[derive(Debug, Deserialize)]
pub struct PageBody {
    pub annotations: Vec<Annotation>,
}

pub async fn submit_annotation_page(
    UrlPath((id, page)): UrlPath<(String, i64)>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, AppError> {
    let body: PageBody = serde_json::from_value(body).map_err(|err| {
        AppError::bad_request(anyhow::anyhow!(
            "annotations must be objects with quote, notes and optional title, color, links, marks and workspace_links: {err}"
        ))
    })?;
    let now = now_ms();
    let added = blocking(move || {
        annotation_jobs::submit_page(&conn()?, &id, page, &body.annotations, now).map_err(into_anyhow)
    })
    .await
    .map_err(map_store_error)?;
    Ok(Json(json!({ "ok": true, "added": added })))
}

#[derive(Debug, Deserialize, Default)]
pub struct FinishBody {
    #[serde(default)]
    pub summary: String,
}

pub async fn finish_annotation_job(
    UrlPath(id): UrlPath<String>,
    body: Option<Json<FinishBody>>,
) -> Result<Json<Value>, AppError> {
    let summary = body.map(|Json(body)| body.summary).unwrap_or_default();
    let now = now_ms();
    blocking(move || annotation_jobs::finish_job(&conn()?, &id, &summary, now).map_err(into_anyhow))
        .await
        .map_err(map_store_error)?;
    Ok(Json(json!({ "ok": true })))
}

pub async fn cancel_annotation_job(UrlPath(id): UrlPath<String>) -> Result<Json<Value>, AppError> {
    let now = now_ms();
    blocking(move || annotation_jobs::cancel_job(&conn()?, &id, now).map_err(into_anyhow))
        .await
        .map_err(map_store_error)?;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Debug, Deserialize)]
pub struct ItemsQuery {
    #[serde(default)]
    pub device: Option<String>,
}

pub async fn annotation_job_items(Query(query): Query<ItemsQuery>) -> Result<Json<Value>, AppError> {
    let device = query.device.unwrap_or_default();
    if device.is_empty() || device.chars().count() > 200 {
        return Err(AppError::bad_request(anyhow::anyhow!("device is required")));
    }
    let items = blocking(move || annotation_jobs::items_for_device(&conn()?, &device).map_err(into_anyhow))
        .await
        .map_err(map_store_error)?;
    Ok(Json(json!({ "items": items })))
}

#[derive(Debug, Deserialize)]
pub struct AckBody {
    pub ids: Vec<i64>,
}

pub async fn ack_annotation_job_items(Json(body): Json<Value>) -> Result<Json<Value>, AppError> {
    let body: AckBody = serde_json::from_value(body)
        .map_err(|_| AppError::bad_request(anyhow::anyhow!("ids must be an array of item ids")))?;
    let now = now_ms();
    let acked = blocking(move || annotation_jobs::ack_items(&conn()?, &body.ids, now).map_err(into_anyhow))
        .await
        .map_err(map_store_error)?;
    Ok(Json(json!({ "ok": true, "acked": acked })))
}
