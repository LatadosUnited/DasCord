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

### Arquivos enviados

As imagens do chat saem por `GET /api/attachments/{id}`, com endereço assinado e validade
curta, gerado só para quem tem acesso ao canal — não há pasta aberta para enumerar. A chave
da assinatura vem de `DASCORD_SIGNING_SECRET` ou, sem ela, de `signing.key`, criado junto do
banco na primeira subida. **Guarde esse arquivo nos backups**: perdê-lo não perde imagem
nenhuma, mas invalida na hora todos os endereços que já estavam abertos na tela.

Avatares e ícones de servidor continuam em pastas abertas (`/avatars`, `/icons`): são públicos
por natureza. O banco guarda só o nome do arquivo e a URL é montada na leitura, a partir de
`DASCORD_PUBLIC_URL` (esquema v7), então **trocar de domínio não quebra mais o que já foi
enviado** — as linhas antigas são convertidas sozinhas na primeira subida.

### Limites por endereço de IP

| O quê | Limite |
| --- | --- |
| Cadastro | 5 por hora |
| Entrada como convidado | 10 por hora |
| Tentativas de login | 20 a cada 15 minutos |
| Envio de imagens | 60 por hora |

Os contadores ficam em memória: reiniciar o servidor zera todos. São proteção contra rajada
e abuso casual, não cotas de uso.

## Atualizações do app

O servidor distribui as versões novas do app desktop. O app pergunta em
`GET /api/update/{plataforma}/{arquitetura}/{versão atual}` (formato do updater do Tauri):
a resposta é `204` quando não há nada mais novo e, quando há, traz a versão, as notas, o
endereço do instalador e a assinatura. Os instaladores saem de `/updates/`.

O app pergunta ao abrir e a cada 6 horas. Havendo versão nova, aparece um aviso com
"Atualizar agora": ele baixa, confere a assinatura, instala e reinicia sozinho. No navegador
o aviso nunca aparece — atualização é coisa do app desktop.

### Assinando o build

Os apps só aceitam instalador assinado com a chave do projeto. A chave pública está em
`src-tauri/tauri.conf.json`; a privada fica **fora do repositório**, em
`~/.tauri/dascord.key` (no Windows, `C:\Users\<você>\.tauri\dascord.key`).

> **Guarde a chave privada nos backups.** Sem ela não dá para publicar atualização nenhuma, e
> os apps já instalados não aceitam instalador assinado por outra chave: só uma reinstalação
> manual tiraria as pessoas da versão antiga.

```powershell
# No Windows, em PowerShell. A chave vai pelo conteúdo, não pelo caminho:
# a CLI ignora TAURI_SIGNING_PRIVATE_KEY_PATH aqui.
$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content "$HOME\.tauri\dascord.key" -Raw
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ""
npm run tauri build
```

O build gera o instalador e o `.sig` ao lado dele, em `src-tauri/target/release/bundle/`.

> **Confira se o `.sig` saiu.** Sem a chave, o build ainda gera os instaladores, reclama no fim
> ("no private key") e mesmo assim termina com sucesso. Um instalador publicado sem assinatura
> não é aceito por ninguém. No fim de um build bom aparece "Finished 2 updater signatures".

O endereço que os apps consultam também fica gravado no build, em `plugins.updater.endpoints`
do `src-tauri/tauri.conf.json`. Trocar de servidor exige um build novo, e quem já instalou o
app continua perguntando ao endereço antigo.

### Publicando

Para publicar uma versão, copie para `updates/`, dentro da pasta de dados:

1. o instalador (ex.: `DasCord_0.2.1_x64_en-US.msi`);
2. o `.sig` que o build gera ao lado dele (`DasCord_0.2.1_x64_en-US.msi.sig`);
3. o `latest.json`, **por último** — é ele que faz os apps enxergarem a versão:

```json
{
  "version": "0.2.1",
  "notes": "O que mudou nesta versão",
  "pub_date": "2026-09-17T12:00:00Z",
  "platforms": {
    "windows-x86_64": "DasCord_0.2.1_x64_en-US.msi"
  }
}
```

O build gera dois instaladores, `.msi` e `.exe` (NSIS). **Publique o mesmo tipo que as pessoas
usaram para instalar** — misturar os dois deixa duas entradas na lista de programas, cada uma
atualizando por conta própria. As instalações de hoje vieram do `.msi`.

O manifesto é lido a cada pergunta, então não precisa reiniciar o servidor. A assinatura
não vai no manifesto: o servidor lê do `.sig`. Se faltar o instalador ou a assinatura, ou
se o `latest.json` estiver malformado, o app recebe `503`, e o motivo aparece no log do
servidor. Plataforma que não está na lista continua na versão que tem.

## Subindo na VPS

`scripts/deploy.sh` atualiza o servidor: `git pull`, compila **na VPS** (o build do Windows não
roda em Linux) e reinicia o serviço. Compila antes de reiniciar, para uma compilação quebrada
não derrubar o que está no ar.

```bash
./scripts/deploy.sh                 # atualiza e reinicia o servidor
./scripts/deploy.sh --descobrir     # mostra serviço e caminhos na VPS, sem mudar nada
./scripts/deploy.sh --publicar src-tauri/target/release/bundle/msi/DasCord_0.2.1_x64_en-US.msi
```

A autenticação é por chave SSH; o script não guarda senha. Para instalar a chave uma vez:

```bash
ssh-copy-id -i ~/.ssh/dascord_vps.pub root@srv1915663.hstgr.cloud
```

Máquina, serviço e caminhos saem de `DASCORD_SSH`, `DASCORD_REMOTE_DIR`, `DASCORD_SERVICE` e
`DASCORD_REMOTE_DATA` — os padrões estão no topo do script.

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
