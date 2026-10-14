//! Desktop settings and the current automatic ChatBot run.

use axum::{extract::State, Json};
use crate::config::AssistantAppConfig;
use crate::serve::assistant_runner::{self, AssistantRunnerStatus};
use super::{AppError, Shared};

fn desktop() -> Result<(), AppError> {
    if cfg!(target_os = "android") {
        return Err(AppError::bad_request(anyhow::anyhow!("Connect to your PC to manage the assistant app.")));
    }
    Ok(())
}

pub async fn get_assistant_runner_config(State(state): State<Shared>) -> Result<Json<AssistantAppConfig>, AppError> {
    desktop()?;
    Ok(Json(state.cfg_snapshot().assistant_app))
}

pub async fn put_assistant_runner_config(State(state): State<Shared>, Json(config): Json<AssistantAppConfig>) -> Result<Json<AssistantAppConfig>, AppError> {
    desktop()?;
    config.validate().map_err(AppError::bad_request)?;
    let saved = config.clone();
    let mut cfg = state.cfg.write().unwrap_or_else(|error| error.into_inner());
    let mut next = cfg.clone();
    next.assistant_app = config;
    next.save().map_err(|_| AppError::bad_request(anyhow::anyhow!("Could not save the assistant app settings.")))?;
    *cfg = next;
    Ok(Json(saved))
}

pub async fn get_assistant_runner() -> Result<Json<AssistantRunnerStatus>, AppError> {
    desktop()?;
    Ok(Json(assistant_runner::status()))
}

#[derive(Debug, Default, serde::Deserialize)]
pub struct StartBody {
    #[serde(default)]
    pub job_id: Option<String>,
}

/// An assistant bot hands its pending work (or one page run) to the app on this PC.
///
/// Refused unless the reader switched it on: this is the one way a request
/// from outside the PC can start a local program, and the program it starts
/// is the same bounded run the app mode uses.
pub async fn start_assistant_runner(State(state): State<Shared>, body: Option<Json<StartBody>>) -> Result<Json<serde_json::Value>, AppError> {
    desktop()?;
    if !state.cfg_snapshot().assistant_app.allow_bots {
        return Err(AppError::bad_request(anyhow::anyhow!(
            "Handing work to an app on this PC is off. Turn it on in Settings, ChatBot, on the PC."
        )));
    }
    let job_id = body.and_then(|Json(body)| body.job_id).filter(|id| !id.is_empty());
    if job_id.as_deref().is_some_and(|id| !crate::pads::footnotes::valid_id(id)) {
        return Err(AppError::bad_request(anyhow::anyhow!("job_id must be a page run id from list_annotation_jobs")));
    }
    let job = job_id.clone();
    let handed = super::blocking(move || {
        let conn = crate::pads::open(&crate::pads::db_path()?)?;
        match job {
            Some(id) => crate::pads::annotation_jobs::hand_over_to_app(&conn, &id).map(|_| 1).map_err(super::footnotes::into_anyhow),
            None => crate::pads::footnotes::hand_over_pending_to_app(&conn).map_err(super::footnotes::into_anyhow),
        }
    })
    .await
    .map_err(super::footnotes::map_store_error)?;
    assistant_runner::schedule(job_id.as_deref());
    Ok(Json(serde_json::json!({ "started": true, "handed_over": handed, "status": assistant_runner::status() })))
}

pub async fn test_assistant_runner(State(state): State<Shared>, body: Option<Json<AssistantAppConfig>>) -> Result<Json<AssistantRunnerStatus>, AppError> {
    desktop()?;
    let config = body.map(|Json(config)| config).unwrap_or_else(|| state.cfg_snapshot().assistant_app);
    config.validate().map_err(AppError::bad_request)?;
    Ok(Json(assistant_runner::test(config).await))
}
