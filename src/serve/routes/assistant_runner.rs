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

pub async fn test_assistant_runner(State(state): State<Shared>, body: Option<Json<AssistantAppConfig>>) -> Result<Json<AssistantRunnerStatus>, AppError> {
    desktop()?;
    let config = body.map(|Json(config)| config).unwrap_or_else(|| state.cfg_snapshot().assistant_app);
    config.validate().map_err(AppError::bad_request)?;
    Ok(Json(assistant_runner::test(config).await))
}
