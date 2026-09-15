use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path as AxumPath, Query, State,
    },
    http::{header, HeaderMap, HeaderValue, Method, StatusCode},
    response::{Html, IntoResponse, Json, Response},
    routing::{get, post},
    Router,
};
use futures::{sink::SinkExt, stream::StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    net::SocketAddr,
    path::Path,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tokio::sync::broadcast;
use tower_http::cors::{AllowOrigin, CorsLayer};

mod auth;
mod db;
mod friends;
mod messages;
mod migration;
mod snowflake;
use auth::{AuthResponse, AuthStore, LoginError, LoginRequest, PublicUser, RegisterRequest};
use db::Db;
use friends::{FriendsStore, RequestActionPayload, SendRequestPayload};
use messages::{MessageStore, MAX_CHANNEL_ID_LEN, MAX_MESSAGE_CHARS};
use snowflake::SnowflakeGenerator;

const DATA_DIR: &str = "data";

const DEFAULT_BIND: &str = "127.0.0.1:3001";
const DEFAULT_ALLOWED_ORIGINS: &str =
    "http://localhost:1420,http://127.0.0.1:1420,http://tauri.localhost,https://tauri.localhost,tauri://localhost";
const WS_AUTH_TIMEOUT: Duration = Duration::from_secs(10);

/// Destinatários de um evento publicado no canal de broadcast
#[derive(Clone)]
enum Target {
    All,
    Users(Vec<String>),
}

#[derive(Clone)]
struct Outbound {
    payload: String,
    target: Target,
}

impl Outbound {
    fn is_for(&self, user_id: &str) -> bool {
        match &self.target {
            Target::All => true,
            Target::Users(ids) => ids.iter().any(|id| id == user_id),
        }
    }
}

// State shared across threads
struct AppState {
    tx: broadcast::Sender<Outbound>,
    active_connections: AtomicUsize,
    snowflake: SnowflakeGenerator,
    auth: AuthStore,
    friends: FriendsStore,
    messages: MessageStore,
    allowed_origins: Vec<String>,
    port: u16,
}

#[derive(Serialize)]
struct ServerInfo {
    status: String,
    service: String,
    engine: String,
    active_connections: usize,
    port: u16,
}

#[derive(Serialize)]
struct SnowflakeResponse {
    id: String,
    timestamp_ms: u64,
    epoch: String,
}

#[derive(Serialize)]
struct GenericResponse {
    success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt::init();

    // Por padrão só aceita conexões locais; defina DASCORD_BIND=0.0.0.0:3001 para expor na rede
    let bind = std::env::var("DASCORD_BIND").unwrap_or_else(|_| DEFAULT_BIND.to_string());
    let addr: SocketAddr = bind.parse().expect("DASCORD_BIND inválido (ex: 127.0.0.1:3001)");

    let allowed_origins: Vec<String> = std::env::var("DASCORD_ALLOWED_ORIGINS")
        .unwrap_or_else(|_| DEFAULT_ALLOWED_ORIGINS.to_string())
        .split(',')
        .map(|o| o.trim().to_string())
        .filter(|o| !o.is_empty())
        .collect();

    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::list(
            allowed_origins.iter().filter_map(|o| HeaderValue::from_str(o).ok()),
        ))
        .allow_methods([Method::GET, Method::POST])
        .allow_headers([header::CONTENT_TYPE, header::AUTHORIZATION]);

    let data_dir = Path::new(DATA_DIR);
    let db = Arc::new(Db::open(&data_dir.join("dascord.db")).expect("Falha ao abrir o banco de dados SQLite"));
    migration::import_legacy_json(&db, data_dir);

    let auth = AuthStore::new(db.clone());
    auth.purge_expired();

    // Broadcast channel with buffer for 256 messages
    let (tx, _rx) = broadcast::channel(256);
    let state = Arc::new(AppState {
        tx,
        active_connections: AtomicUsize::new(0),
        snowflake: SnowflakeGenerator::new(1, 1),
        auth,
        friends: FriendsStore::new(db.clone()),
        messages: MessageStore::new(db),
        allowed_origins,
        port: addr.port(),
    });

    let app = Router::new()
        .route("/", get(root_handler))
        .route("/health", get(health_handler))
        .route("/api/snowflake", get(snowflake_handler))
        .route("/api/auth/register", post(register_handler))
        .route("/api/auth/login", post(login_handler))
        .route("/api/auth/guest", post(guest_handler))
        .route("/api/auth/logout", post(logout_handler))
        .route("/api/auth/me", get(me_handler))
        .route("/api/friends", get(get_friends_handler))
        .route("/api/friends/request", post(send_friend_request_handler))
        .route("/api/friends/accept", post(accept_friend_request_handler))
        .route("/api/friends/decline", post(decline_friend_request_handler))
        .route("/api/channels/{channel_id}/messages", get(channel_messages_handler))
        .route("/ws", get(ws_handler))
        .layer(cors)
        .with_state(state);

    println!("🦀 DasCord Real-Time Rust Server listening on http://{}", addr);
    println!("⚡ WebSocket endpoint: ws://{}/ws", addr);

    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .expect("Failed to bind TCP listener");

    axum::serve(listener, app)
        .await
        .expect("Server failed to run");
}

