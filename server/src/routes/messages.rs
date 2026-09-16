//! Histórico do canal e as imagens do chat: receber e entregar com endereço assinado.

use axum::{
    body::Bytes,
    extract::{ConnectInfo, Path as AxumPath, Query, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::Deserialize;
use serde_json::json;
use std::{net::SocketAddr, sync::Arc};

use crate::db;
use crate::events::channel_target;
use crate::messages::MAX_CHANNEL_ID_LEN;
use crate::signing::ATTACHMENT_URL_TTL_MS;
use crate::state::{client_ip, extract_token, json_error, require_session, AppState, JsonReply};
use crate::uploads::{safe_upload_path, save_uploaded_image, sign_attachment, sign_message_attachments};

#[derive(Deserialize)]
pub struct SignedAttachmentQuery {
    pub expires: i64,
    pub sig: String,
}

/// Entrega a imagem a quem chega com um endereço assinado e dentro da validade.
/// Sem `ServeDir`: acertar (ou adivinhar) o nome do arquivo não basta mais.
pub async fn attachment_handler(
    State(state): State<Arc<AppState>>,
    AxumPath(attachment_id): AxumPath<String>,
    Query(query): Query<SignedAttachmentQuery>,
) -> Response {
    let not_found = || (StatusCode::NOT_FOUND, "Anexo não encontrado.").into_response();

    if !state.signer.verify(&attachment_id, query.expires, &query.sig, db::now_ms()) {
        return (StatusCode::FORBIDDEN, "Endereço expirado ou inválido.").into_response();
    }
    let Ok(Some(source)) = state.messages.attachment_source(&attachment_id) else {
        return not_found();
    };
    let Some(path) = safe_upload_path(&state.attachments_dir, &source.file_name) else {
        return not_found();
    };
    let Ok(bytes) = tokio::fs::read(&path).await else {
        return not_found();
    };

    // O nome original é do usuário: só o que é seguro em cabeçalho continua nele
    let safe_name: String = source
        .name
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | ' '))
        .collect();
    let disposition = if safe_name.trim().is_empty() {
        "inline".to_string()
    } else {
        format!("inline; filename=\"{}\"", safe_name.trim())
    };

    (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, source.content_type),
            (header::CONTENT_DISPOSITION, disposition),
            // Privado: o endereço é de uma pessoa só, e some com a validade
            (header::CACHE_CONTROL, "private, max-age=600".to_string()),
        ],
        bytes,
    )
        .into_response()
}

#[derive(Deserialize)]
pub struct AttachmentQuery {
    /// Nome original do arquivo, só para exibição
    #[serde(default)]
    pub name: String,
}

/// Recebe uma imagem para um canal. Ela fica guardada sem mensagem até o app
/// enviar a mensagem que a cita, e some sozinha se isso nunca acontecer.
pub async fn upload_attachment_handler(
    State(state): State<Arc<AppState>>,
    AxumPath(channel_id): AxumPath<String>,
    Query(query): Query<AttachmentQuery>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    body: Bytes,
) -> JsonReply {
    let (_, user_id) = match require_session(&state, &headers) {
        Ok(session) => session,
        Err(reply) => return reply,
    };
    if !state.upload_limit.check(&client_ip(&state, &headers, addr)) {
        return json_error(
            StatusCode::TOO_MANY_REQUESTS,
            "Muitas imagens enviadas deste endereço. Aguarde um pouco.",
        );
    }
    if channel_id.len() > MAX_CHANNEL_ID_LEN || channel_target(&state, &user_id, &channel_id).is_none() {
        return json_error(StatusCode::FORBIDDEN, "Sem acesso a este canal.");
    }

    let size = body.len() as i64;
    let (file_name, file_path) =
        match save_uploaded_image(&state.attachments_dir, &user_id, &state.snowflake, &body).await {
            Ok(saved) => saved,
            Err(reply) => return reply,
        };
    let content_type = match file_name.rsplit('.').next() {
        Some("png") => "image/png",
        Some("jpg") => "image/jpeg",
        Some("gif") => "image/gif",
        _ => "image/webp",
    };
    // O nome vem do cliente: serve só de rótulo, nunca de caminho no disco
    let display_name = query.name.chars().take(120).collect::<String>();
    let display_name = if display_name.trim().is_empty() { file_name.clone() } else { display_name };

    match state.messages.create_attachment(
        &channel_id,
        &user_id,
        &file_name,
        &display_name,
        content_type,
        size,
        &state.snowflake,
    ) {
        Ok(mut attachment) => {
            // A pré-visualização no app usa o arquivo local; este endereço é o
            // que vai junto da mensagem quando ela for enviada.
            sign_attachment(&state, &mut attachment, db::now_ms() + ATTACHMENT_URL_TTL_MS);
            (StatusCode::CREATED, Json(json!({ "success": true, "attachment": attachment })))
        }
        Err(err) => {
            let _ = tokio::fs::remove_file(&file_path).await;
            json_error(StatusCode::INTERNAL_SERVER_ERROR, &err)
        }
    }
}

// ---------- Servidores e convites ----------


#[derive(Deserialize)]
pub struct HistoryQuery {
    pub before: Option<i64>,
    pub limit: Option<u32>,
}

// Handler de Histórico de Mensagens de um canal
pub async fn channel_messages_handler(
    State(state): State<Arc<AppState>>,
    AxumPath(channel_id): AxumPath<String>,
    Query(query): Query<HistoryQuery>,
    headers: HeaderMap,
) -> impl IntoResponse {
    let token = extract_token(&headers);
    let Some(user_id) = token.and_then(|t| state.auth.get_user_id_by_token(&t)) else {
        return (StatusCode::UNAUTHORIZED, Json(json!({ "error": "Não autenticado" })));
    };
    // Mesma regra do WebSocket: DMs só entre amigos, canais de servidor só para membros
    if channel_target(&state, &user_id, &channel_id).is_none() {
        return (StatusCode::FORBIDDEN, Json(json!({ "error": "Sem acesso a este canal." })));
    }

    let limit = query.limit.unwrap_or(50).clamp(1, 100);
    match state.messages.history(&channel_id, query.before, limit) {
        Ok(mut messages) => {
            for message in messages.iter_mut() {
                sign_message_attachments(&state, message);
            }
            (StatusCode::OK, Json(json!({ "messages": messages })))
        }
        Err(err) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": err }))),
    }
}
