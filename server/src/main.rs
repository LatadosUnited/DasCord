use axum::{
    body::Bytes,
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        ConnectInfo, DefaultBodyLimit, Path as AxumPath, Query, State,
    },
    http::{header, HeaderMap, HeaderValue, Method, StatusCode},
    response::{Html, IntoResponse, Json, Response},
    routing::{get, patch, post},
    Router,
};
use futures::{sink::SinkExt, stream::StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    collections::HashMap,
    net::SocketAddr,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tokio::sync::broadcast;
use tower_http::cors::{AllowOrigin, CorsLayer};
use tower_http::services::ServeDir;

mod auth;
mod db;
mod friends;
mod media;
mod messages;
mod migration;
mod policy;
mod ratelimit;
mod servers;
mod sfu;
mod signing;
mod snowflake;
mod voice;
use auth::{AuthResponse, AuthStore, LoginError, LoginRequest, PublicUser, RegisterRequest};
use db::Db;
use friends::{FriendsStore, RequestActionPayload, SendRequestPayload};
use messages::{
    AttachmentDto, MessageDto, MessageStore, MAX_ATTACHMENTS_PER_MESSAGE, MAX_CHANNEL_ID_LEN,
    MAX_EMOJI_CHARS, MAX_MESSAGE_CHARS,
};
use signing::{UrlSigner, ATTACHMENT_URL_TTL_MS};
use policy::AccessPolicy;
use ratelimit::RateLimiter;
use servers::{CreateInvitePayload, ServerDto, ServerError, ServerStore};
use sfu::SfuConfig;
use snowflake::SnowflakeGenerator;
use voice::{LeaveOutcome, VoiceMember, VoiceRegistry};

/// Pasta padrão dos dados: server/data, independente de onde o servidor foi iniciado.
/// Defina DASCORD_DATA_DIR para usar outro local (ex: em produção).
const DEFAULT_DATA_DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/data");

const DEFAULT_BIND: &str = "127.0.0.1:3001";
const DEFAULT_ALLOWED_ORIGINS: &str =
    "http://localhost:1420,http://127.0.0.1:1420,http://tauri.localhost,https://tauri.localhost,tauri://localhost";
const WS_AUTH_TIMEOUT: Duration = Duration::from_secs(10);
/// Versão deste servidor, vinda do Cargo.toml (sincronizado com o package.json)
const SERVER_VERSION: &str = env!("CARGO_PKG_VERSION");
/// App mais antigo que este servidor aceita. Suba quando a API mudar de forma incompatível.
const MIN_CLIENT_VERSION: &str = "0.2.0";
/// Limite de avatares e ícones de servidor
const MAX_IMAGE_BYTES: usize = 2 * 1024 * 1024;
/// Limite das imagens enviadas no chat, que podem ser bem maiores que um avatar
const MAX_ATTACHMENT_BYTES: usize = 8 * 1024 * 1024;
/// Upload que não virou mensagem nesse tempo é descartado na subida do servidor
const ORPHAN_ATTACHMENT_MAX_AGE_MS: i64 = 24 * 60 * 60 * 1000;

/// Destinatários de um evento publicado no canal de broadcast.
/// Não existe "todos": cada evento diz exatamente quem pode recebê-lo.
#[derive(Clone)]
enum Target {
    Users(Vec<String>),
}

#[derive(Clone)]
struct Outbound {
    payload: String,
    target: Target,
}

impl Outbound {
    fn is_for(&self, user_id: &str) -> bool {
        let Target::Users(ids) = &self.target;
        ids.iter().any(|id| id == user_id)
    }
}

// State shared across threads
struct AppState {
    tx: broadcast::Sender<Outbound>,
    active_connections: AtomicUsize,
    snowflake: SnowflakeGenerator,
    auth: AuthStore,
    friends: FriendsStore,
    servers: ServerStore,
    messages: MessageStore,
    allowed_origins: Vec<String>,
    port: u16,
    /// Conexões WebSocket abertas por usuário: sem nenhuma, os outros o veem offline
    presence: Mutex<HashMap<String, usize>>,
    /// Quem está em cada canal de voz, visível para todos os membros do servidor
    voice: VoiceRegistry,
    /// Servidor de mídia; sem ele a voz usa a malha P2P entre os apps
    sfu: Option<SfuConfig>,
    /// Identifica cada conexão WebSocket (um usuário pode ter várias)
    next_conn_id: AtomicU64,
    avatars_dir: PathBuf,
    icons_dir: PathBuf,
    attachments_dir: PathBuf,
    /// Endereço público do servidor, usado para montar a URL dos avatares enviados
    public_url: String,
    /// Quem pode entrar e como o servidor enxerga o IP de quem chega
    policy: AccessPolicy,
    /// Assina os endereços temporários das imagens do chat
    signer: UrlSigner,
    /// Limites por IP: contas novas, convidados, tentativas de login e uploads
    register_limit: RateLimiter,
    guest_limit: RateLimiter,
    login_limit: RateLimiter,
    upload_limit: RateLimiter,
}

/// IP de quem fez a requisição. Atrás de proxy reverso o socket é sempre o do
/// proxy, então o IP real vem no cabeçalho — mas só se o proxy estiver mesmo lá,
/// senão qualquer um escolheria o próprio "IP" e passaria por cima dos limites.
fn client_ip(state: &AppState, headers: &HeaderMap, addr: SocketAddr) -> String {
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
struct ServerInfo {
    status: String,
    service: String,
    version: String,
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
        .allow_methods([Method::GET, Method::POST, Method::PATCH, Method::DELETE])
        .allow_headers([header::CONTENT_TYPE, header::AUTHORIZATION]);

    let data_dir = std::env::var("DASCORD_DATA_DIR").unwrap_or_else(|_| DEFAULT_DATA_DIR.to_string());
    let data_dir = Path::new(&data_dir);
    println!("🗂️ Pasta de dados: {}", data_dir.display());
    let db = Arc::new(Db::open(&data_dir.join("dascord.db")).expect("Falha ao abrir o banco de dados SQLite"));
    migration::import_legacy_json(&db, data_dir);

    let auth = AuthStore::new(db.clone());
    auth.purge_expired();

    let avatars_dir = data_dir.join("avatars");
    std::fs::create_dir_all(&avatars_dir).expect("Falha ao criar a pasta de avatares");
    let icons_dir = data_dir.join("icons");
    std::fs::create_dir_all(&icons_dir).expect("Falha ao criar a pasta de ícones de servidor");
    let attachments_dir = data_dir.join("attachments");
    std::fs::create_dir_all(&attachments_dir).expect("Falha ao criar a pasta de anexos");
    let public_url = std::env::var("DASCORD_PUBLIC_URL")
        .unwrap_or_else(|_| format!("http://localhost:{}", addr.port()))
        .trim_end_matches('/')
        .to_string();
    // Os stores montam a URL dos avatares e ícones na leitura a partir daqui
    media::set_public_url(&public_url);

    // Broadcast channel with buffer for 256 messages
    let (tx, _rx) = broadcast::channel(256);
    let state = Arc::new(AppState {
        tx,
        active_connections: AtomicUsize::new(0),
        snowflake: SnowflakeGenerator::new(1, 1),
        auth,
        friends: FriendsStore::new(db.clone()),
        servers: ServerStore::new(db.clone()),
        messages: MessageStore::new(db),
        allowed_origins,
        port: addr.port(),
        presence: Mutex::new(HashMap::new()),
        voice: VoiceRegistry::default(),
        sfu: SfuConfig::from_env(),
        next_conn_id: AtomicU64::new(1),
        avatars_dir: avatars_dir.clone(),
        icons_dir: icons_dir.clone(),
        attachments_dir: attachments_dir.clone(),
        public_url,
        policy: AccessPolicy::from_env(),
        signer: UrlSigner::load(data_dir),
        register_limit: RateLimiter::new("cadastro", 5, Duration::from_secs(60 * 60)),
        guest_limit: RateLimiter::new("entrada como convidado", 10, Duration::from_secs(60 * 60)),
        login_limit: RateLimiter::new("tentativas de login", 20, Duration::from_secs(15 * 60)),
        upload_limit: RateLimiter::new("envio de imagens", 60, Duration::from_secs(60 * 60)),
    });

    // Imagens escolhidas mas nunca enviadas não ficam ocupando disco para sempre
    match state.messages.purge_orphan_attachments(ORPHAN_ATTACHMENT_MAX_AGE_MS) {
        Ok(file_names) if !file_names.is_empty() => {
            for file_name in &file_names {
                if let Some(path) = safe_upload_path(&attachments_dir, file_name) {
                    let _ = tokio::fs::remove_file(path).await;
                }
            }
            println!("🧹 {} imagem(ns) enviada(s) e nunca postada(s) foram descartadas.", file_names.len());
        }
        Ok(_) => {}
        Err(e) => eprintln!("⚠️ Falha ao limpar anexos órfãos: {}", e),
    }

    let app = Router::new()
        .route("/", get(root_handler))
        .route("/health", get(health_handler))
        .route("/api/version", get(version_handler))
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
        .route(
            "/api/channels/{channel_id}/attachments",
            post(upload_attachment_handler).layer(DefaultBodyLimit::max(MAX_ATTACHMENT_BYTES)),
        )
        .route("/api/users/me/profile", patch(update_profile_handler))
        .route("/api/users/me/presence", patch(update_presence_handler))
        .route(
            "/api/users/me/avatar",
            post(upload_avatar_handler).layer(DefaultBodyLimit::max(MAX_IMAGE_BYTES)),
        )
        .route("/api/users/me/account", get(account_handler))
        .route("/api/users/me/password", post(change_password_handler))
        .route("/api/users/me/sessions/revoke-others", post(revoke_sessions_handler))
        .route("/api/servers", get(list_servers_handler).post(create_server_handler))
        .route("/api/servers/{server_id}", patch(rename_server_handler).delete(delete_server_handler))
        .route(
            "/api/servers/{server_id}/icon",
            post(upload_server_icon_handler).layer(DefaultBodyLimit::max(MAX_IMAGE_BYTES)),
        )
        .route("/api/servers/{server_id}/channels", post(create_channel_handler))
        // Estático antes do parâmetro: "order" nunca é confundido com um ID de canal
        .route("/api/servers/{server_id}/channels/order", post(reorder_channels_handler))
        .route(
            "/api/servers/{server_id}/channels/{channel_id}",
            patch(update_channel_handler).delete(delete_channel_handler),
        )
        .route("/api/servers/{server_id}/leave", post(leave_server_handler))
        .route("/api/servers/{server_id}/members", get(server_members_handler))
        .route("/api/servers/{server_id}/voice", get(server_voice_handler))
        .route("/api/voice/token", get(voice_token_handler))
        .route("/api/servers/{server_id}/invites", post(create_invite_handler))
        .route("/api/invites/{code}/accept", post(accept_invite_handler))
        // Avatares e ícones continuam abertos: são públicos por natureza.
        // As imagens do chat, não — elas saem por /api/attachments/{id}, com endereço assinado.
        .nest_service("/avatars", ServeDir::new(&avatars_dir))
        .nest_service("/icons", ServeDir::new(&icons_dir))
        .route("/api/attachments/{attachment_id}", get(attachment_handler))
        .route("/ws", get(ws_handler))
        .layer(cors)
        .with_state(state);

    println!("🦀 DasCord v{} Real-Time Rust Server listening on http://{}", SERVER_VERSION, addr);
    println!("⚡ WebSocket endpoint: ws://{}/ws", addr);

    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .expect("Failed to bind TCP listener");

    // with_connect_info: sem isso o servidor não enxerga o IP de quem chega
    axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>())
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
        version: SERVER_VERSION.to_string(),
        engine: "Axum + Tokio + WebSockets".to_string(),
        active_connections: connections,
        port: state.port,
    })
}

