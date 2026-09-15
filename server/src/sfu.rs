use livekit_api::access_token::{AccessToken, VideoGrants};
use std::time::Duration;

/// Quanto tempo o token de voz vale; o app pede outro a cada entrada em canal
const TOKEN_TTL: Duration = Duration::from_secs(2 * 60 * 60);

/// Servidor de mídia (SFU) configurado por ambiente.
/// Sem as três variáveis, o app cai para a malha P2P.
pub struct SfuConfig {
    /// Endereço que o app usa para conectar (ex: ws://localhost:7880)
    pub url: String,
    api_key: String,
    api_secret: String,
}

impl SfuConfig {
    /// Lê LIVEKIT_URL, LIVEKIT_API_KEY e LIVEKIT_API_SECRET; None se faltar alguma
    pub fn from_env() -> Option<Self> {
        let read = |name: &str| std::env::var(name).ok().map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
        Some(Self {
            url: read("LIVEKIT_URL")?,
            api_key: read("LIVEKIT_API_KEY")?,
            api_secret: read("LIVEKIT_API_SECRET")?,
        })
    }

    /// Token de entrada em um canal. A identidade é o ID do usuário, então
    /// o SFU só aceita quem o servidor autenticou.
    pub fn token_for(&self, channel_id: &str, user_id: &str, name: &str, avatar: &str) -> Result<String, String> {
        AccessToken::with_api_key(&self.api_key, &self.api_secret)
            .with_identity(user_id)
            .with_name(name)
            .with_metadata(&serde_json::json!({ "avatar": avatar }).to_string())
            .with_ttl(TOKEN_TTL)
            .with_grants(VideoGrants {
                room_join: true,
                room: channel_id.to_string(),
                can_publish: true,
                can_subscribe: true,
                can_publish_data: true,
                ..Default::default()
            })
            .to_jwt()
            .map_err(|err| format!("Não foi possível gerar o token de voz: {err}"))
    }
}
