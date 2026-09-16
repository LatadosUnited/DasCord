use serde::Serialize;
use std::{collections::HashMap, sync::Mutex};

/// Quem está em um canal de voz, como os outros membros do servidor o veem
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceMember {
    pub id: String,
    pub name: String,
    pub avatar: String,
    pub muted: bool,
    pub deafened: bool,
    pub streaming: bool,
}

struct Seat {
    /// Conexão WebSocket que entrou; só ela (ou a queda dela) tira o usuário do canal
    conn_id: u64,
    member: VoiceMember,
}

struct Room {
    server_id: String,
    seats: Vec<Seat>,
}

/// Resultado de um pedido de saída
pub enum LeaveOutcome {
    Removed,
    /// O usuário está no canal por outra conexão: os outros não devem ser avisados
    HeldByOtherConnection,
    NotPresent,
}

/// Canais de voz ocupados, só em memória: some quando o servidor reinicia
#[derive(Default)]
pub struct VoiceRegistry {
    rooms: Mutex<HashMap<String, Room>>,
}

impl VoiceRegistry {
    /// Coloca o usuário no canal. Um usuário fica em um canal por vez:
    /// devolve o canal anterior de onde ele foi tirado, se houver.
    pub fn join(&self, conn_id: u64, server_id: &str, channel_id: &str, member: VoiceMember) -> Option<String> {
        let mut rooms = self.rooms.lock().unwrap();
        let previous = remove_user(&mut rooms, &member.id, |room_id| room_id != channel_id);

        let room = rooms.entry(channel_id.to_string()).or_insert_with(|| Room {
            server_id: server_id.to_string(),
            seats: Vec::new(),
        });
        match room.seats.iter_mut().find(|s| s.member.id == member.id) {
            Some(seat) => *seat = Seat { conn_id, member },
            None => room.seats.push(Seat { conn_id, member }),
        }
        previous
    }

    pub fn leave(&self, conn_id: u64, channel_id: &str, user_id: &str) -> LeaveOutcome {
        let mut rooms = self.rooms.lock().unwrap();
        let Some(room) = rooms.get_mut(channel_id) else {
            return LeaveOutcome::NotPresent;
        };
        let Some(index) = room.seats.iter().position(|s| s.member.id == user_id) else {
            return LeaveOutcome::NotPresent;
        };
        if room.seats[index].conn_id != conn_id {
            return LeaveOutcome::HeldByOtherConnection;
        }
        room.seats.remove(index);
        if room.seats.is_empty() {
            rooms.remove(channel_id);
        }
        LeaveOutcome::Removed
    }

    /// Altera o participante se ele estiver no canal por esta conexão
    pub fn update(&self, conn_id: u64, channel_id: &str, user_id: &str, apply: impl FnOnce(&mut VoiceMember)) -> bool {
        let mut rooms = self.rooms.lock().unwrap();
        let seat = rooms
            .get_mut(channel_id)
            .and_then(|room| room.seats.iter_mut().find(|s| s.member.id == user_id && s.conn_id == conn_id));
        match seat {
            Some(seat) => {
                apply(&mut seat.member);
                true
            }
            None => false,
        }
    }

    /// Nome e avatar novos em qualquer canal onde o usuário esteja
    pub fn update_profile(&self, user_id: &str, name: &str, avatar: &str) {
        let mut rooms = self.rooms.lock().unwrap();
        for seat in rooms.values_mut().flat_map(|room| room.seats.iter_mut()) {
            if seat.member.id == user_id {
                seat.member.name = name.to_string();
                seat.member.avatar = avatar.to_string();
            }
        }
    }

    /// Canais ocupados de um servidor, na ordem em que as pessoas entraram
    pub fn snapshot(&self, server_id: &str) -> HashMap<String, Vec<VoiceMember>> {
        let rooms = self.rooms.lock().unwrap();
        rooms
            .iter()
            .filter(|(_, room)| room.server_id == server_id)
            .map(|(channel_id, room)| (channel_id.clone(), room.seats.iter().map(|s| s.member.clone()).collect()))
            .collect()
    }

    /// Tira o usuário dos canais do servidor (saiu dele). Devolve o canal, se estava em um.
    pub fn remove_user_from_server(&self, server_id: &str, user_id: &str) -> Option<String> {
        let mut rooms = self.rooms.lock().unwrap();
        let in_server: Vec<String> = rooms
            .iter()
            .filter(|(_, room)| room.server_id == server_id)
            .map(|(id, _)| id.clone())
            .collect();
        remove_user(&mut rooms, user_id, |room_id| in_server.iter().any(|id| id == room_id))
    }

    /// O canal deixou de existir: a sala some junto
    pub fn remove_channel(&self, channel_id: &str) {
        self.rooms.lock().unwrap().remove(channel_id);
    }

    pub fn remove_server(&self, server_id: &str) {
        self.rooms.lock().unwrap().retain(|_, room| room.server_id != server_id);
    }
}

/// Remove o usuário dos canais aceitos pelo filtro; devolve o canal de onde saiu
fn remove_user(rooms: &mut HashMap<String, Room>, user_id: &str, filter: impl Fn(&str) -> bool) -> Option<String> {
    let mut left = None;
    rooms.retain(|room_id, room| {
        if filter(room_id) {
            let before = room.seats.len();
            room.seats.retain(|s| s.member.id != user_id);
            if room.seats.len() != before {
                left = Some(room_id.clone());
            }
        }
        !room.seats.is_empty()
    });
    left
}
