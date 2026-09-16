//! Amigos e pedidos de amizade.

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    Json,
};
use serde_json::json;
use std::sync::Arc;

use crate::friends::{RequestActionPayload, SendRequestPayload};
use crate::presence::apply_presence;
use crate::state::{extract_token, generic_error, publish, AppState, GenericResponse, Target};

// Handler de Listagem de Amigos e Pedidos
pub async fn get_friends_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> impl IntoResponse {
    let token = extract_token(&headers);
    let Some(user_id) = token.and_then(|t| state.auth.get_user_id_by_token(&t)) else {
        return (StatusCode::UNAUTHORIZED, Json(json!({ "error": "Não autenticado" })));
    };
    match state.friends.get_summary(&user_id) {
        Ok(mut summary) => {
            // Quem não está conectado aparece offline, independente do status escolhido
            for friend in summary.friends.iter_mut() {
                apply_presence(&state, friend);
            }
            for request in summary.incoming_requests.iter_mut() {
                apply_presence(&state, &mut request.from_user);
            }
            for request in summary.outgoing_requests.iter_mut() {
                apply_presence(&state, &mut request.to_user);
            }
            (StatusCode::OK, Json(json!(summary)))
        }
        Err(err) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": err }))),
    }
}

// ---------- Presença ----------

// Handler para Enviar Pedido de Amizade
pub async fn send_friend_request_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(payload): Json<SendRequestPayload>,
) -> impl IntoResponse {
    let token = extract_token(&headers);
    let Some(user_id) = token.and_then(|t| state.auth.get_user_id_by_token(&t)) else {
        return generic_error(StatusCode::UNAUTHORIZED, "Sessão inválida ou expirada.");
    };

    if state.auth.is_guest(&user_id) {
        return generic_error(
            StatusCode::FORBIDDEN,
            "Convidados não podem adicionar amigos. Crie uma conta para usar esse recurso.",
        );
    }

    match state.friends.send_friend_request(&user_id, &payload.query, &state.auth, &state.snowflake) {
        Ok((target_id, target_name)) => {
            // Notifica só o destinatário via WebSocket
            let event = json!({
                "type": "friend-request-received",
                "toUserId": target_id,
                "fromUserId": user_id,
            });
            publish(&state, event, Target::Users(vec![target_id]));

            (
                StatusCode::OK,
                Json(GenericResponse {
                    success: true,
                    message: Some(format!("Pedido de amizade enviado para {}!", target_name)),
                    error: None,
                }),
            )
        }
        Err(err) => generic_error(StatusCode::BAD_REQUEST, &err),
    }
}

// Handler para Aceitar Pedido
pub async fn accept_friend_request_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(payload): Json<RequestActionPayload>,
) -> impl IntoResponse {
    let token = extract_token(&headers);
    let Some(user_id) = token.and_then(|t| state.auth.get_user_id_by_token(&t)) else {
        return generic_error(StatusCode::UNAUTHORIZED, "Não autenticado.");
    };

    match state.friends.accept_friend_request(&payload.request_id, &user_id) {
        Ok((user_a, user_b)) => {
            let event = json!({
                "type": "friend-request-accepted",
                "userAId": user_a,
                "userBId": user_b,
            });
            publish(&state, event, Target::Users(vec![user_a, user_b]));

            (
                StatusCode::OK,
                Json(GenericResponse {
                    success: true,
                    message: Some("Pedido de amizade aceito com sucesso!".to_string()),
                    error: None,
                }),
            )
        }
        Err(err) => generic_error(StatusCode::BAD_REQUEST, &err),
    }
}

// Handler para Recusar Pedido
pub async fn decline_friend_request_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(payload): Json<RequestActionPayload>,
) -> impl IntoResponse {
    let token = extract_token(&headers);
    let Some(user_id) = token.and_then(|t| state.auth.get_user_id_by_token(&t)) else {
        return generic_error(StatusCode::UNAUTHORIZED, "Não autenticado.");
    };

    match state.friends.decline_friend_request(&payload.request_id, &user_id) {
        Ok(_) => (
            StatusCode::OK,
            Json(GenericResponse {
                success: true,
                message: Some("Pedido removido.".to_string()),
                error: None,
            }),
        ),
        Err(err) => generic_error(StatusCode::BAD_REQUEST, &err),
    }
}
