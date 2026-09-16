//! Servidores, canais e convites — tudo o que só o dono pode mexer passa por aqui.

use axum::{
    body::Bytes,
    extract::{ConnectInfo, Path as AxumPath, State},
    http::{HeaderMap, StatusCode},
    Json,
};
use serde::Deserialize;
use serde_json::json;
use std::{net::SocketAddr, sync::Arc};

use crate::events::{publish_member_joined, publish_server_updated, publish_to_server, publish_voice_leave};
use crate::presence::apply_presence;
use crate::servers::CreateInvitePayload;
use crate::state::{client_ip, json_error, publish, require_session, server_error, AppState, JsonReply, Target};
use crate::uploads::{remove_replaced_upload, save_uploaded_image};


pub async fn list_servers_handler(State(state): State<Arc<AppState>>, headers: HeaderMap) -> JsonReply {
    let (_, user_id) = match require_session(&state, &headers) {
        Ok(session) => session,
        Err(reply) => return reply,
    };
    match state.servers.list_for_user(&user_id) {
        Ok(servers) => (StatusCode::OK, Json(json!({ "servers": servers }))),
        Err(err) => json_error(StatusCode::INTERNAL_SERVER_ERROR, &err),
    }
}

#[derive(Deserialize)]
pub struct ServerNamePayload {
    pub name: String,
}

#[derive(Deserialize)]
pub struct CreateChannelPayload {
    pub name: String,
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub category: String,
}

/// Campo ausente fica como está; só o que vem é trocado
#[derive(Deserialize)]
pub struct UpdateChannelPayload {
    pub name: Option<String>,
    pub topic: Option<String>,
    pub category: Option<String>,
}

#[derive(Deserialize)]
pub struct ReorderChannelsPayload {
    #[serde(rename = "channelIds")]
    pub channel_ids: Vec<String>,
}

pub async fn create_channel_handler(
    State(state): State<Arc<AppState>>,
    AxumPath(server_id): AxumPath<String>,
    headers: HeaderMap,
    Json(payload): Json<CreateChannelPayload>,
) -> JsonReply {
    let (_, user_id) = match require_session(&state, &headers) {
        Ok(session) => session,
        Err(reply) => return reply,
    };
    match state.servers.create_channel(
        &server_id,
        &user_id,
        &payload.name,
        &payload.kind,
        &payload.category,
        &state.snowflake,
    ) {
        Ok(server) => {
            publish_server_updated(&state, &server);
            (StatusCode::OK, Json(json!({ "success": true, "server": server })))
        }
        Err(err) => server_error(err),
    }
}

pub async fn update_channel_handler(
    State(state): State<Arc<AppState>>,
    AxumPath((server_id, channel_id)): AxumPath<(String, String)>,
    headers: HeaderMap,
    Json(payload): Json<UpdateChannelPayload>,
) -> JsonReply {
    let (_, user_id) = match require_session(&state, &headers) {
        Ok(session) => session,
        Err(reply) => return reply,
    };
    match state.servers.update_channel(
        &server_id,
        &channel_id,
        &user_id,
        payload.name.as_deref(),
        payload.topic.as_deref(),
        payload.category.as_deref(),
    ) {
        Ok(server) => {
            publish_server_updated(&state, &server);
            (StatusCode::OK, Json(json!({ "success": true, "server": server })))
        }
        Err(err) => server_error(err),
    }
}

pub async fn delete_channel_handler(
    State(state): State<Arc<AppState>>,
    AxumPath((server_id, channel_id)): AxumPath<(String, String)>,
    headers: HeaderMap,
) -> JsonReply {
    let (_, user_id) = match require_session(&state, &headers) {
        Ok(session) => session,
        Err(reply) => return reply,
    };
    match state.servers.delete_channel(&server_id, &channel_id, &user_id) {
        Ok((server, kind)) => {
            // Quem estava na chamada do canal apagado precisa sair de lá
            if kind == "voice" {
                state.voice.remove_channel(&channel_id);
            }
            let event = json!({
                "type": "channel-deleted",
                "channelId": channel_id,
                "data": { "serverId": server_id, "channelId": channel_id },
            });
            publish_to_server(&state, &server_id, event);
            publish_server_updated(&state, &server);
            (StatusCode::OK, Json(json!({ "success": true, "server": server })))
        }
        Err(err) => server_error(err),
    }
}

pub async fn reorder_channels_handler(
    State(state): State<Arc<AppState>>,
    AxumPath(server_id): AxumPath<String>,
    headers: HeaderMap,
    Json(payload): Json<ReorderChannelsPayload>,
) -> JsonReply {
    let (_, user_id) = match require_session(&state, &headers) {
        Ok(session) => session,
        Err(reply) => return reply,
    };
    match state.servers.reorder_channels(&server_id, &user_id, &payload.channel_ids) {
        Ok(server) => {
            publish_server_updated(&state, &server);
            (StatusCode::OK, Json(json!({ "success": true, "server": server })))
        }
        Err(err) => server_error(err),
    }
}

pub async fn create_server_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(payload): Json<ServerNamePayload>,
) -> JsonReply {
    let (_, user_id) = match require_session(&state, &headers) {
        Ok(session) => session,
        Err(reply) => return reply,
    };
    if state.auth.is_guest(&user_id) {
        return json_error(
            StatusCode::FORBIDDEN,
            "Convidados não podem criar servidores. Crie uma conta para usar esse recurso.",
        );
    }
    match state.servers.create(&user_id, &payload.name, &state.snowflake) {
        Ok(server) => {
            // As outras sessões do criador também passam a mostrar o servidor
            if let Some(user) = state.auth.get_user(&user_id) {
                publish_member_joined(&state, &server.id, &user);
            }
            (StatusCode::CREATED, Json(json!({ "success": true, "server": server })))
        }
        Err(err) => server_error(err),
    }
}

