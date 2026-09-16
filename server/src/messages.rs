use rusqlite::{params, params_from_iter, Connection, Row};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Arc;

use crate::auth::PublicUser;
use crate::db::{internal_error, now_ms, Db};
use crate::snowflake::SnowflakeGenerator;

pub const MAX_MESSAGE_CHARS: usize = 4000;
pub const MAX_CHANNEL_ID_LEN: usize = 100;
/// Emoji tem poucos caracteres: o limite evita "reações" com um texto inteiro
pub const MAX_EMOJI_CHARS: usize = 16;
/// Emojis diferentes por mensagem
const MAX_REACTIONS_PER_MESSAGE: usize = 20;
/// Trecho da mensagem respondida mostrado acima da resposta
const REPLY_PREVIEW_CHARS: usize = 120;

#[derive(Serialize, Debug, Clone)]
pub struct ReactionDto {
    pub emoji: String,
    /// Quem reagiu; o app marca a reação como sua olhando esta lista
    #[serde(rename = "userIds")]
    pub user_ids: Vec<String>,
}

/// Mensagem respondida, como ela era no momento da leitura
#[derive(Serialize, Debug, Clone)]
pub struct ReplyDto {
    pub id: String,
    #[serde(rename = "authorName")]
    pub author_name: String,
    pub content: String,
    pub deleted: bool,
}

/// Mesmo formato do tipo `Message` do front
#[derive(Serialize, Debug)]
pub struct MessageDto {
    pub id: String,
    #[serde(rename = "channelId")]
    pub channel_id: String,
    pub author: PublicUser,
    pub content: String,
    #[serde(rename = "createdAt")]
    pub created_at: i64,
    #[serde(rename = "editedAt", skip_serializing_if = "Option::is_none")]
    pub edited_at: Option<i64>,
    #[serde(rename = "replyTo", skip_serializing_if = "Option::is_none")]
    pub reply_to: Option<ReplyDto>,
    pub reactions: Vec<ReactionDto>,
}

/// Colunas da mensagem e, por LEFT JOIN, da mensagem respondida
const SELECT_MESSAGE: &str = "
SELECT m.id, m.author_json, m.content, m.created_at, m.edited_at,
       r.id, r.author_json, r.content, r.deleted_at
FROM messages m LEFT JOIN messages r ON r.id = m.reply_to_id";

pub struct MessageStore {
    db: Arc<Db>,
}

impl MessageStore {
    pub fn new(db: Arc<Db>) -> Self {
        Self { db }
    }

    pub fn insert(
        &self,
        channel_id: &str,
        author: &PublicUser,
        content: &str,
        reply_to_id: Option<&str>,
        snowflake: &SnowflakeGenerator,
    ) -> Result<MessageDto, String> {
        let id = snowflake.next_id_string();
        let created_at = SnowflakeGenerator::extract_timestamp(id.parse().unwrap_or(0)) as i64;
        let author_json = serde_json::to_string(author).map_err(|e| e.to_string())?;

        let conn = self.db.conn();
        // Só responde a mensagem do mesmo canal; a referência some se ela não existir
        let reply_to_id = reply_to_id.filter(|reply_id| {
            conn.query_row(
                "SELECT 1 FROM messages WHERE id = ?1 AND channel_id = ?2",
                params![reply_id, channel_id],
                |_| Ok(()),
            )
            .is_ok()
        });

        conn.execute(
            "INSERT INTO messages (id, channel_id, author_id, author_json, content, created_at, reply_to_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![id, channel_id, author.id, author_json, content, created_at, reply_to_id],
        )
        .map_err(internal_error)?;

        fetch_one(&conn, channel_id, &id)?.ok_or_else(|| "Mensagem não encontrada.".to_string())
    }

