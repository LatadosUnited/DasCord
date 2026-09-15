use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::auth::{public_user_by_id, AuthStore, PublicUser};
use crate::db::{internal_error, now_ms, Db};
use crate::snowflake::SnowflakeGenerator;

#[derive(Serialize, Debug)]
pub struct IncomingRequestDto {
    pub request_id: String,
    pub from_user: PublicUser,
    pub created_at: i64,
}

#[derive(Serialize, Debug)]
pub struct OutgoingRequestDto {
    pub request_id: String,
    pub to_user: PublicUser,
    pub created_at: i64,
}

#[derive(Serialize, Debug, Default)]
pub struct FriendsSummaryDto {
    pub friends: Vec<PublicUser>,
    pub incoming_requests: Vec<IncomingRequestDto>,
    pub outgoing_requests: Vec<OutgoingRequestDto>,
}

#[derive(Deserialize, Debug)]
pub struct SendRequestPayload {
    pub query: String, // "usuario#tag" ou "usuario"
}

#[derive(Deserialize, Debug)]
pub struct RequestActionPayload {
    pub request_id: String,
}

/// Amizades são gravadas com o menor ID primeiro, para cada par existir uma única vez
pub fn ordered_pair<'a>(a: &'a str, b: &'a str) -> (&'a str, &'a str) {
    if a <= b {
        (a, b)
    } else {
        (b, a)
    }
}

pub struct FriendsStore {
    db: Arc<Db>,
}

impl FriendsStore {
    pub fn new(db: Arc<Db>) -> Self {
        Self { db }
    }

    pub fn send_friend_request(
        &self,
        from_user_id: &str,
        query: &str,
        auth_store: &AuthStore,
        snowflake: &SnowflakeGenerator,
    ) -> Result<(String, String), String> {
        let clean_query = query.trim();
        if clean_query.is_empty() {
            return Err("Por favor, digite um nome de usuário ou tag (ex: leandro#9500).".to_string());
        }

        // Busca antes de travar o banco aqui: find_user_by_query trava por conta própria
        let Some(target) = auth_store.find_user_by_query(clean_query) else {
            return Err(format!(
                "Não encontramos nenhum usuário correspondente a '{}'. Verifique a ortografia ou a tag (ex: leandro#9500).",
                clean_query
            ));
        };

        if target.id == from_user_id {
            return Err("Você não pode adicionar a si mesmo como amigo.".to_string());
        }

        let conn = self.db.conn();
        let (a, b) = ordered_pair(from_user_id, &target.id);

        let already_friends = conn
            .query_row(
                "SELECT 1 FROM friendships WHERE user_a_id = ?1 AND user_b_id = ?2",
                params![a, b],
                |_| Ok(()),
            )
            .optional()
            .map_err(internal_error)?
            .is_some();
        if already_friends {
            return Err(format!("Você e {} já são amigos!", target.name));
        }

        // Verifica se já existe solicitação pendente em qualquer direção
        let existing_from: Option<String> = conn
            .query_row(
                "SELECT from_user_id FROM friend_requests
                 WHERE (from_user_id = ?1 AND to_user_id = ?2) OR (from_user_id = ?2 AND to_user_id = ?1)",
                params![from_user_id, target.id],
                |r| r.get(0),
            )
            .optional()
            .map_err(internal_error)?;

        if let Some(existing_from) = existing_from {
            return Err(if existing_from == from_user_id {
                format!("Você já enviou um pedido de amizade para {}.", target.name)
            } else {
                format!(
                    "{} já te enviou um pedido de amizade! Verifique a aba 'Pendentes' para aceitar.",
                    target.name
                )
            });
        }

        let request_id = snowflake.next_id_string();
        let created_at = SnowflakeGenerator::extract_timestamp(request_id.parse().unwrap_or(0)) as i64;
        conn.execute(
            "INSERT INTO friend_requests (id, from_user_id, to_user_id, created_at) VALUES (?1, ?2, ?3, ?4)",
            params![request_id, from_user_id, target.id, created_at],
        )
        .map_err(internal_error)?;

        Ok((target.id, target.name))
    }

