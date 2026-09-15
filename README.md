# DasCord

Chat com servidores, mensagens diretas e voz — onde as ideias acendem.

- **App desktop:** Tauri v2 + React 19 + TypeScript (`src/`, `src-tauri/`)
- **Servidor:** Rust com Axum, WebSocket e SQLite (`server/`)

## Rodando em desenvolvimento

```bash
# Servidor (porta 3001; dados em server/data)
cargo run --manifest-path server/Cargo.toml

# App no navegador (porta 1420)
npm run dev

# App desktop
npm run tauri dev
```

As variáveis de ambiente estão documentadas em `.env.example`.

## Versionamento

O projeto segue [Semantic Versioning](https://semver.org/lang/pt-BR/): `MAIOR.MENOR.CORREÇÃO`.

- **CORREÇÃO** (0.2.**1**): correções que não mudam como o app e o servidor conversam.
- **MENOR** (0.**3**.0): funcionalidades novas. Enquanto estivermos em `0.x`, mudanças incompatíveis também sobem este número.
- **MAIOR** (**1**.0.0): primeira versão estável; depois dela, só mudanças incompatíveis sobem este número.

### Fonte única da versão

A versão fica **só** no `package.json`. O resto lê de lá:

| Onde | Como recebe a versão |
| --- | --- |
| `src-tauri/tauri.conf.json` | aponta para `../package.json` |
| App (React) | `__APP_VERSION__`, injetado pelo Vite |
| `src-tauri/Cargo.toml`, `server/Cargo.toml` e os `Cargo.lock` | `scripts/sync-version.mjs` |
| Rust (app e servidor) | `env!("CARGO_PKG_VERSION")` |

`npm run version:check` confere se tudo está igual (o `npm run build` já roda essa checagem).

### Lançando uma versão

1. Em `CHANGELOG.md`, mova o que está em **Não lançado** para uma seção com a nova versão e a data.
2. Com a árvore do Git limpa, rode `npm version patch`, `npm version minor` ou `npm version major`.
   Isso atualiza o `package.json`, sincroniza os arquivos Rust, cria o commit `Versão X.Y.Z` e a tag `vX.Y.Z`.
3. Envie o commit e a tag: `git push --follow-tags`.

### Compatibilidade entre app e servidor

O servidor informa a própria versão e a versão mínima do app em `GET /api/version`.
Se um dos dois estiver velho demais, o app mostra um aviso em vez de falhar sem explicação.

- `MIN_CLIENT_VERSION` em `server/src/main.rs`: suba quando o servidor deixar de funcionar com apps antigos.
- `MIN_SERVER_VERSION` em `src/services/version.ts`: suba quando o app passar a depender de algo novo no servidor.

O esquema do banco tem numeração própria (`PRAGMA user_version`, migrações em `server/src/db.rs`).
