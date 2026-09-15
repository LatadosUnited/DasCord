# Changelog

Todas as mudanças relevantes do DasCord ficam registradas aqui.
O formato segue o [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) e as versões seguem o [Semantic Versioning](https://semver.org/lang/pt-BR/).

## [Não lançado]

## [0.2.0] - 2026-09-15

### Adicionado
- **Servidores reais**, salvos no banco: criar (com ícone), renomear, trocar ícone, excluir e sair.
- **DasIdeia HQ** como servidor padrão, do qual todas as contas e convidados participam.
- **Convites** com validade (30 minutos a nunca) e limite de usos; entrada por código ou link.
- **Lista de membros** real, com presença ao vivo e destaque para o dono do servidor.
- Eventos em tempo real para membro que entra ou sai e servidor atualizado ou excluído.
- **Configurações de usuário**: Minha Conta (troca de senha, encerrar outras sessões), Perfil (nome e avatar) e Voz e Áudio (dispositivos e sensibilidade).
- Menu de status (disponível, ausente, não perturbe, invisível) e status personalizado.
- **Versionamento**: versão única no `package.json`, `GET /api/version`, versão visível no app e aviso quando app e servidor são incompatíveis.

### Alterado
- Identidade visual própria, **Faísca** (grafite quente + âmbar), com CSS modular por componente.
- O servidor guarda os dados em `server/data` independentemente de onde é iniciado.

### Segurança
- Mensagens, histórico e voz dos servidores chegam só aos membros; antes, qualquer canal fora das DMs chegava a todos os conectados.

### Removido
- Servidores, canais, usuários e mensagens de exemplo (mocks).

## [0.1.0] - 2026-09-15

### Adicionado
- Primeira versão: app Tauri + React e servidor Rust (Axum + WebSocket) com SQLite.
- Contas com argon2, sessões com validade, convidados e limite de tentativas de login.
- Amizades, mensagens diretas, canais de texto com histórico e voz via WebRTC.

[Não lançado]: https://github.com/LatadosUnited/DasCord/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/LatadosUnited/DasCord/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/LatadosUnited/DasCord/releases/tag/v0.1.0
