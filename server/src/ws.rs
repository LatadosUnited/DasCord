//! O protocolo do WebSocket: autenticar a conexão, encaminhar a cada cliente só
//! o que é dele, e validar cada evento que chega antes de repassá-lo.

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        State,
    },
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use futures::{sink::SinkExt, stream::StreamExt};
use serde_json::json;
use std::{
    sync::{atomic::Ordering, Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::sync::broadcast;

use crate::auth::PublicUser;
use crate::events::{channel_target, leave_voice_channel, publish_voice_leave};
use crate::messages::{MAX_ATTACHMENTS_PER_MESSAGE, MAX_CHANNEL_ID_LEN, MAX_EMOJI_CHARS, MAX_MESSAGE_CHARS};
use crate::presence::broadcast_user_update;
use crate::state::{publish, AppState, Target};
use crate::uploads::sign_message_attachments;
use crate::voice::VoiceMember;

/// Tempo que o servidor espera pela mensagem de autenticação antes de desistir
const WS_AUTH_TIMEOUT: Duration = Duration::from_secs(10);
/// Maior mensagem que o servidor aceita pelo WebSocket. O padrão do axum é 64 MiB,
/// grande demais para o que trafega aqui: o maior evento é uma mensagem de 4000
/// caracteres com dez anexos.
const MAX_WS_MESSAGE_BYTES: usize = 64 * 1024;
/// Janela dos limites por conexão
const EVENT_WINDOW: Duration = Duration::from_secs(10);
/// Eventos de qualquer tipo por janela. Folgado de propósito: ao entrar numa chamada
/// P2P, a troca de candidatos ICE vem em rajada.
const MAX_EVENTS_PER_WINDOW: u32 = 120;
/// Mensagens gravadas no banco por janela. Uma pessoa digitando não chega perto;
/// um cliente em laço, sim — e cada uma vira uma linha no SQLite.
const MAX_MESSAGES_PER_WINDOW: u32 = 10;


pub async fn ws_handler(
    ws: WebSocketUpgrade,
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> Response {
    // WebSocket não passa por CORS: a origem precisa ser conferida manualmente
    if let Some(origin) = headers.get(header::ORIGIN).and_then(|o| o.to_str().ok()) {
        if !state.allowed_origins.iter().any(|allowed| allowed == origin) {
            return (StatusCode::FORBIDDEN, "Origem não permitida").into_response();
        }
    }
    ws.max_message_size(MAX_WS_MESSAGE_BYTES)
        .on_upgrade(|socket| handle_socket(socket, state))
}

/// Quanto uma conexão já gastou na janela atual. Vale por conexão, e não por
/// usuário: uma sessão sozinha não derruba o servidor nem enche o disco.
pub struct EventBudget {
    window_start: Instant,
    events: u32,
    messages: u32,
    /// Só avisa uma vez por janela, para a rajada não virar enxurrada de log
    warned: bool,
}

impl EventBudget {
    fn new() -> Self {
        Self {
            window_start: Instant::now(),
            events: 0,
            messages: 0,
            warned: false,
        }
    }

    /// `false` quando o evento passa do limite e deve ser descartado
    fn allow(&mut self, is_message: bool, user_name: &str) -> bool {
        if self.window_start.elapsed() > EVENT_WINDOW {
            *self = Self::new();
        }
        self.events += 1;
        if is_message {
            self.messages += 1;
        }
        let within = self.events <= MAX_EVENTS_PER_WINDOW
            && (!is_message || self.messages <= MAX_MESSAGES_PER_WINDOW);
        if !within && !self.warned {
            self.warned = true;
            eprintln!("🚧 Limite de eventos do WebSocket atingido por {}.", user_name);
        }
        within
    }
}

/// A primeira mensagem do cliente precisa ser {"type":"auth","token":"..."}
pub async fn authenticate_socket(socket: &mut WebSocket, state: &AppState) -> Option<PublicUser> {
    let first = tokio::time::timeout(WS_AUTH_TIMEOUT, socket.recv()).await.ok()??.ok()?;
    let Message::Text(text) = first else {
        return None;
    };
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    if value.get("type")?.as_str()? != "auth" {
        return None;
    }
    state.auth.get_by_token(value.get("token")?.as_str()?)
}

pub async fn handle_socket(mut socket: WebSocket, state: Arc<AppState>) {
    let Some(user) = authenticate_socket(&mut socket, &state).await else {
        let rejection = json!({ "type": "auth-error", "channelId": "", "data": {} });
        let _ = socket.send(Message::Text(rejection.to_string().into())).await;
        let _ = socket.send(Message::Close(None)).await;
        return;
    };

    let accepted = json!({ "type": "auth-ok", "channelId": "", "data": { "userId": user.id } });
    if socket.send(Message::Text(accepted.to_string().into())).await.is_err() {
        return;
    }

    let user_id = user.id.clone();
    let conn_id = state.next_conn_id.fetch_add(1, Ordering::Relaxed);

    // Primeira conexão do usuário: os amigos passam a vê-lo com o status escolhido
    let came_online = {
        let mut presence = state.presence.lock().unwrap();
        let count = presence.entry(user_id.clone()).or_insert(0);
        *count += 1;
        *count == 1
    };
    if came_online {
        broadcast_user_update(&state, &user, false);
    }

    let (mut sender, mut receiver) = socket.split();
    let mut rx = state.tx.subscribe();
    // Canal de voz em que esta conexão está, para avisar os outros se ela cair
    let voice_channel: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));

    state.active_connections.fetch_add(1, Ordering::Relaxed);
    let current_connections = state.active_connections.load(Ordering::Relaxed);
    println!("🟢 {} conectado via WebSocket! Total conexões ativas: {}", user.name, current_connections);

    // Encaminha para este cliente apenas os eventos destinados a ele
    let send_user_id = user_id.clone();
    let mut send_task = tokio::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(out) => {
                    if !out.is_for(&send_user_id) {
                        continue;
                    }
                    if sender.send(Message::Text(out.payload.into())).await.is_err() {
                        break;
                    }
                }
                Err(broadcast::error::RecvError::Lagged(n)) => {
                    eprintln!("⚠️ Cliente WebSocket atrasado, mensagens ignoradas pelo buffer: {}", n);
                    continue;
                }
                Err(broadcast::error::RecvError::Closed) => {
                    break;
                }
            }
        }
    });

    let recv_state = state.clone();
    let recv_voice_channel = voice_channel.clone();
    let mut recv_task = tokio::spawn(async move {
        let mut budget = EventBudget::new();
        while let Some(Ok(msg)) = receiver.next().await {
            match msg {
                Message::Text(text) => {
                    handle_client_event(&recv_state, &user, conn_id, &text, &recv_voice_channel, &mut budget)
                }
                Message::Close(_) => break,
                // Ping/Pong são respondidos pelo axum; binário não é usado
                _ => {}
            }
        }
    });

    // If either task ends, disconnect
    tokio::select! {
        _ = (&mut send_task) => recv_task.abort(),
        _ = (&mut recv_task) => send_task.abort(),
    };

    let left_channel = voice_channel.lock().unwrap().take();
    if let Some(channel_id) = left_channel {
        leave_voice_channel(&state, conn_id, &channel_id, &user_id);
    }

    // Última conexão fechada: amigos e membros dos servidores passam a vê-lo offline
    let went_offline = {
        let mut presence = state.presence.lock().unwrap();
        let remaining = presence.get_mut(&user_id).map(|count| {
            *count = count.saturating_sub(1);
            *count
        });
        if remaining == Some(0) {
            presence.remove(&user_id);
        }
        remaining == Some(0)
    };
    if went_offline {
        if let Some(latest) = state.auth.get_user(&user_id) {
            broadcast_user_update(&state, &latest, false);
        }
    }

    state.active_connections.fetch_sub(1, Ordering::Relaxed);
    println!("🔴 Cliente desconectado. Conexões restantes: {}", state.active_connections.load(Ordering::Relaxed));
}

