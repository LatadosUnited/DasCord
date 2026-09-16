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

## Instalação fechada (servidor exposto na internet)

Os padrões do servidor são de desenvolvimento: cadastro aberto, convidado anônimo liberado
e todo mundo entrando no servidor padrão. Numa máquina alcançável pela internet, ligue as
três variáveis abaixo — o servidor imprime as regras na subida, para não restar dúvida:

```bash
DASCORD_REQUIRE_INVITE=1     # cadastro só com convite válido
DASCORD_ALLOW_GUESTS=0       # sem convidado anônimo
DASCORD_AUTO_JOIN_DEFAULT=0  # quem chega entra só no servidor de quem convidou
DASCORD_BEHIND_PROXY=1       # o IP real vem do proxy reverso, em X-Forwarded-For
```

`GET /api/version` devolve `requireInvite` e `allowGuests`, e a tela de login se adapta:
sem convidado, o botão some; com convite obrigatório, o campo passa a ser exigido.

> **`DASCORD_BEHIND_PROXY` só com proxy de verdade na frente.** Ligado sem proxy, qualquer
> requisição pode mandar o cabeçalho `X-Forwarded-For` e escolher o próprio "IP", o que
> desmonta todos os limites por endereço.

**O primeiro convite** precisa sair de dentro: crie a sua conta com o servidor ainda aberto
(ou use uma conta que já existe), gere um convite pelo menu do servidor e só então suba com
as variáveis acima.

### Limites por endereço de IP

| O quê | Limite |
| --- | --- |
| Cadastro | 5 por hora |
| Entrada como convidado | 10 por hora |
| Tentativas de login | 20 a cada 15 minutos |
| Envio de imagens | 60 por hora |

Os contadores ficam em memória: reiniciar o servidor zera todos. São proteção contra rajada
e abuso casual, não cotas de uso.

## Voz: servidor de mídia (SFU)

A voz funciona de dois jeitos:

- **Com SFU (recomendado):** cada pessoa envia o áudio **uma vez** para o servidor de mídia, que repassa aos outros. É como o Discord funciona e é o que permite chamadas maiores.
- **Sem SFU (reserva):** os apps se conectam direto uns aos outros (malha P2P). Cada pessoa envia uma cópia do áudio para **cada** participante, então a banda de subida cresce junto com a chamada.

Para ligar o SFU:

```bash
# 1. Suba o LiveKit (portas 7880, 7881 e 7882/udp)
docker compose -f livekit/docker-compose.yml up -d

# 2. Aponte o servidor Rust para ele (veja .env.example)
#    LIVEKIT_URL=ws://localhost:7880  LIVEKIT_API_KEY=devkey  LIVEKIT_API_SECRET=dascord-dev-secret-troque-antes-de-expor
```

O app pede um token temporário em `GET /api/voice/token?channelId=...`, e só recebe se tiver acesso ao canal. A chave secreta fica **só** no servidor Rust. Se esse endereço responder 503, o app volta sozinho para P2P.

As chaves de `livekit/livekit.yaml` são de desenvolvimento: troque antes de expor o servidor.

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
