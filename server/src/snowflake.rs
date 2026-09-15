use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

// Época customizada do DasCord: 01 de Janeiro de 2026 00:00:00 UTC (em milissegundos)
pub const DASCORD_EPOCH: u64 = 1_767_225_600_000;

const WORKER_ID_BITS: u64 = 5;
const PROCESS_ID_BITS: u64 = 5;
const SEQUENCE_BITS: u64 = 12;

const MAX_WORKER_ID: u64 = (1 << WORKER_ID_BITS) - 1; // 31
const MAX_PROCESS_ID: u64 = (1 << PROCESS_ID_BITS) - 1; // 31
const MAX_SEQUENCE: u64 = (1 << SEQUENCE_BITS) - 1; // 4095

const PROCESS_ID_SHIFT: u64 = SEQUENCE_BITS; // 12
const WORKER_ID_SHIFT: u64 = SEQUENCE_BITS + PROCESS_ID_BITS; // 17
const TIMESTAMP_LEFT_SHIFT: u64 = SEQUENCE_BITS + PROCESS_ID_BITS + WORKER_ID_BITS; // 22

pub struct SnowflakeGenerator {
    worker_id: u64,
    process_id: u64,
    state: Mutex<GeneratorState>,
}

struct GeneratorState {
    sequence: u64,
    last_timestamp: u64,
}

impl SnowflakeGenerator {
    pub fn new(worker_id: u64, process_id: u64) -> Self {
        assert!(worker_id <= MAX_WORKER_ID, "worker_id fora do limite (máximo 31)");
        assert!(process_id <= MAX_PROCESS_ID, "process_id fora do limite (máximo 31)");

        Self {
            worker_id,
            process_id,
            state: Mutex::new(GeneratorState {
                sequence: 0,
                last_timestamp: 0,
            }),
        }
    }

    /// Gera o próximo Snowflake numérico de 64 bits
    pub fn next_id(&self) -> u64 {
        let mut state = self.state.lock().expect("Falha ao adquirir lock do Snowflake");
        let mut current_timestamp = Self::current_time_millis();

        if current_timestamp < state.last_timestamp {
            // Relógio do sistema retrocedeu, compensa usando o último carimbo
            current_timestamp = state.last_timestamp;
        }

        if state.last_timestamp == current_timestamp {
            state.sequence = (state.sequence + 1) & MAX_SEQUENCE;
            if state.sequence == 0 {
                // Esgotou a sequência dentro do mesmo milissegundo, aguarda o próximo
                while current_timestamp <= state.last_timestamp {
                    current_timestamp = Self::current_time_millis();
                }
            }
        } else {
            state.sequence = 0;
        }

        state.last_timestamp = current_timestamp;

        let time_delta = current_timestamp.saturating_sub(DASCORD_EPOCH);

        (time_delta << TIMESTAMP_LEFT_SHIFT)
            | (self.worker_id << WORKER_ID_SHIFT)
            | (self.process_id << PROCESS_ID_SHIFT)
            | state.sequence
    }

    /// Gera o Snowflake formatado como String para evitar perda de precisão em JavaScript
    pub fn next_id_string(&self) -> String {
        self.next_id().to_string()
    }

    /// Extrai o timestamp em milissegundos a partir de um Snowflake
    pub fn extract_timestamp(id: u64) -> u64 {
        (id >> TIMESTAMP_LEFT_SHIFT) + DASCORD_EPOCH
    }

    fn current_time_millis() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("Tempo do sistema anterior a UNIX_EPOCH")
            .as_millis() as u64
    }
}
