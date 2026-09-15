use rusqlite::Connection;
use std::path::Path;
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Esquema inicial. Mudanças futuras entram como novas versões em `migrate`.
const SCHEMA_V1: &str = "
CREATE TABLE users (
    id            TEXT PRIMARY KEY,
    email         TEXT NOT NULL UNIQUE,
    username      TEXT NOT NULL UNIQUE,
    tag           TEXT NOT NULL,
    display_name  TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    salt          TEXT NOT NULL DEFAULT '',
    avatar        TEXT NOT NULL,
    role          TEXT NOT NULL,
    role_color    TEXT NOT NULL,
    created_at    INTEGER NOT NULL
);

CREATE TABLE guests (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    tag           TEXT NOT NULL,
    avatar        TEXT NOT NULL,
    custom_status TEXT NOT NULL,
    created_at    INTEGER NOT NULL
);

CREATE TABLE sessions (
    token      TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL,
    expires_at INTEGER NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

-- user_a_id < user_b_id, para que cada par exista uma única vez
CREATE TABLE friendships (
    user_a_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    user_b_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_a_id, user_b_id)
);

CREATE TABLE friend_requests (
    id           TEXT PRIMARY KEY,
    from_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    to_user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at   INTEGER NOT NULL,
    UNIQUE (from_user_id, to_user_id)
);
CREATE INDEX idx_friend_requests_to ON friend_requests(to_user_id);

-- author_json guarda o autor como estava no envio (convidados deixam de existir)
CREATE TABLE messages (
    id          TEXT PRIMARY KEY,
    channel_id  TEXT NOT NULL,
    author_id   TEXT NOT NULL,
    author_json TEXT NOT NULL,
    content     TEXT NOT NULL,
    created_at  INTEGER NOT NULL
);
CREATE INDEX idx_messages_channel ON messages(channel_id, created_at);
";

pub struct Db {
    conn: Mutex<Connection>,
}

impl Db {
    pub fn open(path: &Path) -> rusqlite::Result<Self> {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let conn = Connection::open(path)?;
        conn.pragma_update_and_check(None, "journal_mode", "WAL", |_| Ok(()))?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        conn.busy_timeout(Duration::from_secs(5))?;
        migrate(&conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    /// Nunca chame outro método de store enquanto segura esta guarda: o Mutex não é reentrante.
    pub fn conn(&self) -> MutexGuard<'_, Connection> {
        self.conn.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if version < 1 {
        conn.execute_batch(&format!("BEGIN; {SCHEMA_V1} PRAGMA user_version = 1; COMMIT;"))?;
        println!("🗄️ Banco de dados criado (esquema v1).");
    }
    Ok(())
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

/// Registra o erro real no log e devolve uma mensagem genérica para o cliente
pub fn internal_error(e: rusqlite::Error) -> String {
    eprintln!("⚠️ Erro no banco de dados: {}", e);
    "Erro interno do banco de dados.".to_string()
}