async fn root_handler() -> Html<&'static str> {
    Html(
        "<h1>🦀 DasCord Real-Time Server</h1><p>Powered by Rust, Axum, Tokio & WebSockets</p>",
    )
}

async fn health_handler(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let connections = state.active_connections.load(Ordering::Relaxed);
    Json(ServerInfo {
        status: "healthy".to_string(),
        service: "dascord-realtime-rust".to_string(),
        engine: "Axum + Tokio + WebSockets".to_string(),
        active_connections: connections,
        port: state.port,
    })
}

async fn snowflake_handler(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let id_str = state.snowflake.next_id_string();
    let numeric_id = id_str.parse::<u64>().unwrap_or(0);
    let timestamp = SnowflakeGenerator::extract_timestamp(numeric_id);
    Json(SnowflakeResponse {
        id: id_str,
        timestamp_ms: timestamp,
        epoch: "2026-01-01T00:00:00Z".to_string(),
    })
}

fn auth_success(status: StatusCode, token: String, user: PublicUser) -> (StatusCode, Json<AuthResponse>) {
    (
        status,
        Json(AuthResponse {
            success: true,
            token: Some(token),
            user: Some(user),
            error: None,
        }),
    )
}

fn auth_failure(status: StatusCode, error: String) -> (StatusCode, Json<AuthResponse>) {
    (
        status,
        Json(AuthResponse {
            success: false,
            token: None,
            user: None,
            error: Some(error),
        }),
    )
}

// Handler de Registro de Usuário
async fn register_handler(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<RegisterRequest>,
) -> impl IntoResponse {
    // argon2 é CPU-bound: roda fora das threads do runtime async
    let st = state.clone();
    let result = tokio::task::spawn_blocking(move || st.auth.register(payload, &st.snowflake)).await;

    match result {
        Ok(Ok((token, user))) => auth_success(StatusCode::CREATED, token, user),
        Ok(Err(err)) => auth_failure(StatusCode::BAD_REQUEST, err),
        Err(_) => auth_failure(StatusCode::INTERNAL_SERVER_ERROR, "Erro interno do servidor.".to_string()),
    }
}

// Handler de Login
async fn login_handler(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<LoginRequest>,
) -> impl IntoResponse {
    let st = state.clone();
    let result = tokio::task::spawn_blocking(move || st.auth.login(payload)).await;

    match result {
        Ok(Ok((token, user))) => auth_success(StatusCode::OK, token, user),
        Ok(Err(err @ LoginError::TooManyAttempts)) => auth_failure(StatusCode::TOO_MANY_REQUESTS, err.message()),
        Ok(Err(err @ LoginError::InvalidCredentials)) => auth_failure(StatusCode::UNAUTHORIZED, err.message()),
        Ok(Err(err @ LoginError::Internal(_))) => auth_failure(StatusCode::INTERNAL_SERVER_ERROR, err.message()),
        Err(_) => auth_failure(StatusCode::INTERNAL_SERVER_ERROR, "Erro interno do servidor.".to_string()),
    }
}

// Handler de Sessão de Convidado (expira em 24h)
async fn guest_handler(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    match state.auth.create_guest(&state.snowflake) {
        Ok((token, user)) => auth_success(StatusCode::CREATED, token, user),
        Err(err) => auth_failure(StatusCode::INTERNAL_SERVER_ERROR, err),
    }
}

// Handler de Logout: invalida o token no servidor
async fn logout_handler(State(state): State<Arc<AppState>>, headers: HeaderMap) -> impl IntoResponse {
    if let Some(token) = extract_token(&headers) {
        state.auth.logout(&token);
    }
    Json(GenericResponse {
        success: true,
        message: None,
        error: None,
    })
}

// Handler de Validação de Sessão / Me
async fn me_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> impl IntoResponse {
    if let Some(token) = extract_token(&headers) {
        if let Some(user) = state.auth.get_by_token(&token) {
            return auth_success(StatusCode::OK, token, user);
        }
    }

    auth_failure(StatusCode::UNAUTHORIZED, "Sessão inválida ou expirada.".to_string())
}

// Handler de Listagem de Amigos e Pedidos
async fn get_friends_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> impl IntoResponse {
    let token = extract_token(&headers);
    let Some(user_id) = token.and_then(|t| state.auth.get_user_id_by_token(&t)) else {
        return (StatusCode::UNAUTHORIZED, Json(json!({ "error": "Não autenticado" })));
    };
    match state.friends.get_summary(&user_id) {
        Ok(summary) => (StatusCode::OK, Json(json!(summary))),
        Err(err) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": err }))),
    }
}

#[derive(Deserialize)]
struct HistoryQuery {
    before: Option<i64>,
    limit: Option<u32>,
}

