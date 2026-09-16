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

/// v2: status de presença escolhido pelo usuário e status personalizado
const SCHEMA_V2: &str = "
ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'online';
ALTER TABLE users ADD COLUMN custom_status TEXT NOT NULL DEFAULT '';
ALTER TABLE guests ADD COLUMN status TEXT NOT NULL DEFAULT 'online';
";

/// v3: servidores, membros, canais e convites.
/// Cria o DasIdeia HQ, do qual todo mundo faz parte, reaproveitando os IDs de canal
/// que o app já usava (o histórico salvo nesses canais continua aparecendo).
const SCHEMA_V3: &str = "
-- owner_id NULL: servidor do sistema, que ninguém pode excluir
CREATE TABLE servers (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    icon       TEXT NOT NULL DEFAULT '',
    owner_id   TEXT,
    is_default INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
);

-- user_id sem chave estrangeira: pode ser uma conta ou um convidado
CREATE TABLE server_members (
    server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    user_id   TEXT NOT NULL,
    joined_at INTEGER NOT NULL,
    PRIMARY KEY (server_id, user_id)
);
CREATE INDEX idx_server_members_user ON server_members(user_id);

CREATE TABLE channels (
    id        TEXT PRIMARY KEY,
    server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    name      TEXT NOT NULL,
    kind      TEXT NOT NULL CHECK (kind IN ('text', 'voice')),
    topic     TEXT NOT NULL DEFAULT '',
    category  TEXT NOT NULL,
    position  INTEGER NOT NULL
);
CREATE INDEX idx_channels_server ON channels(server_id, position);

-- expires_at e max_uses NULL: sem validade / sem limite de usos
CREATE TABLE invites (
    code       TEXT PRIMARY KEY,
    server_id  TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    created_by TEXT NOT NULL,
    expires_at INTEGER,
    max_uses   INTEGER,
    uses       INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
);
CREATE INDEX idx_invites_server ON invites(server_id);

-- Convidados expiram: some junto a participação deles nos servidores
CREATE TRIGGER guests_leave_servers AFTER DELETE ON guests
BEGIN
    DELETE FROM server_members WHERE user_id = OLD.id;
END;
CREATE TRIGGER users_leave_servers AFTER DELETE ON users
BEGIN
    DELETE FROM server_members WHERE user_id = OLD.id;
END;

INSERT INTO servers (id, name, owner_id, is_default, created_at)
VALUES ('s-dasideia', 'DasIdeia HQ', NULL, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000);

INSERT INTO channels (id, server_id, name, kind, topic, category, position) VALUES
    ('c-geral', 's-dasideia', 'geral', 'text', 'Conversas gerais da equipe DasIdeia', 'Canais de texto', 0),
    ('c-rust-dev', 's-dasideia', 'rust-dev', 'text', 'Backend em Rust, Axum, Tokio e Tauri', 'Canais de texto', 1),
    ('c-anuncios', 's-dasideia', 'anúncios', 'text', 'Comunicados importantes da comunidade', 'Canais de texto', 2),
    ('c-voice-lounge', 's-dasideia', 'Sala Principal', 'voice', '', 'Canais de voz', 3),
    ('c-voice-devs', 's-dasideia', 'Sala Dev & Pair', 'voice', '', 'Canais de voz', 4);

INSERT INTO server_members (server_id, user_id, joined_at)
    SELECT 's-dasideia', id, CAST(strftime('%s', 'now') AS INTEGER) * 1000 FROM users
    UNION ALL
    SELECT 's-dasideia', id, CAST(strftime('%s', 'now') AS INTEGER) * 1000 FROM guests;
";

/// v4: mensagens editadas, apagadas, respostas e reações salvas.
/// deleted_at preenchido: a mensagem some do histórico, mas continua servindo
/// de referência para quem respondeu a ela.
const SCHEMA_V4: &str = "
ALTER TABLE messages ADD COLUMN edited_at INTEGER;
ALTER TABLE messages ADD COLUMN deleted_at INTEGER;
ALTER TABLE messages ADD COLUMN reply_to_id TEXT;

CREATE TABLE message_reactions (
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id    TEXT NOT NULL,
    emoji      TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (message_id, user_id, emoji)
);
CREATE INDEX idx_message_reactions_message ON message_reactions(message_id, created_at);
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
    if version < 2 {
        conn.execute_batch(&format!("BEGIN; {SCHEMA_V2} PRAGMA user_version = 2; COMMIT;"))?;
        println!("🗄️ Banco de dados atualizado para o esquema v2 (status de presença).");
    }
    if version < 3 {
        conn.execute_batch(&format!("BEGIN; {SCHEMA_V3} PRAGMA user_version = 3; COMMIT;"))?;
        println!("🗄️ Banco de dados atualizado para o esquema v3 (servidores e convites).");
    }
    if version < 4 {
        conn.execute_batch(&format!("BEGIN; {SCHEMA_V4} PRAGMA user_version = 4; COMMIT;"))?;
        println!("🗄️ Banco de dados atualizado para o esquema v4 (edição, respostas e reações).");
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