    pub fn accept_friend_request(&self, request_id: &str, current_user_id: &str) -> Result<(String, String), String> {
        let mut conn = self.db.conn();
        let tx = conn.transaction().map_err(internal_error)?;

        let from_user_id: Option<String> = tx
            .query_row(
                "DELETE FROM friend_requests WHERE id = ?1 AND to_user_id = ?2 RETURNING from_user_id",
                params![request_id, current_user_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(internal_error)?;

        let Some(from_user_id) = from_user_id else {
            return Err("Pedido de amizade não encontrado ou já processado.".to_string());
        };

        let (a, b) = ordered_pair(&from_user_id, current_user_id);
        tx.execute(
            "INSERT OR IGNORE INTO friendships (user_a_id, user_b_id, created_at) VALUES (?1, ?2, ?3)",
            params![a, b, now_ms()],
        )
        .map_err(internal_error)?;
        tx.commit().map_err(internal_error)?;

        Ok((from_user_id, current_user_id.to_string()))
    }

    pub fn decline_friend_request(&self, request_id: &str, current_user_id: &str) -> Result<(), String> {
        let conn = self.db.conn();
        let removed = conn
            .execute(
                "DELETE FROM friend_requests WHERE id = ?1 AND (to_user_id = ?2 OR from_user_id = ?2)",
                params![request_id, current_user_id],
            )
            .map_err(internal_error)?;
        if removed == 0 {
            return Err("Pedido de amizade não encontrado.".to_string());
        }
        Ok(())
    }

    pub fn get_summary(&self, user_id: &str) -> Result<FriendsSummaryDto, String> {
        let conn = self.db.conn();
        let mut summary = FriendsSummaryDto::default();

        // 1. Amigos confirmados
        let mut stmt = conn
            .prepare(
                "SELECT CASE WHEN user_a_id = ?1 THEN user_b_id ELSE user_a_id END
                 FROM friendships WHERE user_a_id = ?1 OR user_b_id = ?1 ORDER BY created_at",
            )
            .map_err(internal_error)?;
        let friend_ids = stmt
            .query_map([user_id], |r| r.get::<_, String>(0))
            .and_then(|rows| rows.collect::<rusqlite::Result<Vec<_>>>())
            .map_err(internal_error)?;
        for id in friend_ids {
            if let Some(friend) = public_user_by_id(&conn, &id).map_err(internal_error)? {
                summary.friends.push(friend);
            }
        }

        // 2 e 3. Pedidos recebidos e enviados
        let mut stmt = conn
            .prepare(
                "SELECT id, from_user_id, to_user_id, created_at FROM friend_requests
                 WHERE from_user_id = ?1 OR to_user_id = ?1 ORDER BY created_at",
            )
            .map_err(internal_error)?;
        let requests = stmt
            .query_map([user_id], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, i64>(3)?))
            })
            .and_then(|rows| rows.collect::<rusqlite::Result<Vec<_>>>())
            .map_err(internal_error)?;

        for (request_id, from_id, to_id, created_at) in requests {
            if to_id == user_id {
                if let Some(from_user) = public_user_by_id(&conn, &from_id).map_err(internal_error)? {
                    summary.incoming_requests.push(IncomingRequestDto { request_id, from_user, created_at });
                }
            } else if let Some(to_user) = public_user_by_id(&conn, &to_id).map_err(internal_error)? {
                summary.outgoing_requests.push(OutgoingRequestDto { request_id, to_user, created_at });
            }
        }

        Ok(summary)
    }

    pub fn friend_ids(&self, user_id: &str) -> Vec<String> {
        let conn = self.db.conn();
        let result = conn
            .prepare(
                "SELECT CASE WHEN user_a_id = ?1 THEN user_b_id ELSE user_a_id END
                 FROM friendships WHERE user_a_id = ?1 OR user_b_id = ?1",
            )
            .and_then(|mut stmt| {
                stmt.query_map([user_id], |r| r.get::<_, String>(0))?
                    .collect::<rusqlite::Result<Vec<_>>>()
            });
        result.map_err(internal_error).unwrap_or_default()
    }

    pub fn are_friends(&self, user_a: &str, user_b: &str) -> bool {
        let (a, b) = ordered_pair(user_a, user_b);
        let conn = self.db.conn();
        conn.query_row(
            "SELECT 1 FROM friendships WHERE user_a_id = ?1 AND user_b_id = ?2",
            params![a, b],
            |_| Ok(()),
        )
        .optional()
        .map(|found| found.is_some())
        .unwrap_or(false)
    }
}
