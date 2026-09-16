//! Entrar e sair: cadastro, login, convidado, logout e conferência da sessão.

use axum::{
    extract::{ConnectInfo, State},
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    Json,
};
use std::{net::SocketAddr, sync::Arc};

use crate::auth::{AuthResponse, LoginError, LoginRequest, PublicUser, RegisterRequest};
use crate::events::{publish_member_joined, welcome_to_default_servers};
use crate::state::{client_ip, extract_token, AppState, GenericResponse};

pub fn auth_success(status: StatusCode, token: String, user: PublicUser) -> (StatusCode, Json<AuthResponse>) {
    (
        status,
        Json(AuthResponse {
            success: true,
            token: Some(token),
            user: Some(user),
            error: None,
        }),
    )
}

pub fn auth_failure(status: StatusCode, error: String) -> (StatusCode, Json<AuthResponse>) {
    (
        status,
        Json(AuthResponse {
            success: false,
            token: None,
            user: None,
            error: Some(error),
        }),
    )
}

// Handler de Registro de Usuário
pub async fn register_handler(
    State(state): State<Arc<AppState>>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(payload): Json<RegisterRequest>,
) -> impl IntoResponse {
    let ip = client_ip(&state, &headers, addr);
    if !state.register_limit.check(&ip) {
        return auth_failure(
            StatusCode::TOO_MANY_REQUESTS,
            "Muitas contas criadas deste endereço. Tente de novo mais tarde.".to_string(),
        );
    }

    // O convite é conferido antes de criar qualquer coisa, e só é consumido no fim
    let invite = payload.invite_code.clone().filter(|code| !code.trim().is_empty());
    if state.policy.require_invite {
        let Some(code) = invite.as_deref() else {
            return auth_failure(
                StatusCode::FORBIDDEN,
                "Este servidor é fechado: você precisa de um convite para criar uma conta.".to_string(),
            );
        };
        if state.servers.peek_invite(code).is_err() {
            return auth_failure(StatusCode::FORBIDDEN, "Convite inválido ou expirado.".to_string());
        }
    }

    // argon2 é CPU-bound: roda fora das threads do runtime async
    let st = state.clone();
    let result = tokio::task::spawn_blocking(move || st.auth.register(payload, &st.snowflake)).await;

    match result {
        Ok(Ok((token, user))) => {
            welcome_to_default_servers(&state, &user);
            // Quem chegou por convite entra no servidor de quem convidou
            if let Some(code) = invite.as_deref() {
                match state.servers.accept_invite(code, &user.id) {
                    Ok((server, joined)) if joined => publish_member_joined(&state, &server.id, &user),
                    Ok(_) => {}
                    Err(_) => eprintln!("⚠️ Conta criada, mas o convite não pôde ser usado: {}", code),
                }
            }
            auth_success(StatusCode::CREATED, token, user)
        }
        Ok(Err(err)) => auth_failure(StatusCode::BAD_REQUEST, err),
        Err(_) => auth_failure(StatusCode::INTERNAL_SERVER_ERROR, "Erro interno do servidor.".to_string()),
    }
}

// Handler de Login
pub async fn login_handler(
    State(state): State<Arc<AppState>>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(payload): Json<LoginRequest>,
) -> impl IntoResponse {
    // Limite por IP além do limite por conta: um não substitui o outro.
    // Por conta, protege a senha; por IP, impede varrer várias contas de um lugar só.
    let ip = client_ip(&state, &headers, addr);
    if !state.login_limit.check(&ip) {
        return auth_failure(
            StatusCode::TOO_MANY_REQUESTS,
            "Muitas tentativas deste endereço. Aguarde alguns minutos.".to_string(),
        );
    }

    let st = state.clone();
    let result = tokio::task::spawn_blocking(move || st.auth.login(payload)).await;

    match result {
        Ok(Ok((token, user))) => auth_success(StatusCode::OK, token, user),
        Ok(Err(err @ LoginError::TooManyAttempts)) => auth_failure(StatusCode::TOO_MANY_REQUESTS, err.message()),
        Ok(Err(err @ LoginError::InvalidCredentials)) => auth_failure(StatusCode::UNAUTHORIZED, err.message()),
        Ok(Err(err @ LoginError::Internal(_))) => auth_failure(StatusCode::INTERNAL_SERVER_ERROR, err.message()),
        Err(_) => auth_failure(StatusCode::INTERNAL_SERVER_ERROR, "Erro interno do servidor.".to_string()),
    }
}

// Handler de Sessão de Convidado (expira em 24h)
pub async fn guest_handler(
    State(state): State<Arc<AppState>>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> impl IntoResponse {
    if !state.policy.allow_guests {
        return auth_failure(
            StatusCode::FORBIDDEN,
            "Este servidor não aceita convidados. Peça um convite para criar uma conta.".to_string(),
        );
    }
    let ip = client_ip(&state, &headers, addr);
    if !state.guest_limit.check(&ip) {
        return auth_failure(
            StatusCode::TOO_MANY_REQUESTS,
            "Muitas entradas como convidado deste endereço. Tente de novo mais tarde.".to_string(),
        );
    }

    match state.auth.create_guest(&state.snowflake) {
        Ok((token, user)) => {
            welcome_to_default_servers(&state, &user);
            auth_success(StatusCode::CREATED, token, user)
        }
        Err(err) => auth_failure(StatusCode::INTERNAL_SERVER_ERROR, err),
    }
}

// Handler de Logout: invalida o token no servidor
pub async fn logout_handler(State(state): State<Arc<AppState>>, headers: HeaderMap) -> impl IntoResponse {
    if let Some(token) = extract_token(&headers) {
        state.auth.logout(&token);
    }
    Json(GenericResponse {
        success: true,
        message: None,
        error: None,
    })
}

// Handler de Validação de Sessão / Me
pub async fn me_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> impl IntoResponse {
    if let Some(token) = extract_token(&headers) {
        if let Some(user) = state.auth.get_by_token(&token) {
            return auth_success(StatusCode::OK, token, user);
        }
    }

    auth_failure(StatusCode::UNAUTHORIZED, "Sessão inválida ou expirada.".to_string())
}
