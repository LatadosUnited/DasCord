# DasCord — mapa para o agente

Chat com servidores, DMs e voz. App **Tauri v2 + React 19 + TypeScript** (`src/`, `src-tauri/`)
e servidor **Rust (Axum + Tokio + rusqlite/SQLite)** (`server/`).
Como rodar, variáveis de ambiente e instalação fechada estão no `README.md` — não repetir aqui.

## Onde as coisas moram

**Cliente** — a dependência anda só numa direção: `components → hooks → services → api/socket`.

| Camada | Pasta | Regra |
|---|---|---|
| Componentes | `src/components/` | só desenham e chamam o que o hook entrega; um `.css` por componente |
| Estado por assunto | `src/hooks/` | um hook por domínio: sessão, servidores, mensagens, amigos, voz, digitação |
| Serviços | `src/services/` | conversa com o servidor e com o navegador; nada de React (exceto os `useSyncExternalStore` dos stores) |
| Tipos | `src/types.ts` | os tipos compartilhados do app |

- `src/App.tsx` é **raiz de composição**: junta os hooks e distribui. Não ganha estado novo.
- `useRealtimeEvents.ts` é a **única** assinatura do WebSocket; evento novo entra na tabela de
  despacho dela e vai para o hook dono do assunto — nunca num `if` solto em componente.
- `services/voice.ts` é a fachada da voz: escolhe SFU (`sfuVoice.ts`) ou malha P2P (`webrtc.ts`).
  O contrato dos dois vive em `voiceTypes.ts`, e os módulos compartilhados são `microphone.ts`,
  `vad.ts`, `screenCapture.ts`, `voiceSignaling.ts`, `voiceParticipants.ts`, `screenShareState.ts`
  e `iceRestart.ts`.

**Servidor** — `routes → stores → db`.

| Camada | Arquivos | Regra |
|---|---|---|
| Subida | `main.rs` | só env, banco, `AppState` e o router. Nada de handler. |
| Rotas | `routes/mod.rs` + um arquivo por assunto | `mod.rs` é só o mapa; a regra de cada assunto fica no módulo dele |
| Stores | `auth.rs`, `servers.rs`, `messages.rs`, `friends.rs` | todo o SQL vive aqui |
| Transporte ao vivo | `ws.rs` | protocolo do WebSocket |
| Compartilhado | `state.rs`, `events.rs`, `presence.rs`, `uploads.rs`, `policy.rs`, `db.rs`, `migration.rs` | |

- Quem recebe cada evento é decidido em `events.rs` (`channel_target`): DM só entre amigos,
  canal de servidor só para membros. **Toda** difusão passa por lá.
- Mudança de esquema do banco entra como nova versão em `migration.rs`, nunca alterando o SQL antigo.

## Antes de dizer que terminou

```bash
npx tsc --noEmit
cargo check --manifest-path server/Cargo.toml
```

Para ver rodando, use o **preview** (nunca `npm run dev` ou `cargo run` pelo Bash):
`dascord-server` (3001), `dascord-web` (1420), mais `dascord-server-sfu` e `dascord-server-fechado`
em `.claude/launch.json`.

## Armadilhas conhecidas

- **Voz mexe nos dois motores.** Uma mudança de comportamento em `webrtc.ts` (P2P) quase sempre
  precisa do equivalente em `sfuVoice.ts` (LiveKit) — o SFU é o que está em produção.
- **Build sem `VITE_API_URL` aponta para `localhost:3001`.** Vale para o instalador e para o
  `dist/` da VPS: o endereço entra no bundle na hora do build, e o padrão silencioso faz o app
  tentar falar com a máquina de quem abriu. O `deploy.sh` lê o `DASCORD_PUBLIC_URL` do serviço.
- **Assinar é o passo mais fácil de errar.** A chave vai por `TAURI_SIGNING_PRIVATE_KEY` (o
  conteúdo, não o caminho: a variável `..._PATH` é ignorada). Sem ela, o build gera os
  instaladores e só depois falha com "no private key" (código 1) — os arquivos existem, mas sem
  `.sig`. E **não tente passar a senha vazia pelo ambiente**: no Windows `$env:VAR = ""` apaga a
  variável, a CLI cai num prompt e o build trava para sempre depois de já ter gerado tudo. O
  caminho que funciona é compilar sem a chave e assinar depois:
  `npx tauri signer sign -f "$HOME\.tauri\dascord.key" -p "" <arquivo>`.
- `cargo build` falha com "Acesso negado (os error 5)" enquanto o binário do servidor está rodando:
  pare o preview antes.
- Na automação do navegador, `key Enter` **não** dispara o `onKeyDown` do React; clique o botão.
  Para elementos que ficaram atrás de modal, `.click()` por JS resolve.
- O projeto **não tem nenhum teste automatizado**. Toda verificação hoje é manual, contra o app
  rodando. Ao mudar voz, o roteiro é dois clientes de verdade (um segundo participante pelo
  WebSocket) — um cliente só não prova nada.

## Convenções

- **Tudo em português**: comentários, nomes de commit, CHANGELOG, texto de interface.
- Comentário explica **por que**, não o que a linha faz. O código já diz o que faz.
- Commits em frase corrida, sem prefixo (`feat:`, `fix:`), descrevendo a mudança do ponto de vista
  de quem usa: *"Dono do servidor cria, edita e exclui canais"*. O corpo explica o porquê e
  como foi verificado.
- Mudança que o usuário percebe entra no `CHANGELOG.md`, em "Não lançado", no estilo Keep a Changelog.
- Versão tem fonte única no `package.json`: `npm run version:sync` propaga para os `Cargo.toml`.

## Grafo do código (economiza leitura)

`graphify-out/graph.json` guarda o grafo do repositório. Para perguntas de estrutura
("quem chama X?", "o que quebra se eu mexer em Y?"), consulte o grafo antes de sair lendo arquivo:

```bash
graphify query "quem usa channel_target?"
```

Depois de mudanças grandes, atualize com `/graphify . --update`.
