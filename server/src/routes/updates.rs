//! Atualização do app desktop. O updater do Tauri pergunta aqui se há versão
//! nova, e a resposta segue o formato dinâmico dele: 204 quando não há nada.
//!
//! Publicar é só copiar três coisas para a pasta de atualizações: o instalador,
//! o `.sig` que o build gera ao lado dele e o `latest.json`. O manifesto é lido
//! a cada pergunta, então a versão nova vale sem reiniciar o servidor.

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::ErrorKind;
use std::sync::Arc;

use crate::state::{json_error, AppState};

#[derive(Deserialize)]
struct Manifest {
    version: String,
    #[serde(default)]
    notes: String,
    /// RFC 3339; o Tauri recusa a resposta inteira se vier em outro formato
    pub_date: Option<String>,
    /// Plataforma no formato do Tauri ("windows-x86_64") → nome do instalador na pasta
    platforms: HashMap<String, String>,
}

#[derive(Serialize)]
struct UpdateResponse {
    version: String,
    notes: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub_date: Option<String>,
    url: String,
    signature: String,
}

#[derive(Serialize)]
struct DownloadResponse {
    version: String,
    url: String,
}

/// `GET /api/update/{target}/{arch}/{current_version}`. Sem sessão: o app
/// confere antes do login, e o que sai daqui é o mesmo instalador para todos.
pub async fn update_handler(
    State(state): State<Arc<AppState>>,
    Path((target, arch, current_version)): Path<(String, String, String)>,
) -> Response {
    let Some(current) = parse_version(&current_version) else {
        return json_error(StatusCode::BAD_REQUEST, "Versão do app inválida.").into_response();
    };

    let (manifest, latest, file_name) = match published_installer(&state, &target, &arch).await {
        Ok(Some(found)) => found,
        Ok(None) => return StatusCode::NO_CONTENT.into_response(),
        Err(response) => return response,
    };
    if latest <= current {
        return StatusCode::NO_CONTENT.into_response();
    }
    // A assinatura vem do .sig do build, não copiada à mão para o manifesto:
    // um caractere trocado e todo app instalado recusaria a atualização.
    let sig_path = state.updates_dir.join(format!("{file_name}.sig"));
    let signature = match tokio::fs::read_to_string(&sig_path).await {
        Ok(signature) => signature.trim().to_string(),
        Err(e) => return unavailable(&format!("assinatura {} ilegível: {}", sig_path.display(), e)),
    };

    Json(UpdateResponse {
        version: manifest.version,
        notes: manifest.notes,
        pub_date: manifest.pub_date,
        url: format!("{}/updates/{}", state.public_url, file_name),
        signature,
    })
    .into_response()
}

/// `GET /api/download/{target}/{arch}`: o instalador para quem ainda usa o app
/// pelo navegador. É o mesmo arquivo que o updater entrega, então instalar por
/// aqui já deixa a pessoa no caminho das atualizações automáticas.
pub async fn download_handler(
    State(state): State<Arc<AppState>>,
    Path((target, arch)): Path<(String, String)>,
) -> Response {
    match published_installer(&state, &target, &arch).await {
        Ok(Some((manifest, _, file_name))) => Json(DownloadResponse {
            version: manifest.version,
            url: format!("{}/updates/{}", state.public_url, file_name),
        })
        .into_response(),
        Ok(None) => StatusCode::NO_CONTENT.into_response(),
        Err(response) => response,
    }
}

/// O instalador publicado para a plataforma, já conferido na pasta. `None` quando
/// não há o que oferecer; publicação quebrada volta como a resposta de erro pronta.
async fn published_installer(
    state: &AppState,
    target: &str,
    arch: &str,
) -> Result<Option<(Manifest, (u64, u64, u64), String)>, Response> {
    let manifest = match read_manifest(state).await {
        Ok(Some(manifest)) => manifest,
        // Nada publicado ainda não é erro: só não há o que oferecer
        Ok(None) => return Ok(None),
        Err(reason) => return Err(unavailable(&reason)),
    };
    let Some(latest) = parse_version(&manifest.version) else {
        return Err(unavailable(&format!("versão \"{}\" do latest.json é inválida", manifest.version)));
    };
    // Plataforma sem instalador publicado fica na versão que tem, em vez de ver erro
    let Some(file_name) = manifest.platforms.get(&format!("{target}-{arch}")).cloned() else {
        return Ok(None);
    };
    if !is_plain_file_name(&file_name) {
        return Err(unavailable(&format!("nome de instalador inválido no latest.json: \"{file_name}\"")));
    }
    let installer = state.updates_dir.join(&file_name);
    if !tokio::fs::try_exists(&installer).await.unwrap_or(false) {
        return Err(unavailable(&format!("instalador {} não está na pasta", installer.display())));
    }
    Ok(Some((manifest, latest, file_name)))
}

async fn read_manifest(state: &AppState) -> Result<Option<Manifest>, String> {
    let path = state.updates_dir.join("latest.json");
    let raw = match tokio::fs::read(&path).await {
        Ok(raw) => raw,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("falha ao ler {}: {}", path.display(), e)),
    };
    serde_json::from_slice(&raw)
        .map(Some)
        .map_err(|e| format!("{} malformado: {}", path.display(), e))
}

/// Publicação quebrada é problema de quem publicou: o detalhe vai para o log,
/// e o app só fica sabendo que agora não dá.
fn unavailable(reason: &str) -> Response {
    eprintln!("⚠️ Atualização indisponível: {}", reason);
    json_error(StatusCode::SERVICE_UNAVAILABLE, "Atualização indisponível no momento.").into_response()
}

/// O nome vai direto para o caminho no disco e para a URL: nada de separador,
/// `..` ou caractere que precisaria de escape.
fn is_plain_file_name(name: &str) -> bool {
    !name.is_empty()
        && !name.contains("..")
        && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

/// "0.2.1" → (0, 2, 1). Sufixo de pré-lançamento ("-beta") é ignorado: o
/// projeto não publica essas versões, e compará-las exigiria as regras do semver.
fn parse_version(version: &str) -> Option<(u64, u64, u64)> {
    let core = version.trim().trim_start_matches('v');
    let core = core.split(['-', '+']).next()?;
    let mut parts = core.split('.').map(|part| part.parse::<u64>().ok());
    let version = (parts.next()??, parts.next()??, parts.next()??);
    parts.next().is_none().then_some(version)
}
