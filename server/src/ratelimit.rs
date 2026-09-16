//! Limite de requisições por chave (normalmente o IP), em memória.
//!
//! Reiniciar o servidor zera os contadores, de propósito: é uma proteção contra
//! rajada e abuso casual, não um controle de cotas.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

struct Window {
    count: u32,
    started_at: Instant,
}

pub struct RateLimiter {
    /// Nome que aparece no log quando alguém estoura o limite
    label: &'static str,
    max: u32,
    window: Duration,
    hits: Mutex<HashMap<String, Window>>,
}

impl RateLimiter {
    pub fn new(label: &'static str, max: u32, window: Duration) -> Self {
        Self {
            label,
            max,
            window,
            hits: Mutex::new(HashMap::new()),
        }
    }

    /// Registra uma tentativa. `false` quando a chave já passou do limite da janela.
    pub fn check(&self, key: &str) -> bool {
        let mut hits = self.hits.lock().unwrap_or_else(|poisoned| poisoned.into_inner());

        // A limpeza acontece aqui mesmo: sem tarefa de fundo e sem crescer sem fim
        if hits.len() > 10_000 {
            hits.retain(|_, w| w.started_at.elapsed() <= self.window);
        }

        let entry = hits.entry(key.to_string()).or_insert(Window {
            count: 0,
            started_at: Instant::now(),
        });
        if entry.started_at.elapsed() > self.window {
            entry.count = 0;
            entry.started_at = Instant::now();
        }
        entry.count += 1;

        if entry.count > self.max {
            // Só avisa ao cruzar o limite, para uma rajada não virar enxurrada de log
            if entry.count == self.max + 1 {
                eprintln!("🚧 Limite de {} atingido por {}.", self.label, key);
            }
            return false;
        }
        true
    }
}
