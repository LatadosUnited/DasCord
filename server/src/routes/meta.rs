//! Rotas sem sessão: saúde do processo, versão e um snowflake de exemplo.

use axum::{
    extract::State,
    response::{Html, IntoResponse},
    Json,
};
use serde::Serialize;
use serde_json::json;
use std::sync::Arc;

use crate::snowflake::SnowflakeGenerator;
use crate::state::AppState;
use crate::{MIN_CLIENT_VERSION, SERVER_VERSION};

/// O que `/health` conta a quem pergunta. Quantas pessoas estão conectadas agora
/// e em que porta o processo escuta não são da conta de quem está fora: a rota é
/// aberta, e isso serve mais a quem observa o servidor do que a quem o usa.
#[derive(Serialize)]
pub struct ServerInfo {
    pub status: String,
    pub service: String,
    pub version: String,
    pub engine: String,
}

#[derive(Serialize)]
pub struct SnowflakeResponse {
    pub id: String,
    pub timestamp_ms: u64,
    pub epoch: String,
}


pub async fn root_handler() -> Html<&'static str> {
    Html(
        "<h1>🦀 DasCord Real-Time Server</h1><p>Powered by Rust, Axum, Tokio & WebSockets</p>",
    )
}

pub async fn health_handler() -> impl IntoResponse {
    Json(ServerInfo {
        status: "healthy".to_string(),
        service: "dascord-realtime-rust".to_string(),
        version: SERVER_VERSION.to_string(),
        engine: "Axum + Tokio + WebSockets".to_string(),
    })
}

/// Versão do servidor e a mínima do app, mais as regras de entrada, para a tela
/// de login não oferecer o que este servidor não aceita.
/// Sem autenticação: o app confere antes do login.
pub async fn version_handler(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    Json(json!({
        "version": SERVER_VERSION,
        "minClientVersion": MIN_CLIENT_VERSION,
        "requireInvite": state.policy.require_invite,
        "allowGuests": state.policy.allow_guests,
    }))
}

pub async fn snowflake_handler(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let id_str = state.snowflake.next_id_string();
    let numeric_id = id_str.parse::<u64>().unwrap_or(0);
    let timestamp = SnowflakeGenerator::extract_timestamp(numeric_id);
    Json(SnowflakeResponse {
        id: id_str,
        timestamp_ms: timestamp,
        epoch: "2026-01-01T00:00:00Z".to_string(),
    })
}
