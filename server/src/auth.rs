use argon2::{
    password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Argon2,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use uuid::Uuid;

use crate::db::{internal_error, now_ms, Db};
use crate::snowflake::SnowflakeGenerator;

const USER_SESSION_TTL_MS: i64 = 30 * 24 * 60 * 60 * 1000;
const GUEST_SESSION_TTL_MS: i64 = 24 * 60 * 60 * 1000;
const MAX_LOGIN_FAILURES: u32 = 5;
const LOGIN_FAILURE_WINDOW: Duration = Duration::from_secs(15 * 60);
const MIN_PASSWORD_LEN: usize = 6;
const MAX_DISPLAY_NAME_CHARS: usize = 32;
const MAX_CUSTOM_STATUS_CHARS: usize = 128;
/// "offline" escolhido pelo usuário significa "invisível"
pub const VALID_STATUSES: [&str; 4] = ["online", "idle", "dnd", "offline"];

struct UserRecord {
    id: String,
    /// String PHC do argon2 ("$argon2id$...") ou, em contas antigas, hex SHA-256
    password_hash: String,
    /// Usado apenas pelos hashes SHA-256 legados; vazio em hashes argon2
    salt: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct PublicUser {
    pub id: String,
    pub name: String,
    pub tag: String,
    pub avatar: String,
    pub status: String,
    #[serde(rename = "customStatus")]
    pub custom_status: String,
    pub role: String,
    #[serde(rename = "roleColor")]
    pub role_color: String,
}

/// Dados privados da conta, só para o próprio usuário
#[derive(Serialize, Debug)]
pub struct AccountInfo {
    pub email: String,
    pub username: String,
    pub tag: String,
    #[serde(rename = "createdAt")]
    pub created_at: i64,
    #[serde(rename = "otherSessions")]
    pub other_sessions: i64,
}

#[derive(Deserialize, Debug)]
pub struct RegisterRequest {
    pub email: String,
    pub username: String,
    #[serde(rename = "displayName")]
    pub display_name: Option<String>,
    pub password: String,
}

#[derive(Deserialize, Debug)]
pub struct LoginRequest {
    pub login: String,
    pub password: String,
}

#[derive(Serialize, Debug)]
pub struct AuthResponse {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user: Option<PublicUser>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

pub enum LoginError {
    InvalidCredentials,
    TooManyAttempts,
    Internal(String),
}

impl LoginError {
    pub fn message(&self) -> String {
        match self {
            LoginError::InvalidCredentials => "E-mail/usuário ou senha incorretos.".to_string(),
            LoginError::TooManyAttempts => {
                "Muitas tentativas de login. Aguarde alguns minutos e tente novamente.".to_string()
            }
            LoginError::Internal(msg) => msg.clone(),
        }
    }
}

struct LoginFailures {
    count: u32,
    window_start: Instant,
}

/// Busca um usuário (conta ou convidado) usando uma conexão já travada
pub fn public_user_by_id(conn: &Connection, id: &str) -> rusqlite::Result<Option<PublicUser>> {
    let user = conn
        .query_row(
            "SELECT id, username, display_name, tag, avatar, role, role_color, status, custom_status
             FROM users WHERE id = ?1",
            [id],
            |r| {
                let username: String = r.get(1)?;
                let display_name: String = r.get(2)?;
                Ok(PublicUser {
                    id: r.get(0)?,
                    name: if display_name.is_empty() { username } else { display_name },
                    tag: r.get(3)?,
                    avatar: r.get(4)?,
                    role: r.get(5)?,
                    role_color: r.get(6)?,
                    status: r.get(7)?,
                    custom_status: r.get(8)?,
                })
            },
        )
        .optional()?;
    if user.is_some() {
        return Ok(user);
    }

    conn.query_row(
        "SELECT id, name, tag, avatar, custom_status, status FROM guests WHERE id = ?1",
        [id],
        |r| {
            Ok(PublicUser {
                id: r.get(0)?,
                name: r.get(1)?,
                tag: r.get(2)?,
                avatar: r.get(3)?,
                custom_status: r.get(4)?,
                status: r.get(5)?,
                role: "Visitante".to_string(),
                role_color: "#22c55e".to_string(),
            })
        },
    )
    .optional()
}

pub struct AuthStore {
    db: Arc<Db>,
    // Fica em memória de propósito: reiniciar o servidor zera as tentativas
    login_failures: Mutex<HashMap<String, LoginFailures>>, // chave normalizada -> falhas
}

impl AuthStore {
    pub fn new(db: Arc<Db>) -> Self {
        Self {
            db,
            login_failures: Mutex::new(HashMap::new()),
        }
    }

    /// Remove sessões vencidas e convidados sem sessão
    pub fn purge_expired(&self) {
        let conn = self.db.conn();
        let result = conn
            .execute("DELETE FROM sessions WHERE expires_at <= ?1", [now_ms()])
            .and_then(|_| {
                conn.execute(
                    "DELETE FROM guests WHERE id NOT IN (SELECT user_id FROM sessions)",
                    [],
                )
            });
        if let Err(e) = result {
            internal_error(e);
        }
    }

    pub fn register(&self, req: RegisterRequest, snowflake: &SnowflakeGenerator) -> Result<(String, PublicUser), String> {
        let email = req.email.trim().to_lowercase();
        let username = req.username.trim().to_lowercase();

        if email.is_empty() || !email.contains('@') {
            return Err("Por favor, informe um endereço de e-mail válido.".to_string());
        }
        if username.len() < 2 || username.len() > 32 {
            return Err("O nome de usuário deve ter entre 2 e 32 caracteres.".to_string());
        }
        if !username.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '.') {
            return Err("O nome de usuário só pode conter letras, números, '_' e '.'.".to_string());
        }
        if req.password.len() < MIN_PASSWORD_LEN {
            return Err("A senha deve conter no mínimo 6 caracteres.".to_string());
        }

        // Hash fora do lock: argon2 é propositalmente lento
        let password_hash = Self::hash_password(&req.password)?;

        let conn = self.db.conn();

        let email_taken: Option<bool> = conn
            .query_row(
                "SELECT email = ?1 FROM users WHERE email = ?1 OR username = ?2 LIMIT 1",
                params![email, username],
                |r| r.get(0),
            )
            .optional()
            .map_err(internal_error)?;
        match email_taken {
            Some(true) => return Err("Este e-mail já está cadastrado.".to_string()),
            Some(false) => return Err("Este nome de usuário já está em uso.".to_string()),
            None => {}
        }

        let id = snowflake.next_id_string();
        let tag = format!("#{:04}", rand_tag() % 9000 + 1000);
        let display_name = req
            .display_name
            .map(|d| d.trim().to_string())
            .filter(|d| !d.is_empty())
            .unwrap_or_else(|| username.clone());
        let avatar = "https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=150&auto=format&fit=crop&q=80";
        let created_at = SnowflakeGenerator::extract_timestamp(id.parse().unwrap_or(0)) as i64;

        conn.execute(
            "INSERT INTO users (id, email, username, tag, display_name, password_hash, salt, avatar, role, role_color, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, '', ?7, 'Membro', '#5865F2', ?8)",
            params![id, email, username, tag, display_name, password_hash, avatar, created_at],
        )
        .map_err(internal_error)?;

        let token = create_session(&conn, &id, USER_SESSION_TTL_MS).map_err(internal_error)?;
        let user = public_user_by_id(&conn, &id)
            .map_err(internal_error)?
            .ok_or_else(|| "Erro interno ao criar a conta.".to_string())?;
        Ok((token, user))
    }

    pub fn login(&self, req: LoginRequest) -> Result<(String, PublicUser), LoginError> {
        let login_query = req.login.trim().to_lowercase();

        if self.is_rate_limited(&login_query) {
            return Err(LoginError::TooManyAttempts);
        }

        // Lê o registro e solta o lock antes de verificar a senha
        let user = {
            let conn = self.db.conn();
            conn.query_row(
                "SELECT id, password_hash, salt FROM users WHERE lower(email) = ?1 OR lower(username) = ?1 LIMIT 1",
                [&login_query],
                |r| {
                    Ok(UserRecord {
                        id: r.get(0)?,
                        password_hash: r.get(1)?,
                        salt: r.get(2)?,
                    })
                },
            )
            .optional()
            .map_err(|e| LoginError::Internal(internal_error(e)))?
        };

        let Some(user) = user else {
            // Faz um hash mesmo assim para não revelar, pelo tempo de resposta, se a conta existe
            let _ = Self::hash_password(&req.password);
            self.record_login_failure(&login_query);
            return Err(LoginError::InvalidCredentials);
        };

        let (valid, needs_rehash) = Self::verify_password(&req.password, &user);
        if !valid {
            self.record_login_failure(&login_query);
            return Err(LoginError::InvalidCredentials);
        }

        self.login_failures.lock().unwrap().remove(&login_query);

        // Hash calculado antes de travar o banco
        let new_hash = if needs_rehash { Self::hash_password(&req.password).ok() } else { None };

        let conn = self.db.conn();
        // Migra hashes SHA-256 legados para argon2 no primeiro login bem-sucedido
        if let Some(new_hash) = new_hash {
            conn.execute(
                "UPDATE users SET password_hash = ?1, salt = '' WHERE id = ?2",
                params![new_hash, user.id],
            )
            .map_err(|e| LoginError::Internal(internal_error(e)))?;
        }

        let token = create_session(&conn, &user.id, USER_SESSION_TTL_MS)
            .map_err(|e| LoginError::Internal(internal_error(e)))?;
        let public = public_user_by_id(&conn, &user.id)
            .map_err(|e| LoginError::Internal(internal_error(e)))?
            .ok_or(LoginError::InvalidCredentials)?;
        Ok((token, public))
    }

    pub fn create_guest(&self, snowflake: &SnowflakeGenerator) -> Result<(String, PublicUser), String> {
        let id = snowflake.next_id_string();
        let name = format!("Convidado_{}", &id[id.len().saturating_sub(4)..]);
        let tag = format!("#{:04}", rand_tag() % 9000 + 1000);
        let avatar = "https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=150&auto=format&fit=crop&q=80";

        let conn = self.db.conn();
        conn.execute(
            "INSERT INTO guests (id, name, tag, avatar, custom_status, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![id, name, tag, avatar, "Convidado com Snowflake 64-bit ✨", now_ms()],
        )
        .map_err(internal_error)?;

        let token = create_session(&conn, &id, GUEST_SESSION_TTL_MS).map_err(internal_error)?;
        let guest = public_user_by_id(&conn, &id)
            .map_err(internal_error)?
            .ok_or_else(|| "Erro interno ao criar o convidado.".to_string())?;
        Ok((token, guest))
    }

    pub fn logout(&self, token: &str) {
        let conn = self.db.conn();
        if let Err(e) = delete_session(&conn, token) {
            internal_error(e);
        }
    }

    pub fn get_by_token(&self, token: &str) -> Option<PublicUser> {
        let user_id = self.get_user_id_by_token(token)?;
        self.get_user(&user_id)
    }

    pub fn get_user(&self, user_id: &str) -> Option<PublicUser> {
        let conn = self.db.conn();
        public_user_by_id(&conn, user_id).map_err(internal_error).ok().flatten()
    }

    pub fn get_user_id_by_token(&self, token: &str) -> Option<String> {
        let conn = self.db.conn();
        let session: Option<(String, i64)> = conn
            .query_row(
                "SELECT user_id, expires_at FROM sessions WHERE token = ?1",
                [token],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(internal_error)
            .ok()
            .flatten();

        let (user_id, expires_at) = session?;
        if expires_at <= now_ms() {
            if let Err(e) = delete_session(&conn, token) {
                internal_error(e);
            }
            return None;
        }
        Some(user_id)
    }

    pub fn is_guest(&self, id: &str) -> bool {
        let conn = self.db.conn();
        conn.query_row("SELECT 1 FROM guests WHERE id = ?1", [id], |_| Ok(()))
            .optional()
            .map(|found| found.is_some())
            .unwrap_or(false)
    }

    /// Busca exata: "usuario#tag" ou "usuario". Não aceita e-mail, para não permitir
    /// descobrir quais e-mails têm conta. Convidados nunca aparecem.
    pub fn find_user_by_query(&self, query: &str) -> Option<PublicUser> {
        let q = query.trim().to_lowercase();
        let (uname, tag) = match q.split_once('#') {
            Some((name, digits)) => (name.trim().to_string(), Some(format!("#{}", digits.trim()))),
            None => (q.clone(), None),
        };

        let conn = self.db.conn();
        let id: Option<String> = conn
            .query_row(
                "SELECT id FROM users WHERE username = ?1 AND (?2 IS NULL OR tag = ?2) LIMIT 1",
                params![uname, tag],
                |r| r.get(0),
            )
            .optional()
            .map_err(internal_error)
            .ok()
            .flatten();

        public_user_by_id(&conn, &id?).map_err(internal_error).ok().flatten()
    }

    // ---------- Configurações do usuário ----------

    pub fn update_profile(&self, user_id: &str, display_name: &str) -> Result<PublicUser, String> {
        let display_name = display_name.trim();
        if display_name.is_empty() || display_name.chars().count() > MAX_DISPLAY_NAME_CHARS {
            return Err(format!("O nome de exibição deve ter entre 1 e {} caracteres.", MAX_DISPLAY_NAME_CHARS));
        }

        let conn = self.db.conn();
        let updated = conn
            .execute("UPDATE users SET display_name = ?1 WHERE id = ?2", params![display_name, user_id])
            .map_err(internal_error)?;
        if updated == 0 {
            return Err("Convidados não podem editar o perfil. Crie uma conta para usar esse recurso.".to_string());
        }
        public_user_by_id(&conn, user_id)
            .map_err(internal_error)?
            .ok_or_else(|| "Usuário não encontrado.".to_string())
    }

    /// Funciona para contas e convidados
    pub fn update_presence(&self, user_id: &str, status: &str, custom_status: &str) -> Result<PublicUser, String> {
        if !VALID_STATUSES.contains(&status) {
            return Err("Status inválido.".to_string());
        }
        let custom_status = custom_status.trim();
        if custom_status.chars().count() > MAX_CUSTOM_STATUS_CHARS {
            return Err(format!("O status personalizado pode ter no máximo {} caracteres.", MAX_CUSTOM_STATUS_CHARS));
        }

        let conn = self.db.conn();
        let mut updated = conn
            .execute(
                "UPDATE users SET status = ?1, custom_status = ?2 WHERE id = ?3",
                params![status, custom_status, user_id],
            )
            .map_err(internal_error)?;
        if updated == 0 {
            updated = conn
                .execute(
                    "UPDATE guests SET status = ?1, custom_status = ?2 WHERE id = ?3",
                    params![status, custom_status, user_id],
                )
                .map_err(internal_error)?;
        }
        if updated == 0 {
            return Err("Usuário não encontrado.".to_string());
        }
        public_user_by_id(&conn, user_id)
            .map_err(internal_error)?
            .ok_or_else(|| "Usuário não encontrado.".to_string())
    }

    /// Troca a URL do avatar e devolve a anterior, para o arquivo antigo ser apagado
    pub fn set_avatar(&self, user_id: &str, avatar_url: &str) -> Result<(PublicUser, String), String> {
        let conn = self.db.conn();
        let old: Option<String> = conn
            .query_row("SELECT avatar FROM users WHERE id = ?1", [user_id], |r| r.get(0))
            .optional()
            .map_err(internal_error)?;
        let Some(old) = old else {
            return Err("Convidados não podem trocar o avatar. Crie uma conta para usar esse recurso.".to_string());
        };

        conn.execute("UPDATE users SET avatar = ?1 WHERE id = ?2", params![avatar_url, user_id])
            .map_err(internal_error)?;
        let user = public_user_by_id(&conn, user_id)
            .map_err(internal_error)?
            .ok_or_else(|| "Usuário não encontrado.".to_string())?;
        Ok((user, old))
    }

    /// None para convidados
    pub fn account_info(&self, user_id: &str, current_token: &str) -> Result<Option<AccountInfo>, String> {
        let conn = self.db.conn();
        conn.query_row(
            "SELECT email, username, tag, created_at,
                    (SELECT COUNT(*) FROM sessions WHERE user_id = ?1 AND token != ?2 AND expires_at > ?3)
             FROM users WHERE id = ?1",
            params![user_id, current_token, now_ms()],
            |r| {
                Ok(AccountInfo {
                    email: r.get(0)?,
                    username: r.get(1)?,
                    tag: r.get(2)?,
                    created_at: r.get(3)?,
                    other_sessions: r.get(4)?,
                })
            },
        )
        .optional()
        .map_err(internal_error)
    }

    /// Confere a senha atual, grava a nova e encerra as outras sessões. Devolve quantas foram encerradas.
    pub fn change_password(
        &self,
        user_id: &str,
        current_token: &str,
        current_password: &str,
        new_password: &str,
    ) -> Result<usize, String> {
        if new_password.len() < MIN_PASSWORD_LEN {
            return Err("A nova senha deve conter no mínimo 6 caracteres.".to_string());
        }

        let limit_key = format!("password:{}", user_id);
        if self.is_rate_limited(&limit_key) {
            return Err("Muitas tentativas com a senha errada. Aguarde alguns minutos.".to_string());
        }

        let user = {
            let conn = self.db.conn();
            conn.query_row(
                "SELECT id, password_hash, salt FROM users WHERE id = ?1",
                [user_id],
                |r| {
                    Ok(UserRecord {
                        id: r.get(0)?,
                        password_hash: r.get(1)?,
                        salt: r.get(2)?,
                    })
                },
            )
            .optional()
            .map_err(internal_error)?
        };
        let Some(user) = user else {
            return Err("Convidados não têm senha.".to_string());
        };

        let (valid, _) = Self::verify_password(current_password, &user);
        if !valid {
            self.record_login_failure(&limit_key);
            return Err("A senha atual está incorreta.".to_string());
        }
        self.login_failures.lock().unwrap().remove(&limit_key);

        let new_hash = Self::hash_password(new_password)?;

        let mut conn = self.db.conn();
        let tx = conn.transaction().map_err(internal_error)?;
        tx.execute(
            "UPDATE users SET password_hash = ?1, salt = '' WHERE id = ?2",
            params![new_hash, user.id],
        )
        .map_err(internal_error)?;
        let revoked = tx
            .execute(
                "DELETE FROM sessions WHERE user_id = ?1 AND token != ?2",
                params![user.id, current_token],
            )
            .map_err(internal_error)?;
        tx.commit().map_err(internal_error)?;
        Ok(revoked)
    }

    pub fn revoke_other_sessions(&self, user_id: &str, current_token: &str) -> Result<usize, String> {
        let conn = self.db.conn();
        conn.execute(
            "DELETE FROM sessions WHERE user_id = ?1 AND token != ?2",
            params![user_id, current_token],
        )
        .map_err(internal_error)
    }

    fn is_rate_limited(&self, key: &str) -> bool {
        let mut failures = self.login_failures.lock().unwrap();
        match failures.get(key) {
            Some(f) if f.window_start.elapsed() > LOGIN_FAILURE_WINDOW => {
                failures.remove(key);
                false
            }
            Some(f) => f.count >= MAX_LOGIN_FAILURES,
            None => false,
        }
    }

    fn record_login_failure(&self, key: &str) {
        let mut failures = self.login_failures.lock().unwrap();
        let entry = failures.entry(key.to_string()).or_insert(LoginFailures {
            count: 0,
            window_start: Instant::now(),
        });
        entry.count += 1;
    }

    fn hash_password(password: &str) -> Result<String, String> {
        let salt = SaltString::encode_b64(Uuid::new_v4().as_bytes())
            .map_err(|_| "Erro interno ao gerar salt.".to_string())?;
        Argon2::default()
            .hash_password(password.as_bytes(), &salt)
            .map(|h| h.to_string())
            .map_err(|_| "Erro interno ao processar a senha.".to_string())
    }

    /// Retorna (senha válida, precisa migrar para argon2)
    fn verify_password(password: &str, user: &UserRecord) -> (bool, bool) {
        if user.password_hash.starts_with("$argon2") {
            let valid = PasswordHash::new(&user.password_hash)
                .map(|parsed| Argon2::default().verify_password(password.as_bytes(), &parsed).is_ok())
                .unwrap_or(false);
            return (valid, false);
        }

        let mut hasher = Sha256::new();
        hasher.update(password.as_bytes());
        hasher.update(user.salt.as_bytes());
        let valid = hex::encode(hasher.finalize()) == user.password_hash;
        (valid, valid)
    }
}

fn create_session(conn: &Connection, user_id: &str, ttl_ms: i64) -> rusqlite::Result<String> {
    let token = Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO sessions (token, user_id, expires_at) VALUES (?1, ?2, ?3)",
        params![token, user_id, now_ms() + ttl_ms],
    )?;
    Ok(token)
}

/// Apaga a sessão e, se era a última de um convidado, apaga o convidado também
fn delete_session(conn: &Connection, token: &str) -> rusqlite::Result<()> {
    let user_id: Option<String> = conn
        .query_row("DELETE FROM sessions WHERE token = ?1 RETURNING user_id", [token], |r| r.get(0))
        .optional()?;
    if let Some(user_id) = user_id {
        conn.execute(
            "DELETE FROM guests WHERE id = ?1 AND NOT EXISTS (SELECT 1 FROM sessions WHERE user_id = ?1)",
            [user_id],
        )?;
    }
    Ok(())
}

fn rand_tag() -> u32 {
    use std::time::SystemTime;
    SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .subsec_nanos()
}