    /// Últimas `limit` mensagens anteriores a `before` (ms), em ordem cronológica
    pub fn history(&self, channel_id: &str, before: Option<i64>, limit: u32) -> Result<Vec<MessageDto>, String> {
        let conn = self.db.conn();
        let mut stmt = conn
            .prepare(&format!(
                "{SELECT_MESSAGE}
                 WHERE m.channel_id = ?1 AND m.deleted_at IS NULL AND m.created_at < ?2
                 ORDER BY m.created_at DESC, m.id DESC LIMIT ?3"
            ))
            .map_err(internal_error)?;

        let rows = stmt
            .query_map(params![channel_id, before.unwrap_or(i64::MAX), limit], |row| {
                Ok(row_to_message(row, channel_id))
            })
            .and_then(|rows| rows.collect::<rusqlite::Result<Vec<_>>>())
            .map_err(internal_error)?;

        let mut messages: Vec<MessageDto> = rows.into_iter().flatten().collect();
        messages.reverse();
        attach_reactions(&conn, &mut messages)?;
        Ok(messages)
    }

    /// Edita o texto, só para o autor. None: mensagem inexistente, de outra pessoa ou apagada.
    pub fn edit(
        &self,
        channel_id: &str,
        message_id: &str,
        user_id: &str,
        content: &str,
    ) -> Result<Option<MessageDto>, String> {
        let conn = self.db.conn();
        let changed = conn
            .execute(
                "UPDATE messages SET content = ?1, edited_at = ?2
                 WHERE id = ?3 AND channel_id = ?4 AND author_id = ?5 AND deleted_at IS NULL",
                params![content, now_ms(), message_id, channel_id, user_id],
            )
            .map_err(internal_error)?;
        if changed == 0 {
            return Ok(None);
        }

        let mut message = fetch_one(&conn, channel_id, message_id)?;
        if let Some(message) = message.as_mut() {
            let mut one = std::slice::from_mut(message);
            attach_reactions(&conn, &mut one)?;
        }
        Ok(message)
    }

    /// Apaga para todos: o autor sempre, o dono do servidor com `can_moderate`.
    /// A linha continua no banco para que as respostas ainda mostrem o contexto.
    pub fn delete(
        &self,
        channel_id: &str,
        message_id: &str,
        user_id: &str,
        can_moderate: bool,
    ) -> Result<bool, String> {
        let conn = self.db.conn();
        let changed = conn
            .execute(
                "UPDATE messages SET deleted_at = ?1
                 WHERE id = ?2 AND channel_id = ?3 AND deleted_at IS NULL
                   AND (author_id = ?4 OR ?5)",
                params![now_ms(), message_id, channel_id, user_id, can_moderate],
            )
            .map_err(internal_error)?;
        Ok(changed > 0)
    }

    /// Põe ou tira a reação de uma pessoa. Devolve quem reage com esse emoji agora.
    pub fn toggle_reaction(
        &self,
        channel_id: &str,
        message_id: &str,
        user_id: &str,
        emoji: &str,
    ) -> Result<Option<ReactionDto>, String> {
        let conn = self.db.conn();
        let exists = conn
            .query_row(
                "SELECT 1 FROM messages WHERE id = ?1 AND channel_id = ?2 AND deleted_at IS NULL",
                params![message_id, channel_id],
                |_| Ok(()),
            )
            .is_ok();
        if !exists {
            return Ok(None);
        }

        let removed = conn
            .execute(
                "DELETE FROM message_reactions WHERE message_id = ?1 AND user_id = ?2 AND emoji = ?3",
                params![message_id, user_id, emoji],
            )
            .map_err(internal_error)?;

        if removed == 0 {
            let distinct: i64 = conn
                .query_row(
                    "SELECT COUNT(DISTINCT emoji) FROM message_reactions WHERE message_id = ?1",
                    params![message_id],
                    |r| r.get(0),
                )
                .map_err(internal_error)?;
            if distinct as usize >= MAX_REACTIONS_PER_MESSAGE {
                return Ok(None);
            }
            conn.execute(
                "INSERT INTO message_reactions (message_id, user_id, emoji, created_at) VALUES (?1, ?2, ?3, ?4)",
                params![message_id, user_id, emoji, now_ms()],
            )
            .map_err(internal_error)?;
        }

        let mut stmt = conn
            .prepare(
                "SELECT user_id FROM message_reactions
                 WHERE message_id = ?1 AND emoji = ?2 ORDER BY created_at",
            )
            .map_err(internal_error)?;
        let user_ids = stmt
            .query_map(params![message_id, emoji], |r| r.get::<_, String>(0))
            .and_then(|rows| rows.collect::<rusqlite::Result<Vec<_>>>())
            .map_err(internal_error)?;

        Ok(Some(ReactionDto {
            emoji: emoji.to_string(),
            user_ids,
        }))
    }
}

