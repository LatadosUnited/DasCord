//! Quem recebe cada evento. Não existe "todos": um evento de canal vai para
//! quem tem acesso ao canal, e um de servidor para os membros dele.

use serde_json::json;

use crate::auth::PublicUser;
use crate::presence::apply_presence;
use crate::servers::ServerDto;
use crate::state::{publish, AppState, Target};
use crate::voice::LeaveOutcome;

/// Envia o evento para todos os membros atuais do servidor
pub fn publish_to_server(state: &AppState, server_id: &str, event: serde_json::Value) {
    let members = state.servers.member_ids(server_id);
    if !members.is_empty() {
        publish(state, event, Target::Users(members));
    }
}

pub fn publish_server_updated(state: &AppState, server: &ServerDto) {
    let event = json!({ "type": "server-updated", "channelId": "", "data": { "server": server } });
    publish_to_server(state, &server.id, event);
}

/// Os membros (inclusive as outras sessões de quem entrou) recebem o novo membro
pub fn publish_member_joined(state: &AppState, server_id: &str, user: &PublicUser) {
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
pub fn welcome_to_default_servers(state: &AppState, user: &PublicUser) {
    if !state.policy.auto_join_default {
        return;
    }
    for server_id in state.servers.join_default_servers(&user.id) {
        publish_member_joined(state, &server_id, user);
    }
}

/// Tira a conexão do canal de voz e avisa os membros.
/// Sem exigir ser membro: quem acabou de sair do servidor ainda avisa que saiu da voz.
pub fn leave_voice_channel(state: &AppState, conn_id: u64, channel_id: &str, user_id: &str) {
    // Se o usuário está no canal por outra sessão, para os outros ele continua lá
    if let LeaveOutcome::HeldByOtherConnection = state.voice.leave(conn_id, channel_id, user_id) {
        return;
    }
    if let Some(audience) = state.servers.channel_member_ids(channel_id) {
        publish_voice_leave(state, channel_id, user_id, audience);
    }
}

pub fn publish_voice_leave(state: &AppState, channel_id: &str, user_id: &str, audience: Vec<String>) {
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
pub fn channel_target(state: &AppState, user_id: &str, channel_id: &str) -> Option<Target> {
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
