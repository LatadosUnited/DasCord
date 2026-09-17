//! Todas as rotas HTTP do servidor, agrupadas pelo assunto de cada uma.
//!
//! Este arquivo é só o mapa: cada caminho aponta para o handler no módulo do
//! domínio dele. As regras de cada assunto ficam lá, e as de acesso ao banco
//! ficam nos stores (`auth`, `servers`, `messages`, `friends`).

pub mod auth;
pub mod friends;
pub mod messages;
pub mod meta;
pub mod servers;
pub mod updates;
pub mod users;
pub mod voice;

use axum::{
    extract::DefaultBodyLimit,
    routing::{get, patch, post},
    Router,
};
use std::path::Path;
use std::sync::Arc;
use tower_http::services::ServeDir;

use crate::state::AppState;
use crate::{ws, MAX_ATTACHMENT_BYTES, MAX_IMAGE_BYTES};

/// Monta o roteador. Quem chama ainda aplica o CORS e entrega o estado.
pub fn router(avatars_dir: &Path, icons_dir: &Path, updates_dir: &Path) -> Router<Arc<AppState>> {
    Router::new()
        .route("/", get(meta::root_handler))
        .route("/health", get(meta::health_handler))
        .route("/api/version", get(meta::version_handler))
        .route(
            "/api/update/{target}/{arch}/{current_version}",
            get(updates::update_handler),
        )
        .route("/api/snowflake", get(meta::snowflake_handler))
        .route("/api/auth/register", post(auth::register_handler))
        .route("/api/auth/login", post(auth::login_handler))
        .route("/api/auth/guest", post(auth::guest_handler))
        .route("/api/auth/logout", post(auth::logout_handler))
        .route("/api/auth/me", get(auth::me_handler))
        .route("/api/friends", get(friends::get_friends_handler))
        .route("/api/friends/request", post(friends::send_friend_request_handler))
        .route("/api/friends/accept", post(friends::accept_friend_request_handler))
        .route("/api/friends/decline", post(friends::decline_friend_request_handler))
        .route("/api/channels/{channel_id}/messages", get(messages::channel_messages_handler))
        .route(
            "/api/channels/{channel_id}/attachments",
            post(messages::upload_attachment_handler).layer(DefaultBodyLimit::max(MAX_ATTACHMENT_BYTES)),
        )
        .route("/api/users/me/profile", patch(users::update_profile_handler))
        .route("/api/users/me/presence", patch(users::update_presence_handler))
        .route(
            "/api/users/me/avatar",
            post(users::upload_avatar_handler).layer(DefaultBodyLimit::max(MAX_IMAGE_BYTES)),
        )
        .route("/api/users/me/account", get(users::account_handler))
        .route("/api/users/me/password", post(users::change_password_handler))
        .route("/api/users/me/sessions/revoke-others", post(users::revoke_sessions_handler))
        .route(
            "/api/servers",
            get(servers::list_servers_handler).post(servers::create_server_handler),
        )
        .route(
            "/api/servers/{server_id}",
            patch(servers::rename_server_handler).delete(servers::delete_server_handler),
        )
        .route(
            "/api/servers/{server_id}/icon",
            post(servers::upload_server_icon_handler).layer(DefaultBodyLimit::max(MAX_IMAGE_BYTES)),
        )
        .route("/api/servers/{server_id}/channels", post(servers::create_channel_handler))
        // Estático antes do parâmetro: "order" nunca é confundido com um ID de canal
        .route(
            "/api/servers/{server_id}/channels/order",
            post(servers::reorder_channels_handler),
        )
        .route(
            "/api/servers/{server_id}/channels/{channel_id}",
            patch(servers::update_channel_handler).delete(servers::delete_channel_handler),
        )
        .route("/api/servers/{server_id}/leave", post(servers::leave_server_handler))
        .route("/api/servers/{server_id}/members", get(servers::server_members_handler))
        .route("/api/servers/{server_id}/voice", get(voice::server_voice_handler))
        .route("/api/voice/token", get(voice::voice_token_handler))
        .route("/api/servers/{server_id}/invites", post(servers::create_invite_handler))
        .route("/api/invites/{code}/accept", post(servers::accept_invite_handler))
        // Avatares e ícones continuam abertos: são públicos por natureza.
        // As imagens do chat, não — elas saem por /api/attachments/{id}, com endereço assinado.
        .nest_service("/avatars", ServeDir::new(avatars_dir))
        .nest_service("/icons", ServeDir::new(icons_dir))
        // Os instaladores são os mesmos para todos, e o app confere a assinatura antes de instalar
        .nest_service("/updates", ServeDir::new(updates_dir))
        .route("/api/attachments/{attachment_id}", get(messages::attachment_handler))
        .route("/ws", get(ws::ws_handler))
}
