use rusqlite::params;
use serde::Serialize;
use std::sync::Arc;

use crate::auth::PublicUser;
use crate::db::{internal_error, Db};
use crate::snowflake::SnowflakeGenerator;

pub const MAX_MESSAGE_CHARS: usize = 4000;
pub const MAX_CHANNEL_ID_LEN: usize = 100;

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
    pub reactions: Vec<serde_json::Value>,
}

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
        snowflake: &SnowflakeGenerator,
    ) -> Result<MessageDto, String> {
        let id = snowflake.next_id_string();
        let created_at = SnowflakeGenerator::extract_timestamp(id.parse().unwrap_or(0)) as i64;
        let author_json = serde_json::to_string(author).map_err(|e| e.to_string())?;

        let conn = self.db.conn();
        conn.execute(
            "INSERT INTO messages (id, channel_id, author_id, author_json, content, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![id, channel_id, author.id, author_json, content, created_at],
        )
        .map_err(internal_error)?;

        Ok(MessageDto {
            id,
            channel_id: channel_id.to_string(),
            author: author.clone(),
            content: content.to_string(),
            created_at,
            reactions: Vec::new(),
        })
    }

    /// Últimas `limit` mensagens anteriores a `before` (ms), em ordem cronológica
    pub fn history(&self, channel_id: &str, before: Option<i64>, limit: u32) -> Result<Vec<MessageDto>, String> {
        let conn = self.db.conn();
        let mut stmt = conn
            .prepare(
                "SELECT id, author_json, content, created_at FROM messages
                 WHERE channel_id = ?1 AND created_at < ?2
                 ORDER BY created_at DESC, id DESC LIMIT ?3",
            )
            .map_err(internal_error)?;

        let rows = stmt
            .query_map(params![channel_id, before.unwrap_or(i64::MAX), limit], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, i64>(3)?))
            })
            .and_then(|rows| rows.collect::<rusqlite::Result<Vec<_>>>())
            .map_err(internal_error)?;

        let mut messages: Vec<MessageDto> = rows
            .into_iter()
            .filter_map(|(id, author_json, content, created_at)| {
                let author = serde_json::from_str(&author_json).ok()?;
                Some(MessageDto {
                    id,
                    channel_id: channel_id.to_string(),
                    author,
                    content,
                    created_at,
                    reactions: Vec::new(),
                })
            })
            .collect();
        messages.reverse();
        Ok(messages)
    }
}
