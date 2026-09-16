//! O que a pessoa muda em si mesma: perfil, status, avatar, senha e sessões.

use axum::{
    body::Bytes,
    extract::{ConnectInfo, State},
    http::{HeaderMap, StatusCode},
    Json,
};
use serde::Deserialize;
use serde_json::json;
use std::{net::SocketAddr, sync::Arc};

use crate::presence::broadcast_user_update;
use crate::state::{client_ip, json_error, require_session, AppState, JsonReply};
use crate::uploads::{remove_replaced_upload, save_uploaded_image};

#[derive(Deserialize)]
pub struct ProfilePayload {
    #[serde(rename = "displayName")]
    pub display_name: String,
}

pub async fn update_profile_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(payload): Json<ProfilePayload>,
) -> JsonReply {
    let (_, user_id) = match require_session(&state, &headers) {
        Ok(session) => session,
        Err(reply) => return reply,
    };
    match state.auth.update_profile(&user_id, &payload.display_name) {
        Ok(user) => {
            broadcast_user_update(&state, &user, true);
            (StatusCode::OK, Json(json!({ "success": true, "user": user })))
        }
        Err(err) => json_error(StatusCode::BAD_REQUEST, &err),
    }
}

#[derive(Deserialize)]
pub struct PresencePayload {
    pub status: String,
    #[serde(rename = "customStatus", default)]
    pub custom_status: String,
}

pub async fn update_presence_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(payload): Json<PresencePayload>,
) -> JsonReply {
    let (_, user_id) = match require_session(&state, &headers) {
        Ok(session) => session,
        Err(reply) => return reply,
    };
    match state.auth.update_presence(&user_id, &payload.status, &payload.custom_status) {
        Ok(user) => {
            broadcast_user_update(&state, &user, true);
            (StatusCode::OK, Json(json!({ "success": true, "user": user })))
        }
        Err(err) => json_error(StatusCode::BAD_REQUEST, &err),
    }
}

pub async fn upload_avatar_handler(
    State(state): State<Arc<AppState>>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    body: Bytes,
) -> JsonReply {
    let (_, user_id) = match require_session(&state, &headers) {
        Ok(session) => session,
        Err(reply) => return reply,
    };
    if !state.upload_limit.check(&client_ip(&state, &headers, addr)) {
        return json_error(StatusCode::TOO_MANY_REQUESTS, "Muitos envios deste endereço. Aguarde um pouco.");
    }
    if state.auth.is_guest(&user_id) {
        return json_error(
            StatusCode::FORBIDDEN,
            "Convidados não podem trocar o avatar. Crie uma conta para usar esse recurso.",
        );
    }
    let (file_name, file_path) = match save_uploaded_image(&state.avatars_dir, &user_id, &state.snowflake, &body).await {
        Ok(saved) => saved,
        Err(reply) => return reply,
    };

    // Só o nome do arquivo vai para o banco; a URL é montada na leitura
    match state.auth.set_avatar(&user_id, &file_name) {
        Ok((user, old_avatar)) => {
            remove_replaced_upload(&state.avatars_dir, &old_avatar).await;
            broadcast_user_update(&state, &user, true);
            (StatusCode::OK, Json(json!({ "success": true, "user": user })))
        }
        Err(err) => {
            let _ = tokio::fs::remove_file(&file_path).await;
            json_error(StatusCode::BAD_REQUEST, &err)
        }
    }
}


pub async fn account_handler(State(state): State<Arc<AppState>>, headers: HeaderMap) -> JsonReply {
    let (token, user_id) = match require_session(&state, &headers) {
        Ok(session) => session,
        Err(reply) => return reply,
    };
    match state.auth.account_info(&user_id, &token) {
        Ok(Some(info)) => (StatusCode::OK, Json(json!(info))),
        Ok(None) => json_error(StatusCode::FORBIDDEN, "Convidados não têm conta. Crie uma para usar esse recurso."),
        Err(err) => json_error(StatusCode::INTERNAL_SERVER_ERROR, &err),
    }
}

#[derive(Deserialize)]
pub struct PasswordPayload {
    #[serde(rename = "currentPassword")]
    pub current_password: String,
    #[serde(rename = "newPassword")]
    pub new_password: String,
}

pub async fn change_password_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(payload): Json<PasswordPayload>,
) -> JsonReply {
    let (token, user_id) = match require_session(&state, &headers) {
        Ok(session) => session,
        Err(reply) => return reply,
    };

    // argon2 é CPU-bound: roda fora das threads do runtime async
    let st = state.clone();
    let result = tokio::task::spawn_blocking(move || {
        st.auth
            .change_password(&user_id, &token, &payload.current_password, &payload.new_password)
    })
    .await;

    match result {
        Ok(Ok(revoked)) => (StatusCode::OK, Json(json!({ "success": true, "revokedSessions": revoked }))),
        Ok(Err(err)) => json_error(StatusCode::BAD_REQUEST, &err),
        Err(_) => json_error(StatusCode::INTERNAL_SERVER_ERROR, "Erro interno do servidor."),
    }
}

pub async fn revoke_sessions_handler(State(state): State<Arc<AppState>>, headers: HeaderMap) -> JsonReply {
    let (token, user_id) = match require_session(&state, &headers) {
        Ok(session) => session,
        Err(reply) => return reply,
    };
    match state.auth.revoke_other_sessions(&user_id, &token) {
        Ok(revoked) => (StatusCode::OK, Json(json!({ "success": true, "revokedSessions": revoked }))),
        Err(err) => json_error(StatusCode::INTERNAL_SERVER_ERROR, &err),
    }
}
