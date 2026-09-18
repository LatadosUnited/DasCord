use serde::{Deserialize, Serialize};
use std::time::Instant;

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct SystemStats {
    pub app_name: String,
    pub version: String,
    pub engine: String,
    pub ram_usage_mb: f32,
    pub rust_version: String,
    pub ping_ms: u64,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ChatMessagePayload {
    pub id: String,
    pub channel_id: String,
    pub author_name: String,
    pub author_avatar: String,
    pub content: String,
    pub timestamp: String,
}

#[tauri::command]
fn get_system_stats() -> SystemStats {
    SystemStats {
        app_name: "DasCord".to_string(),
        // Vem do Cargo.toml, que scripts/sync-version.mjs mantém igual ao package.json
        version: env!("CARGO_PKG_VERSION").to_string(),
        engine: "Tauri v2 + WebView2 (Rust Core)".to_string(),
        ram_usage_mb: 38.4,
        rust_version: "Rust 1.96.0".to_string(),
        ping_ms: 1,
    }
}

#[tauri::command]
fn send_message_native(payload: ChatMessagePayload) -> Result<ChatMessagePayload, String> {
    let _start = Instant::now();
    Ok(payload)
}

mod controles;
mod entrada;
mod snowflake;
use snowflake::SnowflakeGenerator;
use std::sync::LazyLock;

static SNOWFLAKE: LazyLock<SnowflakeGenerator> = LazyLock::new(|| SnowflakeGenerator::new(1, 1));

#[tauri::command]
fn generate_snowflake() -> String {
    SNOWFLAKE.next_id_string()
}

#[tauri::command]
fn extract_snowflake_time(id: String) -> Result<u64, String> {
    let numeric_id = id.parse::<u64>().map_err(|e| e.to_string())?;
    Ok(SnowflakeGenerator::extract_timestamp(numeric_id))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        // A tecla de corte do controle remoto precisa funcionar com o jogo em foco
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(controles::ControlesVirtuais::default())
        .manage(entrada::Entrada::default())
        .invoke_handler(tauri::generate_handler![
            get_system_stats,
            send_message_native,
            generate_snowflake,
            extract_snowflake_time,
            controles::controle_virtual_verificar,
            controles::controle_virtual_conectar,
            controles::controle_virtual_atualizar,
            controles::controle_virtual_desconectar,
            controles::controle_virtual_desconectar_todos,
            controles::controle_virtual_instalar_driver,
            entrada::entrada_monitores,
            entrada::entrada_mouse_mover,
            entrada::entrada_mouse_botao,
            entrada::entrada_mouse_roda,
            entrada::entrada_tecla
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
