//! Quem pode entrar no servidor e como ele enxerga o mundo.
//!
//! O padrão é o de desenvolvimento (aberto, sem proxy). Em produção, todas as
//! decisões abaixo mudam por variável de ambiente — nada aqui depende de recompilar.

/// Lê uma variável "liga/desliga". Aceita 1/true/sim/on, em qualquer caixa.
fn env_flag(name: &str, default: bool) -> bool {
    match std::env::var(name) {
        Ok(value) => matches!(value.trim().to_lowercase().as_str(), "1" | "true" | "sim" | "on" | "yes"),
        Err(_) => default,
    }
}

pub struct AccessPolicy {
    /// Cadastro exige um código de convite válido
    pub require_invite: bool,
    /// Entrada como convidado anônimo (sessão de 24h)
    pub allow_guests: bool,
    /// Conta nova entra automaticamente nos servidores marcados como padrão
    pub auto_join_default: bool,
    /// Há um proxy reverso na frente: o IP do cliente vem em X-Forwarded-For.
    /// Só ligue com o proxy realmente na frente — senão o IP passa a ser falsificável.
    pub behind_proxy: bool,
}

impl AccessPolicy {
    pub fn from_env() -> Self {
        let policy = Self {
            require_invite: env_flag("DASCORD_REQUIRE_INVITE", false),
            allow_guests: env_flag("DASCORD_ALLOW_GUESTS", true),
            auto_join_default: env_flag("DASCORD_AUTO_JOIN_DEFAULT", true),
            behind_proxy: env_flag("DASCORD_BEHIND_PROXY", false),
        };
        policy.announce();
        policy
    }

    /// Deixa explícito no log com que regras o servidor subiu: numa VPS, descobrir
    /// isso tarde demais é justamente o problema.
    fn announce(&self) {
        let sim_nao = |ligado: bool| if ligado { "sim" } else { "não" };
        println!(
            "🔐 Acesso: convite obrigatório: {} · convidado anônimo: {} · entra no servidor padrão: {} · atrás de proxy: {}",
            sim_nao(self.require_invite),
            sim_nao(self.allow_guests),
            sim_nao(self.auto_join_default),
            sim_nao(self.behind_proxy),
        );
        if !self.require_invite && self.behind_proxy {
            eprintln!(
                "⚠️ O servidor está exposto por proxy com cadastro aberto: qualquer pessoa na internet \
                 pode criar conta. Defina DASCORD_REQUIRE_INVITE=1 se isso não é o que você quer."
            );
        }
    }
}