/// Versão do servidor e a mínima do app, mais as regras de entrada, para a tela
/// de login não oferecer o que este servidor não aceita.
/// Sem autenticação: o app confere antes do login.
async fn version_handler(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    Json(json!({
        "version": SERVER_VERSION,
        "minClientVersion": MIN_CLIENT_VERSION,
        "requireInvite": state.policy.require_invite,
        "allowGuests": state.policy.allow_guests,
    }))
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
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(payload): Json<RegisterRequest>,
) -> impl IntoResponse {
    let ip = client_ip(&state, &headers, addr);
    if !state.register_limit.check(&ip) {
        return auth_failure(
            StatusCode::TOO_MANY_REQUESTS,
            "Muitas contas criadas deste endereço. Tente de novo mais tarde.".to_string(),
        );
    }

    // O convite é conferido antes de criar qualquer coisa, e só é consumido no fim
    let invite = payload.invite_code.clone().filter(|code| !code.trim().is_empty());
    if state.policy.require_invite {
        let Some(code) = invite.as_deref() else {
            return auth_failure(
                StatusCode::FORBIDDEN,
                "Este servidor é fechado: você precisa de um convite para criar uma conta.".to_string(),
            );
        };
        if state.servers.peek_invite(code).is_err() {
            return auth_failure(StatusCode::FORBIDDEN, "Convite inválido ou expirado.".to_string());
        }
    }

    // argon2 é CPU-bound: roda fora das threads do runtime async
    let st = state.clone();
    let result = tokio::task::spawn_blocking(move || st.auth.register(payload, &st.snowflake)).await;

    match result {
        Ok(Ok((token, user))) => {
            welcome_to_default_servers(&state, &user);
            // Quem chegou por convite entra no servidor de quem convidou
            if let Some(code) = invite.as_deref() {
                match state.servers.accept_invite(code, &user.id) {
                    Ok((server, joined)) if joined => publish_member_joined(&state, &server.id, &user),
                    Ok(_) => {}
                    Err(_) => eprintln!("⚠️ Conta criada, mas o convite não pôde ser usado: {}", code),
                }
            }
            auth_success(StatusCode::CREATED, token, user)
        }
        Ok(Err(err)) => auth_failure(StatusCode::BAD_REQUEST, err),
        Err(_) => auth_failure(StatusCode::INTERNAL_SERVER_ERROR, "Erro interno do servidor.".to_string()),
    }
}

