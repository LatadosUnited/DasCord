//! Credenciais do servidor de mídia e quem está em cada canal de voz.

use axum::{
    extract::{Path as AxumPath, Query, State},
    http::{HeaderMap, StatusCode},
    Json,
};
use serde::Deserialize;
use serde_json::json;
use std::sync::Arc;

use crate::events::channel_target;
use crate::state::{json_error, require_session, AppState, JsonReply};

#[derive(Deserialize)]
pub struct VoiceTokenQuery {
    #[serde(rename = "channelId")]
    pub channel_id: String,
}

/// Credenciais para entrar no canal no servidor de mídia.
/// 503 quando não há SFU configurado: o app então usa a malha P2P.
pub async fn voice_token_handler(
    State(state): State<Arc<AppState>>,
    Query(query): Query<VoiceTokenQuery>,
    headers: HeaderMap,
) -> JsonReply {
    let (_, user_id) = match require_session(&state, &headers) {
        Ok(session) => session,
        Err(reply) => return reply,
    };
    let Some(sfu) = &state.sfu else {
        return json_error(StatusCode::SERVICE_UNAVAILABLE, "Este servidor não tem servidor de voz configurado.");
    };
    // Mesma regra do WebSocket: só quem tem acesso ao canal
    if channel_target(&state, &user_id, &query.channel_id).is_none() {
        return json_error(StatusCode::FORBIDDEN, "Sem acesso a este canal.");
    }
    let Some(user) = state.auth.get_user(&user_id) else {
        return json_error(StatusCode::UNAUTHORIZED, "Sessão inválida ou expirada.");
    };

    match sfu.token_for(&query.channel_id, &user.id, &user.name, &user.avatar) {
        Ok(token) => (
            StatusCode::OK,
            Json(json!({ "url": sfu.url, "token": token, "room": query.channel_id })),
        ),
        Err(err) => json_error(StatusCode::INTERNAL_SERVER_ERROR, &err),
    }
}

/// Quem está em cada canal de voz do servidor, para a lista de canais antes de entrar
pub async fn server_voice_handler(
    State(state): State<Arc<AppState>>,
    AxumPath(server_id): AxumPath<String>,
    headers: HeaderMap,
) -> JsonReply {
    let (_, user_id) = match require_session(&state, &headers) {
        Ok(session) => session,
        Err(reply) => return reply,
    };
    if !state.servers.is_member(&server_id, &user_id) {
        return json_error(StatusCode::NOT_FOUND, "Servidor não encontrado.");
    }
    (StatusCode::OK, Json(json!({ "channels": state.voice.snapshot(&server_id) })))
}
