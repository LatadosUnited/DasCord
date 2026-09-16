use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use uuid::Uuid;

use crate::auth::{public_user_by_id, PublicUser};
use crate::db::{internal_error, now_ms, Db};
use crate::snowflake::SnowflakeGenerator;

const MIN_SERVER_NAME_CHARS: usize = 2;
const MAX_SERVER_NAME_CHARS: usize = 100;
/// Mesmo limite do Discord: ninguém participa de mais de 100 servidores
const MAX_SERVERS_PER_USER: i64 = 100;
const INVITE_CODE_LEN: usize = 8;
/// Sem 0/O, 1/l/I: o código pode ser ditado ou copiado à mão
const INVITE_ALPHABET: &[u8] = b"abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const MAX_INVITE_AGE_SECONDS: i64 = 7 * 24 * 60 * 60;
const MAX_INVITE_USES: i64 = 100;

/// Mesmo formato do tipo `Channel` do front
#[derive(Serialize, Clone, Debug)]
pub struct ChannelDto {
    pub id: String,
    #[serde(rename = "serverId")]
    pub server_id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub topic: String,
    pub category: String,
}

#[derive(Serialize, Clone, Debug)]
pub struct ServerDto {
    pub id: String,
    pub name: String,
    pub icon: String,
    #[serde(rename = "ownerId")]
    pub owner_id: Option<String>,
    #[serde(rename = "isDefault")]
    pub is_default: bool,
    #[serde(rename = "memberCount")]
    pub member_count: i64,
    pub channels: Vec<ChannelDto>,
}

#[derive(Serialize, Debug)]
pub struct InviteDto {
    pub code: String,
    #[serde(rename = "serverId")]
    pub server_id: String,
    #[serde(rename = "expiresAt")]
    pub expires_at: Option<i64>,
    #[serde(rename = "maxUses")]
    pub max_uses: Option<i64>,
    pub uses: i64,
    #[serde(rename = "createdAt")]
    pub created_at: i64,
}

#[derive(Deserialize, Debug)]
pub struct CreateInvitePayload {
    /// Validade em segundos; ausente ou null = nunca expira
    #[serde(rename = "maxAgeSeconds", default)]
    pub max_age_seconds: Option<i64>,
    /// Ausente ou null = usos ilimitados
    #[serde(rename = "maxUses", default)]
    pub max_uses: Option<i64>,
}

