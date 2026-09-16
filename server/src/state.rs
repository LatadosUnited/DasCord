//! O estado que todo o servidor compartilha, e as respostas curtas que qualquer
//! rota precisa dar: 401 sem sessão, erro em JSON, IP de quem chamou.

use axum::{
    http::{HeaderMap, StatusCode},
    Json,
};
use serde::Serialize;
use serde_json::json;
use std::{
    collections::HashMap,
    net::SocketAddr,
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, AtomicUsize},
        Mutex,
    },
};
use tokio::sync::broadcast;

use crate::auth::AuthStore;
use crate::friends::FriendsStore;
use crate::messages::MessageStore;
use crate::policy::AccessPolicy;
use crate::ratelimit::RateLimiter;
use crate::servers::{ServerError, ServerStore};
use crate::sfu::SfuConfig;
use crate::signing::UrlSigner;
use crate::snowflake::SnowflakeGenerator;
use crate::voice::VoiceRegistry;

/// Destinatários de um evento publicado no canal de broadcast.
/// Não existe "todos": cada evento diz exatamente quem pode recebê-lo.
#[derive(Clone)]
pub enum Target {
    Users(Vec<String>),
}

#[derive(Clone)]
pub struct Outbound {
    pub payload: String,
    pub target: Target,
}

impl Outbound {
    pub fn is_for(&self, user_id: &str) -> bool {
        let Target::Users(ids) = &self.target;
        ids.iter().any(|id| id == user_id)
    }
}

// State shared across threads
pub struct AppState {
    pub tx: broadcast::Sender<Outbound>,
    pub active_connections: AtomicUsize,
    pub snowflake: SnowflakeGenerator,
    pub auth: AuthStore,
    pub friends: FriendsStore,
    pub servers: ServerStore,
    pub messages: MessageStore,
    pub allowed_origins: Vec<String>,
    pub port: u16,
    /// Conexões WebSocket abertas por usuário: sem nenhuma, os outros o veem offline
    pub presence: Mutex<HashMap<String, usize>>,
    /// Quem está em cada canal de voz, visível para todos os membros do servidor
    pub voice: VoiceRegistry,
    /// Servidor de mídia; sem ele a voz usa a malha P2P entre os apps
    pub sfu: Option<SfuConfig>,
    /// Identifica cada conexão WebSocket (um usuário pode ter várias)
    pub next_conn_id: AtomicU64,
    pub avatars_dir: PathBuf,
    pub icons_dir: PathBuf,
    pub attachments_dir: PathBuf,
    /// Endereço público do servidor, usado para montar a URL dos avatares enviados
    pub public_url: String,
    /// Quem pode entrar e como o servidor enxerga o IP de quem chega
    pub policy: AccessPolicy,
    /// Assina os endereços temporários das imagens do chat
    pub signer: UrlSigner,
    /// Limites por IP: contas novas, convidados, tentativas de login e uploads
    pub register_limit: RateLimiter,
    pub guest_limit: RateLimiter,
    pub login_limit: RateLimiter,
    pub upload_limit: RateLimiter,
}

/// IP de quem fez a requisição. Atrás de proxy reverso o socket é sempre o do
/// proxy, então o IP real vem no cabeçalho — mas só se o proxy estiver mesmo lá,
/// senão qualquer um escolheria o próprio "IP" e passaria por cima dos limites.
pub fn client_ip(state: &AppState, headers: &HeaderMap, addr: SocketAddr) -> String {
    if state.policy.behind_proxy {
        if let Some(first) = headers
            .get("x-forwarded-for")
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.split(',').next())
            .map(str::trim)
            .filter(|ip| !ip.is_empty())
        {
            return first.to_string();
        }
    }
    addr.ip().to_string()
}

#[derive(Serialize)]
pub struct GenericResponse {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

pub type JsonReply = (StatusCode, Json<serde_json::Value>);

pub fn json_error(status: StatusCode, error: &str) -> JsonReply {
    (status, Json(json!({ "success": false, "error": error })))
}

/// (token, user_id) da sessão, ou a resposta 401 pronta
pub fn require_session(state: &AppState, headers: &HeaderMap) -> Result<(String, String), JsonReply> {
    let unauthorized = || json_error(StatusCode::UNAUTHORIZED, "Sessão inválida ou expirada.");
    let token = extract_token(headers).ok_or_else(unauthorized)?;
    let user_id = state.auth.get_user_id_by_token(&token).ok_or_else(unauthorized)?;
    Ok((token, user_id))
}


pub fn generic_error(status: StatusCode, error: &str) -> (StatusCode, Json<GenericResponse>) {
    (
        status,
        Json(GenericResponse {
            success: false,
            message: None,
            error: Some(error.to_string()),
        }),
    )
}


pub fn server_error(err: ServerError) -> JsonReply {
    match err {
        ServerError::NotFound(msg) => json_error(StatusCode::NOT_FOUND, msg),
        ServerError::Forbidden(msg) => json_error(StatusCode::FORBIDDEN, msg),
        ServerError::Invalid(msg) => json_error(StatusCode::BAD_REQUEST, &msg),
        ServerError::Internal(msg) => json_error(StatusCode::INTERNAL_SERVER_ERROR, &msg),
    }
}

pub fn extract_token(headers: &HeaderMap) -> Option<String> {
    headers
        .get("authorization")
        .and_then(|h| h.to_str().ok())
        .map(|h| h.trim_start_matches("Bearer ").trim().to_string())
        .filter(|t| !t.is_empty())
}

pub fn publish(state: &AppState, event: serde_json::Value, target: Target) {
    let _ = state.tx.send(Outbound {
        payload: event.to_string(),
        target,
    });
}