fn fetch_one(conn: &Connection, channel_id: &str, message_id: &str) -> Result<Option<MessageDto>, String> {
    let message = conn
        .query_row(
            &format!("{SELECT_MESSAGE} WHERE m.id = ?1 AND m.channel_id = ?2"),
            params![message_id, channel_id],
            |row| Ok(row_to_message(row, channel_id)),
        )
        .map_err(internal_error)?;
    Ok(message)
}

/// Uma linha do `SELECT_MESSAGE`. None quando o autor salvo não pôde ser lido.
fn row_to_message(row: &Row, channel_id: &str) -> Option<MessageDto> {
    let author = serde_json::from_str(&row.get::<_, String>(1).ok()?).ok()?;
    let reply_to = row.get::<_, Option<String>>(5).ok().flatten().map(|reply_id| {
        let reply_author: Option<PublicUser> = row
            .get::<_, Option<String>>(6)
            .ok()
            .flatten()
            .and_then(|json| serde_json::from_str(&json).ok());
        let deleted = row.get::<_, Option<i64>>(8).ok().flatten().is_some();
        let content = row.get::<_, Option<String>>(7).ok().flatten().unwrap_or_default();
        ReplyDto {
            id: reply_id,
            author_name: reply_author.map(|u| u.name).unwrap_or_default(),
            content: if deleted { String::new() } else { truncate(&content) },
            deleted,
        }
    });

    Some(MessageDto {
        id: row.get(0).ok()?,
        channel_id: channel_id.to_string(),
        author,
        content: row.get(2).ok()?,
        created_at: row.get(3).ok()?,
        edited_at: row.get(4).ok().flatten(),
        reply_to,
        reactions: Vec::new(),
    })
}

fn truncate(content: &str) -> String {
    if content.chars().count() <= REPLY_PREVIEW_CHARS {
        return content.to_string();
    }
    content.chars().take(REPLY_PREVIEW_CHARS).collect::<String>() + "…"
}

/// Preenche as reações das mensagens em uma consulta só
fn attach_reactions(conn: &Connection, messages: &mut [MessageDto]) -> Result<(), String> {
    if messages.is_empty() {
        return Ok(());
    }
    let placeholders = vec!["?"; messages.len()].join(",");
    let mut stmt = conn
        .prepare(&format!(
            "SELECT message_id, emoji, user_id FROM message_reactions
             WHERE message_id IN ({placeholders}) ORDER BY created_at, emoji"
        ))
        .map_err(internal_error)?;

    let ids = messages.iter().map(|m| m.id.clone()).collect::<Vec<_>>();
    let rows = stmt
        .query_map(params_from_iter(ids.iter()), |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?))
        })
        .and_then(|rows| rows.collect::<rusqlite::Result<Vec<_>>>())
        .map_err(internal_error)?;

    // Ordem de chegada: o emoji usado primeiro aparece primeiro, como no Discord
    let mut by_message: HashMap<String, Vec<ReactionDto>> = HashMap::new();
    for (message_id, emoji, user_id) in rows {
        let reactions = by_message.entry(message_id).or_default();
        match reactions.iter_mut().find(|r| r.emoji == emoji) {
            Some(reaction) => reaction.user_ids.push(user_id),
            None => reactions.push(ReactionDto {
                emoji,
                user_ids: vec![user_id],
            }),
        }
    }
    for message in messages.iter_mut() {
        if let Some(reactions) = by_message.remove(&message.id) {
            message.reactions = reactions;
        }
    }
    Ok(())
}