pub enum ServerError {
    NotFound(&'static str),
    Forbidden(&'static str),
    Invalid(String),
    Internal(String),
}

impl From<rusqlite::Error> for ServerError {
    fn from(e: rusqlite::Error) -> Self {
        ServerError::Internal(internal_error(e))
    }
}

const SERVER_NOT_FOUND: &str = "Servidor não encontrado.";
const INVITE_NOT_FOUND: &str = "Convite inválido ou expirado.";

/// Aceita o código puro ou um link terminado nele ("https://.../invite/AbCd2345")
pub fn parse_invite_code(input: &str) -> Option<String> {
    let code = input.trim().trim_end_matches('/').rsplit('/').next()?.trim();
    let valid = !code.is_empty() && code.len() <= 32 && code.chars().all(|c| c.is_ascii_alphanumeric());
    valid.then(|| code.to_string())
}

fn generate_invite_code() -> String {
    Uuid::new_v4().as_bytes()[..INVITE_CODE_LEN]
        .iter()
        .map(|b| INVITE_ALPHABET[*b as usize % INVITE_ALPHABET.len()] as char)
        .collect()
}

fn validate_server_name(name: &str) -> Result<String, ServerError> {
    let name = name.trim();
    let len = name.chars().count();
    if len < MIN_SERVER_NAME_CHARS || len > MAX_SERVER_NAME_CHARS {
        return Err(ServerError::Invalid(format!(
            "O nome do servidor deve ter entre {} e {} caracteres.",
            MIN_SERVER_NAME_CHARS, MAX_SERVER_NAME_CHARS
        )));
    }
    Ok(name.to_string())
}

fn is_member(conn: &Connection, server_id: &str, user_id: &str) -> rusqlite::Result<bool> {
    conn.query_row(
        "SELECT 1 FROM server_members WHERE server_id = ?1 AND user_id = ?2",
        params![server_id, user_id],
        |_| Ok(()),
    )
    .optional()
    .map(|found| found.is_some())
}

/// Quem não é membro recebe "não encontrado", para não revelar que o servidor existe
fn require_member(conn: &Connection, server_id: &str, user_id: &str) -> Result<(), ServerError> {
    if is_member(conn, server_id, user_id)? {
        Ok(())
    } else {
        Err(ServerError::NotFound(SERVER_NOT_FOUND))
    }
}

fn require_owner(conn: &Connection, server_id: &str, user_id: &str) -> Result<(), ServerError> {
    require_member(conn, server_id, user_id)?;
    let owner: Option<String> = conn
        .query_row("SELECT owner_id FROM servers WHERE id = ?1", [server_id], |r| r.get(0))
        .optional()?
        .flatten();
    if owner.as_deref() == Some(user_id) {
        Ok(())
    } else {
        Err(ServerError::Forbidden("Só o dono do servidor pode fazer isso."))
    }
}

fn membership_count(conn: &Connection, user_id: &str) -> rusqlite::Result<i64> {
    conn.query_row("SELECT COUNT(*) FROM server_members WHERE user_id = ?1", [user_id], |r| r.get(0))
}

fn server_dto(conn: &Connection, server_id: &str) -> rusqlite::Result<Option<ServerDto>> {
    let server = conn
        .query_row(
            "SELECT id, name, icon, owner_id, is_default,
                    (SELECT COUNT(*) FROM server_members WHERE server_id = servers.id)
             FROM servers WHERE id = ?1",
            [server_id],
            |r| {
                Ok(ServerDto {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    icon: r.get(2)?,
                    owner_id: r.get(3)?,
                    is_default: r.get(4)?,
                    member_count: r.get(5)?,
                    channels: Vec::new(),
                })
            },
        )
        .optional()?;
    let Some(mut server) = server else {
        return Ok(None);
    };

    let mut stmt = conn.prepare(
        "SELECT id, name, kind, topic, category FROM channels WHERE server_id = ?1 ORDER BY position, id",
    )?;
    server.channels = stmt
        .query_map([server_id], |r| {
            Ok(ChannelDto {
                id: r.get(0)?,
                server_id: server_id.to_string(),
                name: r.get(1)?,
                kind: r.get(2)?,
                topic: r.get(3)?,
                category: r.get(4)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(Some(server))
}

fn member_ids_of(conn: &Connection, server_id: &str) -> rusqlite::Result<Vec<String>> {
    let mut stmt = conn.prepare("SELECT user_id FROM server_members WHERE server_id = ?1")?;
    let ids = stmt.query_map([server_id], |r| r.get(0))?.collect();
    ids
}

pub struct ServerStore {
    db: Arc<Db>,
}

impl ServerStore {
    pub fn new(db: Arc<Db>) -> Self {
        Self { db }
    }

    /// Servidores de que o usuário participa, na ordem em que entrou
    pub fn list_for_user(&self, user_id: &str) -> Result<Vec<ServerDto>, String> {
        let conn = self.db.conn();
        let ids = conn
            .prepare("SELECT server_id FROM server_members WHERE user_id = ?1 ORDER BY joined_at, server_id")
            .and_then(|mut stmt| stmt.query_map([user_id], |r| r.get::<_, String>(0))?.collect::<rusqlite::Result<Vec<_>>>())
            .map_err(internal_error)?;

        let mut servers = Vec::with_capacity(ids.len());
        for id in ids {
            if let Some(server) = server_dto(&conn, &id).map_err(internal_error)? {
                servers.push(server);
            }
        }
        Ok(servers)
    }

    /// Cria o servidor com um canal de texto e um de voz; o criador vira dono e membro
    pub fn create(&self, owner_id: &str, name: &str, snowflake: &SnowflakeGenerator) -> Result<ServerDto, ServerError> {
        let name = validate_server_name(name)?;
        let mut conn = self.db.conn();
        if membership_count(&conn, owner_id)? >= MAX_SERVERS_PER_USER {
            return Err(ServerError::Invalid(format!(
                "Você já participa do máximo de {} servidores.",
                MAX_SERVERS_PER_USER
            )));
        }

        let server_id = snowflake.next_id_string();
        let now = now_ms();
        let tx = conn.transaction()?;
        tx.execute(
            "INSERT INTO servers (id, name, owner_id, is_default, created_at) VALUES (?1, ?2, ?3, 0, ?4)",
            params![server_id, name, owner_id, now],
        )?;
        tx.execute(
            "INSERT INTO server_members (server_id, user_id, joined_at) VALUES (?1, ?2, ?3)",
            params![server_id, owner_id, now],
        )?;
        let default_channels = [
            ("geral", "text", "Canais de texto"),
            ("Bate-papo", "voice", "Canais de voz"),
        ];
        for (position, (channel_name, kind, category)) in default_channels.iter().enumerate() {
            tx.execute(
                "INSERT INTO channels (id, server_id, name, kind, category, position) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![snowflake.next_id_string(), server_id, channel_name, kind, category, position as i64],
            )?;
        }
        tx.commit()?;

        server_dto(&conn, &server_id)?.ok_or_else(|| ServerError::Internal("Erro interno ao criar o servidor.".to_string()))
    }

    pub fn rename(&self, server_id: &str, user_id: &str, name: &str) -> Result<ServerDto, ServerError> {
        let name = validate_server_name(name)?;
        let conn = self.db.conn();
        require_owner(&conn, server_id, user_id)?;
        conn.execute("UPDATE servers SET name = ?1 WHERE id = ?2", params![name, server_id])?;
        server_dto(&conn, server_id)?.ok_or(ServerError::NotFound(SERVER_NOT_FOUND))
    }

    pub fn require_owner(&self, server_id: &str, user_id: &str) -> Result<(), ServerError> {
        let conn = self.db.conn();
        require_owner(&conn, server_id, user_id)
    }

    /// Troca o ícone e devolve o anterior, para o arquivo antigo ser apagado
    pub fn set_icon(&self, server_id: &str, user_id: &str, icon_url: &str) -> Result<(ServerDto, String), ServerError> {
        let conn = self.db.conn();
        require_owner(&conn, server_id, user_id)?;
        let old: String = conn.query_row("SELECT icon FROM servers WHERE id = ?1", [server_id], |r| r.get(0))?;
        conn.execute("UPDATE servers SET icon = ?1 WHERE id = ?2", params![icon_url, server_id])?;
        let server = server_dto(&conn, server_id)?.ok_or(ServerError::NotFound(SERVER_NOT_FOUND))?;
        Ok((server, old))
    }

    /// Apaga o servidor, canais, convites e mensagens. Devolve os ex-membros e o ícone.
    pub fn delete(&self, server_id: &str, user_id: &str) -> Result<(Vec<String>, String), ServerError> {
        let mut conn = self.db.conn();
        require_owner(&conn, server_id, user_id)?;

        let tx = conn.transaction()?;
        let members = member_ids_of(&tx, server_id)?;
        let icon: String = tx.query_row("SELECT icon FROM servers WHERE id = ?1", [server_id], |r| r.get(0))?;
        tx.execute(
            "DELETE FROM messages WHERE channel_id IN (SELECT id FROM channels WHERE server_id = ?1)",
            [server_id],
        )?;
        // Canais, membros e convites saem juntos pelo ON DELETE CASCADE
        tx.execute("DELETE FROM servers WHERE id = ?1", [server_id])?;
        tx.commit()?;
        Ok((members, icon))
    }

    pub fn leave(&self, server_id: &str, user_id: &str) -> Result<(), ServerError> {
        let conn = self.db.conn();
        require_member(&conn, server_id, user_id)?;
        let owner: Option<String> = conn
            .query_row("SELECT owner_id FROM servers WHERE id = ?1", [server_id], |r| r.get(0))
            .optional()?
            .flatten();
        if owner.as_deref() == Some(user_id) {
            return Err(ServerError::Invalid(
                "O dono não pode sair do próprio servidor. Se não quiser mais o servidor, exclua-o.".to_string(),
            ));
        }
        conn.execute(
            "DELETE FROM server_members WHERE server_id = ?1 AND user_id = ?2",
            params![server_id, user_id],
        )?;
        Ok(())
    }

    /// Membros na ordem de entrada; só membros podem ver a lista
    pub fn members(&self, server_id: &str, user_id: &str) -> Result<Vec<PublicUser>, ServerError> {
        let conn = self.db.conn();
        require_member(&conn, server_id, user_id)?;
        let mut stmt = conn.prepare("SELECT user_id FROM server_members WHERE server_id = ?1 ORDER BY joined_at, user_id")?;
        let ids = stmt.query_map([server_id], |r| r.get::<_, String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;

        let mut members = Vec::with_capacity(ids.len());
        for id in ids {
            if let Some(member) = public_user_by_id(&conn, &id)? {
                members.push(member);
            }
        }
        Ok(members)
    }

    pub fn member_ids(&self, server_id: &str) -> Vec<String> {
        let conn = self.db.conn();
        member_ids_of(&conn, server_id).map_err(internal_error).unwrap_or_default()
    }

    pub fn is_member(&self, server_id: &str, user_id: &str) -> bool {
        let conn = self.db.conn();
        is_member(&conn, server_id, user_id).unwrap_or(false)
    }

    /// Servidor dono do canal, ou None se o canal não existe (ou é uma DM)
    pub fn channel_server_id(&self, channel_id: &str) -> Option<String> {
        let conn = self.db.conn();
        conn.query_row("SELECT server_id FROM channels WHERE id = ?1", [channel_id], |r| r.get(0))
            .optional()
            .map_err(internal_error)
            .ok()
            .flatten()
    }

    /// Membros do servidor dono do canal, ou None se o canal não existe
    pub fn channel_member_ids(&self, channel_id: &str) -> Option<Vec<String>> {
        let conn = self.db.conn();
        let server_id: String = conn
            .query_row("SELECT server_id FROM channels WHERE id = ?1", [channel_id], |r| r.get(0))
            .optional()
            .map_err(internal_error)
            .ok()
            .flatten()?;
        member_ids_of(&conn, &server_id).map_err(internal_error).ok()
    }

    /// Todos que dividem pelo menos um servidor com o usuário (sem ele mesmo)
    pub fn co_member_ids(&self, user_id: &str) -> Vec<String> {
        let conn = self.db.conn();
        let result = conn
            .prepare(
                "SELECT DISTINCT other.user_id FROM server_members mine
                 JOIN server_members other ON other.server_id = mine.server_id
                 WHERE mine.user_id = ?1 AND other.user_id != ?1",
            )
            .and_then(|mut stmt| stmt.query_map([user_id], |r| r.get::<_, String>(0))?.collect::<rusqlite::Result<Vec<_>>>());
        result.map_err(internal_error).unwrap_or_default()
    }

    /// Coloca o usuário nos servidores padrão (DasIdeia HQ). Devolve os IDs em que ele entrou.
    pub fn join_default_servers(&self, user_id: &str) -> Vec<String> {
        let conn = self.db.conn();
        let result = conn
            .prepare(
                "INSERT OR IGNORE INTO server_members (server_id, user_id, joined_at)
                 SELECT id, ?1, ?2 FROM servers WHERE is_default = 1
                 RETURNING server_id",
            )
            .and_then(|mut stmt| {
                stmt.query_map(params![user_id, now_ms()], |r| r.get::<_, String>(0))?
                    .collect::<rusqlite::Result<Vec<_>>>()
            });
        result.map_err(internal_error).unwrap_or_default()
    }

    pub fn create_invite(
        &self,
        server_id: &str,
        user_id: &str,
        payload: &CreateInvitePayload,
    ) -> Result<InviteDto, ServerError> {
        if let Some(age) = payload.max_age_seconds {
            if age < 60 || age > MAX_INVITE_AGE_SECONDS {
                return Err(ServerError::Invalid("A validade do convite deve ficar entre 1 minuto e 7 dias.".to_string()));
            }
        }
        if let Some(uses) = payload.max_uses {
            if uses < 1 || uses > MAX_INVITE_USES {
                return Err(ServerError::Invalid(format!(
                    "O limite de usos deve ficar entre 1 e {}.",
                    MAX_INVITE_USES
                )));
            }
        }

        let conn = self.db.conn();
        require_member(&conn, server_id, user_id)?;

        let created_at = now_ms();
        let expires_at = payload.max_age_seconds.map(|age| created_at + age * 1000);
        // Colisão é improvável (56^8 combinações), mas tenta de novo se acontecer
        for _ in 0..5 {
            let code = generate_invite_code();
            let inserted = conn
                .execute(
                    "INSERT OR IGNORE INTO invites (code, server_id, created_by, expires_at, max_uses, uses, created_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6)",
                    params![code, server_id, user_id, expires_at, payload.max_uses, created_at],
                )?;
            if inserted == 1 {
                return Ok(InviteDto {
                    code,
                    server_id: server_id.to_string(),
                    expires_at,
                    max_uses: payload.max_uses,
                    uses: 0,
                    created_at,
                });
            }
        }
        Err(ServerError::Internal("Não foi possível gerar o convite. Tente de novo.".to_string()))
    }

    /// Entra no servidor do convite. Devolve o servidor e se o usuário acabou de entrar
    /// (false quando já era membro: nesse caso o convite não é consumido).
    pub fn accept_invite(&self, input: &str, user_id: &str) -> Result<(ServerDto, bool), ServerError> {
        let code = parse_invite_code(input).ok_or(ServerError::NotFound(INVITE_NOT_FOUND))?;
        let mut conn = self.db.conn();
        let tx = conn.transaction()?;

        let invite: Option<(String, Option<i64>, Option<i64>, i64)> = tx
            .query_row(
                "SELECT server_id, expires_at, max_uses, uses FROM invites WHERE code = ?1",
                [&code],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .optional()?;
        let Some((server_id, expires_at, max_uses, uses)) = invite else {
            return Err(ServerError::NotFound(INVITE_NOT_FOUND));
        };

        // Quem já é membro só é levado ao servidor, mesmo com o convite vencido
        if is_member(&tx, &server_id, user_id)? {
            drop(tx);
            let server = server_dto(&conn, &server_id)?.ok_or(ServerError::NotFound(INVITE_NOT_FOUND))?;
            return Ok((server, false));
        }

        let expired = expires_at.is_some_and(|at| at <= now_ms());
        let used_up = max_uses.is_some_and(|max| uses >= max);
        if expired || used_up {
            tx.execute("DELETE FROM invites WHERE code = ?1", [&code])?;
            tx.commit()?;
            return Err(ServerError::NotFound(INVITE_NOT_FOUND));
        }
        if membership_count(&tx, user_id)? >= MAX_SERVERS_PER_USER {
            return Err(ServerError::Invalid(format!(
                "Você já participa do máximo de {} servidores.",
                MAX_SERVERS_PER_USER
            )));
        }

        tx.execute(
            "INSERT INTO server_members (server_id, user_id, joined_at) VALUES (?1, ?2, ?3)",
            params![server_id, user_id, now_ms()],
        )?;
        tx.execute("UPDATE invites SET uses = uses + 1 WHERE code = ?1", [&code])?;
        tx.commit()?;

        let server = server_dto(&conn, &server_id)?.ok_or(ServerError::NotFound(INVITE_NOT_FOUND))?;
        Ok((server, true))
    }
}
