//! Imagens que chegam de fora: conferir o formato, guardar em disco sem deixar
//! o nome escolher o caminho, e assinar o endereço temporário dos anexos.

use axum::http::StatusCode;
use std::path::{Path, PathBuf};

use crate::db;
use crate::messages::{AttachmentDto, MessageDto};
use crate::signing::ATTACHMENT_URL_TTL_MS;
use crate::snowflake::SnowflakeGenerator;
use crate::state::{json_error, AppState, JsonReply};

/// Identifica a imagem pelos primeiros bytes, sem confiar no Content-Type
pub fn image_extension(bytes: &[u8]) -> Option<&'static str> {
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

/// Salva uma imagem enviada (conferida pelos primeiros bytes). Devolve (nome do arquivo, caminho).
pub async fn save_uploaded_image(
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
pub async fn remove_replaced_upload(dir: &Path, old_file: &str) {
    if let Some(path) = safe_upload_path(dir, old_file) {
        let _ = tokio::fs::remove_file(path).await;
    }
}

/// Caminho do arquivo dentro da pasta, ou None se o nome tentar sair dela
pub fn safe_upload_path(dir: &Path, file_name: &str) -> Option<PathBuf> {
    if file_name.is_empty() || file_name.contains(['/', '\\']) || file_name.contains("..") {
        return None;
    }
    Some(dir.join(file_name))
}

/// Endereço temporário de um anexo. Vale por poucos minutos e não serve para mais nada:
/// quem o recebe já teve o acesso ao canal conferido aqui.
pub fn sign_attachment(state: &AppState, attachment: &mut AttachmentDto, expires_at: i64) {
    let signature = state.signer.sign(&attachment.id, expires_at);
    attachment.url = format!(
        "{}/api/attachments/{}?expires={}&sig={}",
        state.public_url, attachment.id, expires_at, signature
    );
}

/// Troca os nomes de arquivo pelos endereços assinados, logo antes de a mensagem
/// sair para o app — pelo histórico ou pelo WebSocket.
pub fn sign_message_attachments(state: &AppState, message: &mut MessageDto) {
    if message.attachments.is_empty() {
        return;
    }
    let expires_at = db::now_ms() + ATTACHMENT_URL_TTL_MS;
    for attachment in message.attachments.iter_mut() {
        sign_attachment(state, attachment, expires_at);
    }
}