// Handler de Histórico de Mensagens de um canal
async fn channel_messages_handler(
    State(state): State<Arc<AppState>>,
    AxumPath(channel_id): AxumPath<String>,
    Query(query): Query<HistoryQuery>,
    headers: HeaderMap,
) -> impl IntoResponse {
    let token = extract_token(&headers);
    let Some(user_id) = token.and_then(|t| state.auth.get_user_id_by_token(&t)) else {
        return (StatusCode::UNAUTHORIZED, Json(json!({ "error": "Não autenticado" })));
    };
    // Mesma regra do WebSocket: DMs só para os dois participantes, e só se forem amigos
    if channel_target(&state, &user_id, &channel_id).is_none() {
        return (StatusCode::FORBIDDEN, Json(json!({ "error": "Sem acesso a este canal." })));
    }

    let limit = query.limit.unwrap_or(50).clamp(1, 100);
    match state.messages.history(&channel_id, query.before, limit) {
        Ok(messages) => (StatusCode::OK, Json(json!({ "messages": messages }))),
        Err(err) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": err }))),
    }
}

fn generic_error(status: StatusCode, error: &str) -> (StatusCode, Json<GenericResponse>) {
    (
        status,
        Json(GenericResponse {
            success: false,
            message: None,
            error: Some(error.to_string()),
        }),
    )
}

// Handler para Enviar Pedido de Amizade
async fn send_friend_request_handler(
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
async fn accept_friend_request_handler(
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
async fn decline_friend_request_handler(
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

fn extract_token(headers: &HeaderMap) -> Option<String> {
    headers
        .get("authorization")
        .and_then(|h| h.to_str().ok())
        .map(|h| h.trim_start_matches("Bearer ").trim().to_string())
        .filter(|t| !t.is_empty())
}

fn publish(state: &AppState, event: serde_json::Value, target: Target) {
    let _ = state.tx.send(Outbound {
        payload: event.to_string(),
        target,
    });
}

async fn ws_handler(
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
    ws.on_upgrade(|socket| handle_socket(socket, state))
}

/// A primeira mensagem do cliente precisa ser {"type":"auth","token":"..."}
async fn authenticate_socket(socket: &mut WebSocket, state: &AppState) -> Option<PublicUser> {
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

async fn handle_socket(mut socket: WebSocket, state: Arc<AppState>) {
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
        while let Some(Ok(msg)) = receiver.next().await {
            match msg {
                Message::Text(text) => handle_client_event(&recv_state, &user, &text, &recv_voice_channel),
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
        let event = json!({
            "type": "voice-leave",
            "channelId": channel_id,
            "data": { "userId": user_id },
        });
        publish(&state, event, Target::All);
    }

    state.active_connections.fetch_sub(1, Ordering::Relaxed);
    println!("🔴 Cliente desconectado. Conexões restantes: {}", state.active_connections.load(Ordering::Relaxed));
}

/// Valida um evento do cliente, sobrescreve a identidade com o usuário autenticado
/// e decide quem deve recebê-lo.
fn handle_client_event(
    state: &AppState,
    user: &PublicUser,
    text: &str,
    voice_channel: &Mutex<Option<String>>,
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
            if content.is_empty() || content.chars().count() > MAX_MESSAGE_CHARS {
                return;
            }
            // O ID do cliente vira "nonce", para ele trocar a mensagem otimista pela oficial
            let nonce = event["data"].get("id").and_then(|n| n.as_str()).map(str::to_string);

            let saved = match state.messages.insert(&channel_id, user, &content, &state.snowflake) {
                Ok(saved) => saved,
                Err(_) => return,
            };
            let mut data = json!(saved);
            if let Some(nonce) = nonce {
                data["nonce"] = json!(nonce);
            }
            event["data"] = data;
            target
        }
        "typing" | "reaction" => {
            let Some(target) = channel_target(state, &user.id, &channel_id) else {
                return;
            };
            event["data"]["userId"] = json!(user.id);
            target
        }
        "voice-join" => {
            *voice_channel.lock().unwrap() = Some(channel_id.clone());
            event["data"]["userId"] = json!(user.id);
            event["data"]["name"] = json!(user.name);
            event["data"]["avatar"] = json!(user.avatar);
            Target::All
        }
        "voice-leave" => {
            let mut current = voice_channel.lock().unwrap();
            if current.as_deref() == Some(channel_id.as_str()) {
                *current = None;
            }
            event["data"]["userId"] = json!(user.id);
            Target::All
        }
        "voice-speaking" => {
            event["data"]["userId"] = json!(user.id);
            Target::All
        }
        "voice-offer" | "voice-answer" | "voice-candidate" | "voice-announce" => {
            let Some(to) = event["data"].get("to").and_then(|t| t.as_str()).map(str::to_string) else {
                return;
            };
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

/// Canais "dm_<a>_<b>" só chegam aos dois participantes, e só se forem amigos.
/// Os demais canais (servidores) continuam públicos.
fn channel_target(state: &AppState, user_id: &str, channel_id: &str) -> Option<Target> {
    let Some(pair) = channel_id.strip_prefix("dm_") else {
        return Some(Target::All);
    };
    let (a, b) = pair.split_once('_')?;
    if user_id != a && user_id != b {
        return None;
    }
    let other = if user_id == a { b } else { a };
    if !state.friends.are_friends(user_id, other) {
        return None;
    }
    Some(Target::Users(vec![a.to_string(), b.to_string()]))
}