// Handler de Login
async fn login_handler(
    State(state): State<Arc<AppState>>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(payload): Json<LoginRequest>,
) -> impl IntoResponse {
    // Limite por IP além do limite por conta: um não substitui o outro.
    // Por conta, protege a senha; por IP, impede varrer várias contas de um lugar só.
    let ip = client_ip(&state, &headers, addr);
    if !state.login_limit.check(&ip) {
        return auth_failure(
            StatusCode::TOO_MANY_REQUESTS,
            "Muitas tentativas deste endereço. Aguarde alguns minutos.".to_string(),
        );
    }

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
async fn guest_handler(
    State(state): State<Arc<AppState>>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> impl IntoResponse {
    if !state.policy.allow_guests {
        return auth_failure(
            StatusCode::FORBIDDEN,
            "Este servidor não aceita convidados. Peça um convite para criar uma conta.".to_string(),
        );
    }
    let ip = client_ip(&state, &headers, addr);
    if !state.guest_limit.check(&ip) {
        return auth_failure(
            StatusCode::TOO_MANY_REQUESTS,
            "Muitas entradas como convidado deste endereço. Tente de novo mais tarde.".to_string(),
        );
    }

    match state.auth.create_guest(&state.snowflake) {
        Ok((token, user)) => {
            welcome_to_default_servers(&state, &user);
            auth_success(StatusCode::CREATED, token, user)
        }
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

fn is_connected(state: &AppState, user_id: &str) -> bool {
    state.presence.lock().unwrap().get(user_id).map_or(false, |count| *count > 0)
}

/// Status como os outros enxergam: sem conexão aberta, é offline
fn apply_presence(state: &AppState, user: &mut PublicUser) {
    if !is_connected(state, &user.id) {
        user.status = "offline".to_string();
    }
}

/// Avisa as outras sessões do próprio usuário (status real) e, com o status visível,
/// os amigos e quem divide algum servidor com ele (listas de membros)
fn broadcast_user_update(state: &AppState, user: &PublicUser, include_self: bool) {
    state.voice.update_profile(&user.id, &user.name, &user.avatar);
    if include_self {
        let event = json!({ "type": "user-updated", "channelId": "", "data": user });
        publish(state, event, Target::Users(vec![user.id.clone()]));
    }
    let mut audience = state.friends.friend_ids(&user.id);
    audience.extend(state.servers.co_member_ids(&user.id));
    audience.sort();
    audience.dedup();
    if !audience.is_empty() {
        let mut visible = user.clone();
        apply_presence(state, &mut visible);
        let event = json!({ "type": "user-updated", "channelId": "", "data": visible });
        publish(state, event, Target::Users(audience));
    }
}

// ---------- Configurações do usuário ----------

type JsonReply = (StatusCode, Json<serde_json::Value>);

fn json_error(status: StatusCode, error: &str) -> JsonReply {
    (status, Json(json!({ "success": false, "error": error })))
}

/// (token, user_id) da sessão, ou a resposta 401 pronta
fn require_session(state: &AppState, headers: &HeaderMap) -> Result<(String, String), JsonReply> {
    let unauthorized = || json_error(StatusCode::UNAUTHORIZED, "Sessão inválida ou expirada.");
    let token = extract_token(headers).ok_or_else(unauthorized)?;
    let user_id = state.auth.get_user_id_by_token(&token).ok_or_else(unauthorized)?;
    Ok((token, user_id))
}

#[derive(Deserialize)]
struct ProfilePayload {
    #[serde(rename = "displayName")]
    display_name: String,
}

async fn update_profile_handler(
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
struct PresencePayload {
    status: String,
    #[serde(rename = "customStatus", default)]
    custom_status: String,
}

async fn update_presence_handler(
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

/// Identifica a imagem pelos primeiros bytes, sem confiar no Content-Type
fn image_extension(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
        Some("png")
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("jpg")
    } else if bytes.starts_with(b"GIF8") {
        Some("gif")
    } else if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("webp")
    } else {
        None
    }
}

async fn upload_avatar_handler(
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

/// Salva uma imagem enviada (conferida pelos primeiros bytes). Devolve (nome do arquivo, caminho).
async fn save_uploaded_image(
    dir: &Path,
    name_prefix: &str,
    snowflake: &SnowflakeGenerator,
    body: &[u8],
) -> Result<(String, PathBuf), JsonReply> {
    let Some(extension) = image_extension(body) else {
        return Err(json_error(StatusCode::BAD_REQUEST, "Formato de imagem inválido. Use PNG, JPG, GIF ou WebP."));
    };
    let file_name = format!("{}_{}.{}", name_prefix, snowflake.next_id_string(), extension);
    let file_path = dir.join(&file_name);
    if let Err(e) = tokio::fs::write(&file_path, body).await {
        eprintln!("⚠️ Falha ao salvar imagem: {}", e);
        return Err(json_error(StatusCode::INTERNAL_SERVER_ERROR, "Não foi possível salvar a imagem."));
    }
    Ok((file_name, file_path))
}

/// Apaga o arquivo que acabou de ser substituído.
///
/// Recebe o que estava guardado no banco: o avatar padrão é um endereço
/// externo, e um nome de arquivo inválido não passa pela conferência — então
/// nenhum dos dois apaga nada.
async fn remove_replaced_upload(dir: &Path, old_file: &str) {
    if let Some(path) = safe_upload_path(dir, old_file) {
        let _ = tokio::fs::remove_file(path).await;
    }
}

/// Caminho do arquivo dentro da pasta, ou None se o nome tentar sair dela
fn safe_upload_path(dir: &Path, file_name: &str) -> Option<PathBuf> {
    if file_name.is_empty() || file_name.contains(['/', '\\']) || file_name.contains("..") {
        return None;
    }
    Some(dir.join(file_name))
}

/// Endereço temporário de um anexo. Vale por poucos minutos e não serve para mais nada:
/// quem o recebe já teve o acesso ao canal conferido aqui.
fn sign_attachment(state: &AppState, attachment: &mut AttachmentDto, expires_at: i64) {
    let signature = state.signer.sign(&attachment.id, expires_at);
    attachment.url = format!(
        "{}/api/attachments/{}?expires={}&sig={}",
        state.public_url, attachment.id, expires_at, signature
    );
}

/// Troca os nomes de arquivo pelos endereços assinados, logo antes de a mensagem
/// sair para o app — pelo histórico ou pelo WebSocket.
fn sign_message_attachments(state: &AppState, message: &mut MessageDto) {
    if message.attachments.is_empty() {
        return;
    }
    let expires_at = db::now_ms() + ATTACHMENT_URL_TTL_MS;
    for attachment in message.attachments.iter_mut() {
        sign_attachment(state, attachment, expires_at);
    }
}

#[derive(Deserialize)]
struct SignedAttachmentQuery {
    expires: i64,
    sig: String,
}

/// Entrega a imagem a quem chega com um endereço assinado e dentro da validade.
/// Sem `ServeDir`: acertar (ou adivinhar) o nome do arquivo não basta mais.
async fn attachment_handler(
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
struct AttachmentQuery {
    /// Nome original do arquivo, só para exibição
    #[serde(default)]
    name: String,
}

/// Recebe uma imagem para um canal. Ela fica guardada sem mensagem até o app
/// enviar a mensagem que a cita, e some sozinha se isso nunca acontecer.
async fn upload_attachment_handler(
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

fn server_error(err: ServerError) -> JsonReply {
    match err {
        ServerError::NotFound(msg) => json_error(StatusCode::NOT_FOUND, msg),
        ServerError::Forbidden(msg) => json_error(StatusCode::FORBIDDEN, msg),
        ServerError::Invalid(msg) => json_error(StatusCode::BAD_REQUEST, &msg),
        ServerError::Internal(msg) => json_error(StatusCode::INTERNAL_SERVER_ERROR, &msg),
    }
}

/// Envia o evento para todos os membros atuais do servidor
fn publish_to_server(state: &AppState, server_id: &str, event: serde_json::Value) {
    let members = state.servers.member_ids(server_id);
    if !members.is_empty() {
        publish(state, event, Target::Users(members));
    }
}

fn publish_server_updated(state: &AppState, server: &ServerDto) {
    let event = json!({ "type": "server-updated", "channelId": "", "data": { "server": server } });
    publish_to_server(state, &server.id, event);
}

/// Os membros (inclusive as outras sessões de quem entrou) recebem o novo membro
fn publish_member_joined(state: &AppState, server_id: &str, user: &PublicUser) {
    let mut visible = user.clone();
    apply_presence(state, &mut visible);
    let event = json!({
        "type": "server-member-joined",
        "channelId": "",
        "data": { "serverId": server_id, "member": visible },
    });
    publish_to_server(state, server_id, event);
}

/// Toda conta e todo convidado novo entra no DasIdeia HQ.
/// Numa instalação fechada isso é desligado: quem chega entra só no servidor
/// de quem o convidou.
fn welcome_to_default_servers(state: &AppState, user: &PublicUser) {
    if !state.policy.auto_join_default {
        return;
    }
    for server_id in state.servers.join_default_servers(&user.id) {
        publish_member_joined(state, &server_id, user);
    }
}

async fn list_servers_handler(State(state): State<Arc<AppState>>, headers: HeaderMap) -> JsonReply {
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
struct ServerNamePayload {
    name: String,
}

#[derive(Deserialize)]
struct CreateChannelPayload {
    name: String,
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    category: String,
}

/// Campo ausente fica como está; só o que vem é trocado
#[derive(Deserialize)]
struct UpdateChannelPayload {
    name: Option<String>,
    topic: Option<String>,
    category: Option<String>,
}

#[derive(Deserialize)]
struct ReorderChannelsPayload {
    #[serde(rename = "channelIds")]
    channel_ids: Vec<String>,
}

async fn create_channel_handler(
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

async fn update_channel_handler(
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

async fn delete_channel_handler(
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

async fn reorder_channels_handler(
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

async fn create_server_handler(
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

async fn rename_server_handler(
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

async fn upload_server_icon_handler(
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

async fn delete_server_handler(
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

async fn leave_server_handler(
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

async fn server_members_handler(
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

#[derive(Deserialize)]
struct VoiceTokenQuery {
    #[serde(rename = "channelId")]
    channel_id: String,
}

/// Credenciais para entrar no canal no servidor de mídia.
/// 503 quando não há SFU configurado: o app então usa a malha P2P.
async fn voice_token_handler(
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
async fn server_voice_handler(
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

async fn create_invite_handler(
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

async fn accept_invite_handler(
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

async fn account_handler(State(state): State<Arc<AppState>>, headers: HeaderMap) -> JsonReply {
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
struct PasswordPayload {
    #[serde(rename = "currentPassword")]
    current_password: String,
    #[serde(rename = "newPassword")]
    new_password: String,
}

async fn change_password_handler(
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

async fn revoke_sessions_handler(State(state): State<Arc<AppState>>, headers: HeaderMap) -> JsonReply {
    let (token, user_id) = match require_session(&state, &headers) {
        Ok(session) => session,
        Err(reply) => return reply,
    };
    match state.auth.revoke_other_sessions(&user_id, &token) {
        Ok(revoked) => (StatusCode::OK, Json(json!({ "success": true, "revokedSessions": revoked }))),
        Err(err) => json_error(StatusCode::INTERNAL_SERVER_ERROR, &err),
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
        while let Some(Ok(msg)) = receiver.next().await {
            match msg {
                Message::Text(text) => handle_client_event(&recv_state, &user, conn_id, &text, &recv_voice_channel),
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
fn handle_client_event(
    state: &AppState,
    user: &PublicUser,
    conn_id: u64,
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

/// Tira a conexão do canal de voz e avisa os membros.
/// Sem exigir ser membro: quem acabou de sair do servidor ainda avisa que saiu da voz.
fn leave_voice_channel(state: &AppState, conn_id: u64, channel_id: &str, user_id: &str) {
    // Se o usuário está no canal por outra sessão, para os outros ele continua lá
    if let LeaveOutcome::HeldByOtherConnection = state.voice.leave(conn_id, channel_id, user_id) {
        return;
    }
    if let Some(audience) = state.servers.channel_member_ids(channel_id) {
        publish_voice_leave(state, channel_id, user_id, audience);
    }
}

fn publish_voice_leave(state: &AppState, channel_id: &str, user_id: &str, audience: Vec<String>) {
    let event = json!({
        "type": "voice-leave",
        "channelId": channel_id,
        "data": { "userId": user_id },
    });
    publish(state, event, Target::Users(audience));
}

/// Quem recebe os eventos de um canal, ou None se o usuário não tem acesso a ele.
/// DMs ("dm_<a>_<b>"): só os dois participantes, e só se forem amigos.
/// Canais de servidor: só os membros do servidor. Canal inexistente: ninguém.
fn channel_target(state: &AppState, user_id: &str, channel_id: &str) -> Option<Target> {
    let Some(pair) = channel_id.strip_prefix("dm_") else {
        let members = state.servers.channel_member_ids(channel_id)?;
        if !members.iter().any(|id| id == user_id) {
            return None;
        }
        return Some(Target::Users(members));
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