pub async fn rename_server_handler(
    State(state): State<Arc<AppState>>,
    AxumPath(server_id): AxumPath<String>,
    headers: HeaderMap,
    Json(payload): Json<ServerNamePayload>,
) -> JsonReply {
    let (_, user_id) = match require_session(&state, &headers) {
        Ok(session) => session,
        Err(reply) => return reply,
    };
    match state.servers.rename(&server_id, &user_id, &payload.name) {
        Ok(server) => {
            publish_server_updated(&state, &server);
            (StatusCode::OK, Json(json!({ "success": true, "server": server })))
        }
        Err(err) => server_error(err),
    }
}

pub async fn upload_server_icon_handler(
    State(state): State<Arc<AppState>>,
    AxumPath(server_id): AxumPath<String>,
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
    // Confere a permissão antes de gravar qualquer arquivo (e garante que o ID existe no banco)
    if let Err(err) = state.servers.require_owner(&server_id, &user_id) {
        return server_error(err);
    }
    let (file_name, file_path) = match save_uploaded_image(&state.icons_dir, &server_id, &state.snowflake, &body).await {
        Ok(saved) => saved,
        Err(reply) => return reply,
    };

    match state.servers.set_icon(&server_id, &user_id, &file_name) {
        Ok((server, old_icon)) => {
            remove_replaced_upload(&state.icons_dir, &old_icon).await;
            publish_server_updated(&state, &server);
            (StatusCode::OK, Json(json!({ "success": true, "server": server })))
        }
        Err(err) => {
            let _ = tokio::fs::remove_file(&file_path).await;
            server_error(err)
        }
    }
}

pub async fn delete_server_handler(
    State(state): State<Arc<AppState>>,
    AxumPath(server_id): AxumPath<String>,
    headers: HeaderMap,
) -> JsonReply {
    let (_, user_id) = match require_session(&state, &headers) {
        Ok(session) => session,
        Err(reply) => return reply,
    };
    match state.servers.delete(&server_id, &user_id) {
        Ok((former_members, icon)) => {
            remove_replaced_upload(&state.icons_dir, &icon).await;
            state.voice.remove_server(&server_id);
            let event = json!({ "type": "server-deleted", "channelId": "", "data": { "serverId": server_id } });
            publish(&state, event, Target::Users(former_members));
            (StatusCode::OK, Json(json!({ "success": true })))
        }
        Err(err) => server_error(err),
    }
}

pub async fn leave_server_handler(
    State(state): State<Arc<AppState>>,
    AxumPath(server_id): AxumPath<String>,
    headers: HeaderMap,
) -> JsonReply {
    let (_, user_id) = match require_session(&state, &headers) {
        Ok(session) => session,
        Err(reply) => return reply,
    };
    match state.servers.leave(&server_id, &user_id) {
        Ok(()) => {
            // Os membros que ficam e as outras sessões de quem saiu
            let mut audience = state.servers.member_ids(&server_id);
            audience.push(user_id.clone());
            if let Some(channel_id) = state.voice.remove_user_from_server(&server_id, &user_id) {
                publish_voice_leave(&state, &channel_id, &user_id, audience.clone());
            }
            let event = json!({
                "type": "server-member-left",
                "channelId": "",
                "data": { "serverId": server_id, "userId": user_id },
            });
            publish(&state, event, Target::Users(audience));
            (StatusCode::OK, Json(json!({ "success": true })))
        }
        Err(err) => server_error(err),
    }
}

pub async fn server_members_handler(
    State(state): State<Arc<AppState>>,
    AxumPath(server_id): AxumPath<String>,
    headers: HeaderMap,
) -> JsonReply {
    let (_, user_id) = match require_session(&state, &headers) {
        Ok(session) => session,
        Err(reply) => return reply,
    };
    match state.servers.members(&server_id, &user_id) {
        Ok(mut members) => {
            for member in members.iter_mut() {
                apply_presence(&state, member);
            }
            (StatusCode::OK, Json(json!({ "members": members })))
        }
        Err(err) => server_error(err),
    }
}


pub async fn create_invite_handler(
    State(state): State<Arc<AppState>>,
    AxumPath(server_id): AxumPath<String>,
    headers: HeaderMap,
    Json(payload): Json<CreateInvitePayload>,
) -> JsonReply {
    let (_, user_id) = match require_session(&state, &headers) {
        Ok(session) => session,
        Err(reply) => return reply,
    };
    if state.auth.is_guest(&user_id) {
        return json_error(
            StatusCode::FORBIDDEN,
            "Convidados não podem criar convites. Crie uma conta para usar esse recurso.",
        );
    }
    match state.servers.create_invite(&server_id, &user_id, &payload) {
        Ok(invite) => (StatusCode::CREATED, Json(json!({ "success": true, "invite": invite }))),
        Err(err) => server_error(err),
    }
}

pub async fn accept_invite_handler(
    State(state): State<Arc<AppState>>,
    AxumPath(code): AxumPath<String>,
    headers: HeaderMap,
) -> JsonReply {
    let (_, user_id) = match require_session(&state, &headers) {
        Ok(session) => session,
        Err(reply) => return reply,
    };
    match state.servers.accept_invite(&code, &user_id) {
        Ok((server, joined)) => {
            if joined {
                if let Some(user) = state.auth.get_user(&user_id) {
                    publish_member_joined(&state, &server.id, &user);
                }
            }
            (
                StatusCode::OK,
                Json(json!({ "success": true, "server": server, "alreadyMember": !joined })),
            )
        }
        Err(err) => server_error(err),
    }
}
