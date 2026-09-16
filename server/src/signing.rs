//! Endereços temporários e assinados para os arquivos enviados no chat.
//!
//! Um anexo não pode ser servido só porque alguém acertou a URL, mas também não dá
//! para exigir o cabeçalho `Authorization`: quem busca a imagem é a tag `<img>` do
//! app, que não manda cabeçalho nenhum. E o token de sessão não pode ir na URL —
//! endereço vaza em histórico, log de proxy e "copiar link".
//!
//! A saída é uma assinatura curta: o servidor confere quem pede **uma vez**, e
//! devolve um endereço que vale por poucos minutos e não serve para mais nada.

use hmac::{Hmac, Mac};
use sha2::Sha256;
use std::path::Path;

type HmacSha256 = Hmac<Sha256>;

/// Quanto tempo o endereço de um anexo continua valendo depois de gerado
pub const ATTACHMENT_URL_TTL_MS: i64 = 15 * 60 * 1000;

pub struct UrlSigner {
    secret: Vec<u8>,
}

impl UrlSigner {
    /// Usa DASCORD_SIGNING_SECRET; sem ela, gera um segredo na primeira subida e
    /// guarda em `signing.key`, junto do banco. Guardar (em vez de sortear a cada
    /// subida) evita que todo reinício quebre as imagens abertas na tela.
    pub fn load(data_dir: &Path) -> Self {
        if let Ok(from_env) = std::env::var("DASCORD_SIGNING_SECRET") {
            let from_env = from_env.trim();
            if !from_env.is_empty() {
                return Self {
                    secret: from_env.as_bytes().to_vec(),
                };
            }
        }

        let key_path = data_dir.join("signing.key");
        if let Ok(saved) = std::fs::read(&key_path) {
            if saved.len() >= 32 {
                return Self { secret: saved };
            }
        }

        let generated = format!("{}{}", uuid::Uuid::new_v4(), uuid::Uuid::new_v4());
        if let Err(e) = std::fs::write(&key_path, generated.as_bytes()) {
            eprintln!(
                "⚠️ Não foi possível guardar {}: {}. Os endereços de imagem vão mudar a cada reinício.",
                key_path.display(),
                e
            );
        }
        Self {
            secret: generated.into_bytes(),
        }
    }

    fn mac(&self, attachment_id: &str, expires_at: i64) -> Vec<u8> {
        // O segredo tem tamanho livre: o HMAC aceita qualquer chave
        let mut mac = HmacSha256::new_from_slice(&self.secret).expect("HMAC aceita chave de qualquer tamanho");
        mac.update(attachment_id.as_bytes());
        mac.update(b".");
        mac.update(expires_at.to_string().as_bytes());
        mac.finalize().into_bytes().to_vec()
    }

    pub fn sign(&self, attachment_id: &str, expires_at: i64) -> String {
        hex::encode(self.mac(attachment_id, expires_at))
    }

    /// Confere assinatura e validade. A comparação é feita byte a byte pelo próprio
    /// HMAC, em tempo constante: comparar com `==` deixaria o tempo de resposta
    /// contar quantos caracteres estavam certos.
    pub fn verify(&self, attachment_id: &str, expires_at: i64, signature: &str, now_ms: i64) -> bool {
        if expires_at <= now_ms {
            return false;
        }
        let Ok(provided) = hex::decode(signature) else {
            return false;
        };
        let mut mac = HmacSha256::new_from_slice(&self.secret).expect("HMAC aceita chave de qualquer tamanho");
        mac.update(attachment_id.as_bytes());
        mac.update(b".");
        mac.update(expires_at.to_string().as_bytes());
        mac.verify_slice(&provided).is_ok()
    }
}
