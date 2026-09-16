//! Presença: quem está conectado agora e quem precisa saber quando isso muda.

use serde_json::json;

use crate::auth::PublicUser;
use crate::state::{publish, AppState, Target};


pub fn is_connected(state: &AppState, user_id: &str) -> bool {
    state.presence.lock().unwrap().get(user_id).map_or(false, |count| *count > 0)
}

/// Status como os outros enxergam: sem conexão aberta, é offline
pub fn apply_presence(state: &AppState, user: &mut PublicUser) {
    if !is_connected(state, &user.id) {
        user.status = "offline".to_string();
    }
}

/// Avisa as outras sessões do próprio usuário (status real) e, com o status visível,
/// os amigos e quem divide algum servidor com ele (listas de membros)
pub fn broadcast_user_update(state: &AppState, user: &PublicUser, include_self: bool) {
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
