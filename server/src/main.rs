//! Sobe o servidor: lê a configuração do ambiente, abre o banco, monta o estado
//! compartilhado e entrega o roteador. As rotas ficam em `routes`, o protocolo do
//! WebSocket em `ws`, e as regras de cada assunto nos stores de cada domínio.

use axum::http::{header, HeaderValue, Method};
use std::{
    collections::HashMap,
    net::SocketAddr,
    path::Path,
    sync::{
        atomic::{AtomicU64, AtomicUsize},
        Arc, Mutex,
    },
    time::Duration,
};
use tokio::sync::broadcast;
use tower_http::cors::{AllowOrigin, CorsLayer};

mod auth;
mod db;
mod events;
mod friends;
mod media;
mod messages;
mod migration;
mod policy;
mod presence;
mod ratelimit;
mod routes;
mod servers;
mod sfu;
mod signing;
mod snowflake;
mod state;
mod uploads;
mod voice;
mod ws;

use auth::AuthStore;
use db::Db;
use friends::FriendsStore;
use messages::MessageStore;
use policy::AccessPolicy;
use ratelimit::RateLimiter;
use servers::ServerStore;
use sfu::SfuConfig;
use signing::UrlSigner;
use snowflake::SnowflakeGenerator;
use state::AppState;
use uploads::safe_upload_path;
use voice::VoiceRegistry;

/// Pasta padrão dos dados: server/data, independente de onde o servidor foi iniciado.
/// Defina DASCORD_DATA_DIR para usar outro local (ex: em produção).
const DEFAULT_DATA_DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/data");

const DEFAULT_BIND: &str = "127.0.0.1:3001";
const DEFAULT_ALLOWED_ORIGINS: &str =
    "http://localhost:1420,http://127.0.0.1:1420,http://tauri.localhost,https://tauri.localhost,tauri://localhost";
/// Versão deste servidor, vinda do Cargo.toml (sincronizado com o package.json)
pub const SERVER_VERSION: &str = env!("CARGO_PKG_VERSION");
/// App mais antigo que este servidor aceita. Suba quando a API mudar de forma incompatível.
pub const MIN_CLIENT_VERSION: &str = "0.2.0";
/// Limite de avatares e ícones de servidor
pub const MAX_IMAGE_BYTES: usize = 2 * 1024 * 1024;
/// Limite das imagens enviadas no chat, que podem ser bem maiores que um avatar
pub const MAX_ATTACHMENT_BYTES: usize = 8 * 1024 * 1024;
/// Upload que não virou mensagem nesse tempo é descartado na subida do servidor
const ORPHAN_ATTACHMENT_MAX_AGE_MS: i64 = 24 * 60 * 60 * 1000;

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
    let updates_dir = data_dir.join("updates");
    std::fs::create_dir_all(&updates_dir).expect("Falha ao criar a pasta de atualizações");
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
        presence: Mutex::new(HashMap::new()),
        voice: VoiceRegistry::default(),
        sfu: SfuConfig::from_env(),
        next_conn_id: AtomicU64::new(1),
        avatars_dir: avatars_dir.clone(),
        icons_dir: icons_dir.clone(),
        attachments_dir: attachments_dir.clone(),
        updates_dir: updates_dir.clone(),
        public_url,
        policy: AccessPolicy::from_env(),
        signer: UrlSigner::load(data_dir),
        register_limit: RateLimiter::new("cadastro", 5, Duration::from_secs(60 * 60)),
        guest_limit: RateLimiter::new("entrada como convidado", 10, Duration::from_secs(60 * 60)),
        login_limit: RateLimiter::new("tentativas de login", 20, Duration::from_secs(15 * 60)),
        upload_limit: RateLimiter::new("envio de imagens", 60, Duration::from_secs(60 * 60)),
        invite_limit: RateLimiter::new("uso de convite", 20, Duration::from_secs(60 * 60)),
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

    let app = routes::router(&avatars_dir, &icons_dir, &updates_dir)
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
