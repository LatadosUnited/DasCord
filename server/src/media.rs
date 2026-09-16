//! Endereço dos arquivos enviados (avatares e ícones de servidor).
//!
//! O banco guarda **só o nome do arquivo**; a URL é montada na leitura. Foi o
//! mesmo tratamento dado aos anexos do chat no esquema v6, e o motivo é o
//! mesmo: com o endereço do servidor embutido em cada linha, trocar de
//! domínio quebraria tudo o que já foi enviado.

use std::sync::OnceLock;

/// Vem de `DASCORD_PUBLIC_URL` e não muda enquanto o processo vive. Fica aqui
/// porque quem lê a coluna são funções bem fundo nos stores, longe do AppState.
static PUBLIC_URL: OnceLock<String> = OnceLock::new();

/// Chamado uma vez na subida do servidor, antes de atender qualquer requisição
pub fn set_public_url(url: &str) {
    let _ = PUBLIC_URL.set(url.trim_end_matches('/').to_string());
}

fn public_url() -> &'static str {
    PUBLIC_URL.get().map(String::as_str).unwrap_or_default()
}

/// Monta a URL de um arquivo guardado pelo nome.
///
/// Passa intacto o que já for endereço completo: o avatar padrão é do Unsplash,
/// e linhas antigas podem ter escapado da migração.
fn file_url(folder: &str, stored: &str) -> String {
    if stored.is_empty() || stored.contains("://") {
        return stored.to_string();
    }
    format!("{}/{}/{}", public_url(), folder, stored)
}

pub fn avatar_url(stored: &str) -> String {
    file_url("avatars", stored)
}

pub fn icon_url(stored: &str) -> String {
    file_url("icons", stored)
}

/// Nome do arquivo a partir de um valor vindo de fora (importação do formato
/// antigo). Um endereço nosso vira só o nome; qualquer outro passa intacto.
pub fn stored_name(value: &str, folder: &str) -> String {
    let marker = format!("/{}/", folder);
    match value.find(&marker) {
        Some(at) => value[at + marker.len()..].to_string(),
        None => value.to_string(),
    }
}