/// Valida um evento do cliente, sobrescreve a identidade com o usuário autenticado
/// e decide quem deve recebê-lo.
pub fn handle_client_event(
    state: &AppState,
    user: &PublicUser,
    conn_id: u64,
    text: &str,
    voice_channel: &Mutex<Option<String>>,
    budget: &mut EventBudget,
) {
    let Ok(mut event) = serde_json::from_str::<serde_json::Value>(text) else {
        return;
    };
    let Some(kind) = event.get("type").and_then(|t| t.as_str()).map(str::to_string) else {
        return;
    };
    let Some(channel_id) = event.get("channelId").and_then(|c| c.as_str()).map(str::to_string) else {
        return;
    };
    if !event.get("data").map_or(false, |d| d.is_object()) {
        event["data"] = json!({});
    }

    if channel_id.len() > MAX_CHANNEL_ID_LEN {
        return;
    }
    if !budget.allow(kind == "message", &user.name) {
        return;
    }

    let target = match kind.as_str() {
        "message" => {
            let Some(target) = channel_target(state, &user.id, &channel_id) else {
                return;
            };
            let content = event["data"]
                .get("content")
                .and_then(|c| c.as_str())
                .map(|c| c.trim().to_string())
                .unwrap_or_default();
            // Imagens enviadas antes da mensagem; com elas, o texto pode vir vazio
            let attachment_ids: Vec<String> = event["data"]
                .get("attachmentIds")
                .and_then(|a| a.as_array())
                .map(|ids| {
                    ids.iter()
                        .filter_map(|id| id.as_str().map(str::to_string))
                        .take(MAX_ATTACHMENTS_PER_MESSAGE)
                        .collect()
                })
                .unwrap_or_default();
            if (content.is_empty() && attachment_ids.is_empty()) || content.chars().count() > MAX_MESSAGE_CHARS {
                return;
            }
            // O ID do cliente vira "nonce", para ele trocar a mensagem otimista pela oficial
            let nonce = event["data"].get("id").and_then(|n| n.as_str()).map(str::to_string);
            let reply_to = event["data"].get("replyToId").and_then(|r| r.as_str()).map(str::to_string);

            let mut saved = match state.messages.insert(
                &channel_id,
                user,
                &content,
                reply_to.as_deref(),
                &attachment_ids,
                &state.snowflake,
            ) {
                Ok(saved) => saved,
                Err(_) => return,
            };
            sign_message_attachments(state, &mut saved);
            let mut data = json!(saved);
            if let Some(nonce) = nonce {
                data["nonce"] = json!(nonce);
            }
            event["data"] = data;
            target
        }
        "typing" => {
            let Some(target) = channel_target(state, &user.id, &channel_id) else {
                return;
            };
            event["data"] = json!({ "userId": user.id, "name": user.name });
            target
        }
        // Só o autor edita; o texto novo passa pelas mesmas regras do envio
        "message-edit" => {
            let Some(target) = channel_target(state, &user.id, &channel_id) else {
                return;
            };
            let Some(message_id) = event["data"].get("id").and_then(|v| v.as_str()).map(str::to_string) else {
                return;
            };
            let content = event["data"]
                .get("content")
                .and_then(|c| c.as_str())
                .map(|c| c.trim().to_string())
                .unwrap_or_default();
            if content.is_empty() || content.chars().count() > MAX_MESSAGE_CHARS {
                return;
            }
            let Ok(Some(mut updated)) = state.messages.edit(&channel_id, &message_id, &user.id, &content) else {
                return;
            };
            sign_message_attachments(state, &mut updated);
            event["type"] = json!("message-updated");
            event["data"] = json!(updated);
            target
        }
        // O autor apaga a própria mensagem; o dono do servidor apaga a de qualquer um
        "message-delete" => {
            let Some(target) = channel_target(state, &user.id, &channel_id) else {
                return;
            };
            let Some(message_id) = event["data"].get("id").and_then(|v| v.as_str()).map(str::to_string) else {
                return;
            };
            let can_moderate = state
                .servers
                .channel_server_id(&channel_id)
                .is_some_and(|server_id| state.servers.require_owner(&server_id, &user.id).is_ok());
            match state.messages.delete(&channel_id, &message_id, &user.id, can_moderate) {
                Ok(true) => {}
                _ => return,
            }
            event["type"] = json!("message-deleted");
            event["data"] = json!({ "id": message_id });
            target
        }
        // Põe ou tira a própria reação; todos recebem a lista nova de quem reagiu
        "reaction" => {
            let Some(target) = channel_target(state, &user.id, &channel_id) else {
                return;
            };
            let Some(message_id) = event["data"].get("messageId").and_then(|v| v.as_str()).map(str::to_string) else {
                return;
            };
            let emoji = event["data"]
                .get("emoji")
                .and_then(|e| e.as_str())
                .map(|e| e.trim().to_string())
                .unwrap_or_default();
            if emoji.is_empty() || emoji.chars().count() > MAX_EMOJI_CHARS {
                return;
            }
            let Ok(Some(reaction)) = state.messages.toggle_reaction(&channel_id, &message_id, &user.id, &emoji) else {
                return;
            };
            event["data"] = json!({
                "messageId": message_id,
                "emoji": reaction.emoji,
                "userIds": reaction.user_ids,
            });
            target
        }
        "voice-join" => {
            let Some(target) = channel_target(state, &user.id, &channel_id) else {
                return;
            };
            let flag = |key: &str| event["data"].get(key).and_then(|v| v.as_bool()).unwrap_or(false);
            let member = VoiceMember {
                id: user.id.clone(),
                name: user.name.clone(),
                avatar: user.avatar.clone(),
                muted: flag("muted"),
                deafened: flag("deafened"),
                streaming: flag("streaming"),
            };
            let previous_channel = voice_channel.lock().unwrap().replace(channel_id.clone());
            if let Some(server_id) = state.servers.channel_server_id(&channel_id) {
                // Entrar em outro canal tira o usuário do anterior, mesmo que por outra sessão
                if let Some(old) = state.voice.join(conn_id, &server_id, &channel_id, member.clone()) {
                    if let Some(audience) = state.servers.channel_member_ids(&old) {
                        publish_voice_leave(state, &old, &user.id, audience);
                    }
                }
            } else if let Some(old) = previous_channel.filter(|old| *old != channel_id) {
                leave_voice_channel(state, conn_id, &old, &user.id);
            }
            event["data"] = json!(member);
            event["data"]["userId"] = json!(user.id);
            target
        }
        "voice-leave" => {
            {
                let mut current = voice_channel.lock().unwrap();
                if current.as_deref() == Some(channel_id.as_str()) {
                    *current = None;
                }
            }
            leave_voice_channel(state, conn_id, &channel_id, &user.id);
            return;
        }
        // Microfone/fone mudou: todo o servidor vê, inclusive quem não está na chamada
        "voice-state" | "screen-start" | "screen-stop" => {
            let Some(target) = channel_target(state, &user.id, &channel_id) else {
                return;
            };
            let data = &event["data"];
            let muted = data.get("muted").and_then(|v| v.as_bool());
            let deafened = data.get("deafened").and_then(|v| v.as_bool());
            let present = state.voice.update(conn_id, &channel_id, &user.id, |member| match kind.as_str() {
                "screen-start" => member.streaming = true,
                "screen-stop" => member.streaming = false,
                _ => {
                    member.muted = muted.unwrap_or(member.muted);
                    member.deafened = deafened.unwrap_or(member.deafened);
                }
            });
            // Canais de servidor só aceitam quem está na chamada (DMs não entram no registro)
            if !present && state.servers.channel_server_id(&channel_id).is_some() {
                return;
            }
            event["data"] = json!({ "userId": user.id });
            if kind == "voice-state" {
                event["data"]["muted"] = json!(muted.unwrap_or(false));
                event["data"]["deafened"] = json!(deafened.unwrap_or(false));
            }
            target
        }
        "voice-speaking" => {
            let Some(target) = channel_target(state, &user.id, &channel_id) else {
                return;
            };
            event["data"]["userId"] = json!(user.id);
            target
        }
        // screen-watch/unwatch: o espectador pede a quem transmite para enviar (ou parar de enviar) a tela
        "voice-offer" | "voice-answer" | "voice-candidate" | "voice-announce" | "screen-watch" | "screen-unwatch" => {
            let Some(to) = event["data"].get("to").and_then(|t| t.as_str()).map(str::to_string) else {
                return;
            };
            // Sinalização só entre membros com acesso ao mesmo canal
            let Some(Target::Users(audience)) = channel_target(state, &user.id, &channel_id) else {
                return;
            };
            if !audience.contains(&to) {
                return;
            }
            if kind == "voice-announce" {
                if !event["data"]["user"].is_object() {
                    return;
                }
                event["data"]["user"]["id"] = json!(user.id);
                event["data"]["user"]["name"] = json!(user.name);
                event["data"]["user"]["avatar"] = json!(user.avatar);
            } else {
                event["data"]["from"] = json!(user.id);
            }
            Target::Users(vec![to])
        }
        // Tipos desconhecidos e eventos que só o servidor emite (friend-request-*) são descartados
        _ => return,
    };

    publish(state, event, target);
}
