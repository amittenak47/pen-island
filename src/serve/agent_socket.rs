//! Socket adapter for the in-memory registry; no model or CLI is called here.

use anyhow::{anyhow, Result};
use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::llm::agent_runs::{
    AgentAction, AgentCompletion, AgentResponder, AgentRunHandle, AgentRunInput, AgentTaskContext,
};
use crate::llm::coach::{BoardSnapshot, EventSink};
use crate::pad::{parse_surface, AgentSurface};
use crate::serve::common::{description_for, load_meta, resolve_dataset};
use crate::serve::{blocking, board_session, coach, viz, AppError, Shared};

pub(super) async fn run(
    state: &Shared,
    request_id: String,
    action: AgentAction,
    responder: AgentResponder,
    payload: Value,
    events: EventSink,
) -> Result<Value, AppError> {
    let input = prepare(state, action, payload).await?;
    if let Some(error) = events.cancelled_error() {
        return Err(error.into());
    }
    let handle = state
        .agent_runs
        .create(request_id, responder, input, events.clone(), None);
    // Aborting a socket task (cancel or disconnect) must also close its inbox
    // entry. Step 4's cancellation hook will stop the scoped CLI here.
    let _guard = CancelOnDrop {
        state: state.clone(),
        id: handle.id.clone(),
    };
    events.stage(
        "ask",
        match responder {
            AgentResponder::App => "Waiting for the AI application",
            AgentResponder::Bot => "Waiting for the AI assistant",
        },
    );
    if responder == AgentResponder::App {
        if let Err(error) = state.agent_runs.start_app(&handle.id) {
            state.agent_runs.fail(
                &handle.id,
                format!("could not start the AI application: {error:#}"),
            )?;
        }
    }
    wait_for_reply(state, handle).await
}

pub(super) async fn wait_for_reply(
    state: &Shared,
    mut handle: AgentRunHandle,
) -> Result<Value, AppError> {
    loop {
        let completion = handle.completion.borrow_and_update().clone();
        if let Some(completion) = completion {
            return match completion {
                AgentCompletion::Done(body) => Ok(body),
                AgentCompletion::Failed(message) => Err(anyhow!("{message}").into()),
                AgentCompletion::Cancelled => Err(anyhow!("cancelled").into()),
            };
        }
        let request = state.agent_runs.get_request(&handle.id)?;
        // get_request may have just expired the run. Observe that transition
        // before sleeping, including with a controllable test clock.
        if request.finished_at.is_some() {
            continue;
        }
        let remaining = request.deadline.saturating_sub(state.agent_runs.now());
        tokio::select! {
            changed = handle.completion.changed() => {
                changed.map_err(|_| anyhow!("agent run completion channel closed"))?;
            }
            _ = tokio::time::sleep(std::time::Duration::from_millis(remaining)) => {
                state.agent_runs.expire(&handle.id)?;
            }
        }
    }
}

struct CancelOnDrop {
    state: Shared,
    id: String,
}

impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        let _ = self.state.agent_runs.cancel(&self.id);
    }
}

fn parse<T: DeserializeOwned>(payload: &Value, action: AgentAction) -> Result<T, AppError> {
    serde_json::from_value(payload.clone()).map_err(|error| {
        AppError::bad_request(anyhow!(
            "cannot read the {} payload: {error}",
            action.as_str()
        ))
    })
}

async fn prepare(
    state: &Shared,
    action: AgentAction,
    payload: Value,
) -> Result<AgentRunInput, AppError> {
    let cfg = state.cfg_snapshot();
    let (task_id, dataset, mut board) = match action {
        AgentAction::Ask => {
            let request: coach::AskRequest = parse(&payload, action)?;
            if request.question.trim().is_empty() {
                return Err(AppError::bad_request(anyhow!("type a question first")));
            }
            // Ask's current HTTP DTO has no board field, but retain a snapshot
            // supplied by the panel for the agent, as well as the raw payload.
            let board = payload
                .get("board")
                .map(|board| serde_json::from_value(board.clone()))
                .transpose()
                .map_err(|error| AppError::bad_request(error.into()))?
                .unwrap_or_default();
            (request.task_id, request.dataset, board)
        }
        AgentAction::Review => {
            let request: coach::ReviewRequest = parse(&payload, action)?;
            (request.task_id, request.dataset, request.board)
        }
        AgentAction::Viz => {
            let request: viz::VizRequest = parse(&payload, action)?;
            (request.task_id, request.dataset, request.board)
        }
        AgentAction::Lazy => {
            let request: coach::LazyRequest = parse(&payload, action)?;
            (request.task_id, request.dataset, request.board)
        }
        AgentAction::DrawReview => {
            let request: viz::DrawReviewRequest = parse(&payload, action)?;
            if !cfg.coach.draw_review_enabled {
                return Err(AppError::bad_request(anyhow!(
                    "the post-draw review is off — turn on Settings → Coach → check drawn diagrams"
                )));
            }
            (
                request.task_id,
                request.dataset,
                BoardSnapshot {
                    png: request.png,
                    ..Default::default()
                },
            )
        }
    };
    let surface = parse_surface(payload["surface"].as_str(), dataset.as_deref(), &task_id);
    let dataset = if action == AgentAction::Ask && surface.is_pad() {
        None
    } else {
        Some(resolve_dataset(dataset.as_deref())?)
    };
    if matches!(action, AgentAction::Review | AgentAction::Lazy) {
        let key = dataset.expect("non-Ask has a dataset").key(&task_id);
        let mut store = state.board_sessions.lock().await;
        let session = store.entry(&key);
        board = board_session::resolve_board_snapshot(session, board);
        if let Some(pseudocode) = board_session::resolve_pseudocode(session, &board) {
            board.pseudocode = Some(pseudocode);
        }
        if board.is_empty() {
            let detail = if action == AgentAction::Review {
                "submitting"
            } else {
                "asking for a lazy fill"
            };
            return Err(AppError::bad_request(anyhow!(
                "the board is empty — sketch an approach before {detail}"
            )));
        }
    }
    blocking(move || {
        let meta = if action == AgentAction::Ask {
            match surface {
                AgentSurface::Whiteboard => crate::pad::whiteboard_meta(),
                AgentSurface::Annotate => crate::pad::annotate_meta(),
                AgentSurface::Problem { .. } => {
                    load_meta(&cfg, dataset.expect("problem dataset"), &task_id)?
                }
            }
        } else {
            load_meta(&cfg, dataset.expect("non-Ask dataset"), &task_id)?
        };
        let description = description_for(&meta);
        Ok(AgentRunInput {
            cfg,
            action,
            payload,
            context: AgentTaskContext {
                task_id: meta.task_id,
                description,
                cases: meta.cases,
                board,
            },
        })
    })
    .await
}
