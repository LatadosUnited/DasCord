//! Importa os antigos users.json / friends.json para o SQLite, uma única vez.

use rusqlite::params;
use serde::Deserialize;
use std::collections::HashMap;
use std::fs;
use std::path::Path;

use crate::db::Db;
use crate::friends::ordered_pair;

#[derive(Deserialize)]
struct LegacyUser {
    id: String,
    email: String,
    username: String,
    tag: String,
    display_name: String,
    password_hash: String,
    #[serde(default)]
    salt: String,
    avatar: String,
    role: String,
    role_color: String,
    created_at: i64,
}

#[derive(Deserialize)]
struct LegacyFriendship {
    user_a_id: String,
    user_b_id: String,
    created_at: i64,
}

#[derive(Deserialize)]
struct LegacyRequest {
    id: String,
    from_user_id: String,
    to_user_id: String,
    created_at: i64,
}

#[derive(Deserialize, Default)]
struct LegacyFriends {
    #[serde(default)]
    friendships: Vec<LegacyFriendship>,
    #[serde(default)]
    requests: Vec<LegacyRequest>,
}

pub fn import_legacy_json(db: &Db, data_dir: &Path) {
    let users_path = data_dir.join("users.json");
    if !users_path.exists() {
        return;
    }
    let friends_path = data_dir.join("friends.json");

    let users: HashMap<String, LegacyUser> = match fs::read_to_string(&users_path)
        .map_err(|e| e.to_string())
        .and_then(|c| serde_json::from_str(&c).map_err(|e| e.to_string()))
    {
        Ok(users) => users,
        Err(e) => {
            eprintln!("⚠️ users.json não pôde ser lido, migração ignorada: {}", e);
            return;
        }
    };

    let friends: LegacyFriends = if friends_path.exists() {
        match fs::read_to_string(&friends_path)
            .map_err(|e| e.to_string())
            .and_then(|c| serde_json::from_str(&c).map_err(|e| e.to_string()))
        {
            Ok(friends) => friends,
            Err(e) => {
                eprintln!("⚠️ friends.json não pôde ser lido, migração ignorada: {}", e);
                return;
            }
        }
    } else {
        LegacyFriends::default()
    };

    let result = (|| -> rusqlite::Result<Option<(usize, usize, usize)>> {
        let mut conn = db.conn();
        let existing: i64 = conn.query_row("SELECT COUNT(*) FROM users", [], |r| r.get(0))?;
        if existing > 0 {
            return Ok(None);
        }

        let tx = conn.transaction()?;
        for u in users.values() {
            // O banco guarda só o nome do arquivo; endereço antigo vira nome
            let avatar = crate::media::stored_name(&u.avatar, "avatars");
            tx.execute(
                "INSERT INTO users (id, email, username, tag, display_name, password_hash, salt, avatar, role, role_color, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                params![
                    u.id, u.email.to_lowercase(), u.username.to_lowercase(), u.tag, u.display_name,
                    u.password_hash, u.salt, avatar, u.role, u.role_color, u.created_at
                ],
            )?;
        }

        // Registros que apontam para usuários inexistentes são descartados
        let known = |id: &str| users.contains_key(id);
        let mut friendship_count = 0;
        for f in friends.friendships.iter().filter(|f| known(&f.user_a_id) && known(&f.user_b_id)) {
            let (a, b) = ordered_pair(&f.user_a_id, &f.user_b_id);
            friendship_count += tx.execute(
                "INSERT OR IGNORE INTO friendships (user_a_id, user_b_id, created_at) VALUES (?1, ?2, ?3)",
                params![a, b, f.created_at],
            )?;
        }
        let mut request_count = 0;
        for r in friends.requests.iter().filter(|r| known(&r.from_user_id) && known(&r.to_user_id)) {
            request_count += tx.execute(
                "INSERT OR IGNORE INTO friend_requests (id, from_user_id, to_user_id, created_at) VALUES (?1, ?2, ?3, ?4)",
                params![r.id, r.from_user_id, r.to_user_id, r.created_at],
            )?;
        }
        // O esquema v3 já colocou no DasIdeia HQ quem existia; os importados entram agora
        tx.execute(
            "INSERT OR IGNORE INTO server_members (server_id, user_id, joined_at)
             SELECT servers.id, users.id, ?1 FROM servers, users WHERE servers.is_default = 1",
            [crate::db::now_ms()],
        )?;
        tx.commit()?;
        Ok(Some((users.len(), friendship_count, request_count)))
    })();

    match result {
        Ok(Some((u, f, r))) => {
            println!("📦 Migrados do JSON para o SQLite: {} usuários, {} amizades, {} pedidos.", u, f, r);
            let _ = fs::rename(&users_path, data_dir.join("users.json.migrated"));
            if friends_path.exists() {
                let _ = fs::rename(&friends_path, data_dir.join("friends.json.migrated"));
            }
        }
        Ok(None) => {
            eprintln!("⚠️ users.json encontrado, mas o banco já tem usuários. Arquivo mantido e ignorado.");
        }
        Err(e) => {
            eprintln!("⚠️ Falha ao migrar JSON para o SQLite (nada foi alterado): {}", e);
        }
    }
}
