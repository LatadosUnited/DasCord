# Changelog

Todas as mudanças relevantes do DasCord ficam registradas aqui.
O formato segue o [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) e as versões seguem o [Semantic Versioning](https://semver.org/lang/pt-BR/).

## [Não lançado]

## [0.2.2] - 2026-09-17

### Corrigido
- **A janela tinha duas barras de título, e só a do Windows funcionava.** As decorações do sistema nunca foram desligadas, então a barra nativa aparecia acima da barra do app — e os botões de minimizar, maximizar e fechar do app eram só desenho, sem ação nenhuma. Agora a janela usa só a barra do DasCord, com os três botões funcionando e a área de arrastar. No navegador eles somem, que é quem manda na janela lá é o próprio navegador.

## [0.2.1] - 2026-09-17

### Adicionado
- **O app se atualiza sozinho**: ao abrir (e a cada 6 horas), ele pergunta ao servidor se há versão nova. Havendo, um aviso oferece "Atualizar agora", com o progresso do download ali mesmo; ao terminar, o app reinicia já na versão nova. Só instalador assinado com a chave do projeto é aceito.
- **Servidor distribui as atualizações do app**: `GET /api/update/{plataforma}/{arquitetura}/{versão}` responde no formato do updater do Tauri, e os instaladores saem de `/updates/`. Para publicar uma versão, basta copiar o instalador, o `.sig` e o `latest.json` para a pasta `updates` dos dados, sem reiniciar.
- **Botão de reagir no fim da fila de reações**: com o mouse na mensagem, um "+" ao lado dos emojis já usados abre o seletor ali mesmo, sem precisar subir até a barra que aparece no topo da mensagem.
- **Seletor de emoji completo**, o mesmo na caixa de mensagem e na barra de reação: quase 2000 emojis separados por categoria, busca por nome em português e sem acento ("coracao" acha ❤️), tom de pele à escolha e uma faixa de usados recentemente. Dá para navegar pelo teclado, e o emoji entra onde o cursor parou, não no fim do texto. Antes eram seis emojis fixos para reagir, e o botão da caixa de mensagem só colava 💡. Emoji que a fonte do sistema não tem fica de fora da lista, em vez de virar quadradinho.
- **Imagens no chat**: escolha pelo botão "+" da caixa de mensagem, com pré-visualização antes de enviar, até 8 MB por imagem (PNG, JPG, GIF ou WebP). A imagem só aparece para os outros quando a mensagem é enviada; a escolhida e nunca enviada é descartada.
- **Responder mensagens**: a resposta mostra um trecho da mensagem original; se ela for apagada, o trecho vira "mensagem apagada".
- **Editar e apagar mensagens**: o autor edita a própria mensagem (fica marcada como "editada") e apaga; o dono do servidor pode apagar a de qualquer um.
- **Reações com emoji** salvas no servidor: todos veem as mesmas reações e quem reagiu, no histórico também.
- **"Fulano está digitando..."** abaixo da caixa de mensagem, some sozinho quando a pessoa para.
- **Servidor de mídia (SFU)** na voz, via LiveKit: cada pessoa envia o áudio uma vez só, em vez de uma cópia para cada participante. Sobe com `docker compose -f livekit/docker-compose.yml up -d`; sem ele, a voz continua funcionando em malha P2P.
- **Quem está no canal de voz** aparece na lista de canais mesmo para quem não entrou na chamada, com indicador de fala, microfone mutado e "AO VIVO".
- **Transmissão de tela** nos canais de voz: escolha de qualidade (720p30, 1080p30 ou 1080p60, ajustável durante a transmissão), selo "AO VIVO" e contador de quem está assistindo.
- Quem está na chamada escolhe **assistir** cada transmissão; o vídeo só é enviado para quem pediu.

- **Criar, editar e excluir canais.** Até agora todo servidor nascia com um canal de texto e um de voz, e ficava assim para sempre. O dono agora cria quantos quiser pelo "+" da categoria, renomeia, escreve um assunto, muda de categoria e exclui pelos botões que aparecem ao passar o mouse no canal. Canal de texto fica em minúsculas e sem espaços, como no Discord, e o nome final aparece enquanto você digita. O servidor sempre mantém pelo menos um canal de texto.

### Segurança
- **Imagens do chat deixam de ser públicas.** Antes eram servidas por uma pasta aberta, com nomes sequenciais: quem acertasse (ou enumerasse) o endereço baixava a imagem, inclusive de mensagens diretas. Agora saem por `GET /api/attachments/{id}` com endereço assinado e validade de 15 minutos, gerado só para quem tem acesso ao canal. Avatares e ícones continuam abertos, por serem públicos por natureza.
- O anexo passa a ser guardado pelo **nome do arquivo** (esquema v6), não pela URL inteira: o endereço do servidor não fica mais embutido em cada linha do banco.
- **Instalação fechada**, para quando o servidor fica exposto na internet: cadastro só com convite (`DASCORD_REQUIRE_INVITE`), entrada como convidado desligável (`DASCORD_ALLOW_GUESTS`) e fim da entrada automática no servidor padrão (`DASCORD_AUTO_JOIN_DEFAULT`). Quem chega por convite entra no servidor de quem convidou. Os padrões continuam abertos, como em desenvolvimento.
- **Limite por endereço de IP** em cadastro, entrada como convidado, login e envio de imagens. O limite de login por conta continua valendo: um protege a senha, o outro impede varrer várias contas do mesmo lugar.
- O servidor passa a **enxergar o IP real** de quem chega (`ConnectInfo`), inclusive atrás de proxy reverso via `X-Forwarded-For` — mas só quando `DASCORD_BEHIND_PROXY` está ligado, para o cabeçalho não virar um IP escolhido por quem chama.
- `GET /api/version` informa as regras de entrada, para a tela de login não oferecer o que o servidor recusa.

### Alterado
- **O menu do próprio avatar virou um cartão de perfil**, como o popout do Discord: faixa colorida, avatar grande montado nela, nome e apelido, e o status personalizado logo abaixo. As ações ficaram em três linhas — "Editar perfil", o status atual (que abre a lista num segundo nível, com uma seta para voltar) e "Definir status personalizado". O menu também ficou maior (320px) e passou a flutuar por cima da lista de servidores, em vez de espremido dentro da barra de canais. Antes os quatro status vinham abertos de uma vez, com as descrições ocupando metade do menu.
- **As configurações agora abrem em tela cheia, no formato do Discord**: as categorias ficam numa barra à esquerda, agrupadas em "Configurações do usuário" e "Configurações do app", com o conteúdo numa coluna larga à direita e o botão de fechar com o "ESC" no canto. Antes eram abas espremidas no topo de uma caixa de 760px. "Sair" passou a viver na barra lateral, em vez de repetido no fim da aba Minha Conta. A barra de título continua visível, para a janela poder ser arrastada e fechada com as configurações abertas.
- **Reação aparece na hora do clique.** Antes o chip só mexia quando a resposta do servidor voltava, o que numa conexão lenta dá a sensação de que o clique não pegou. Agora ele responde na hora e a lista oficial do servidor manda por cima quando chega. Se em 5 segundos nenhuma confirmação vier — o servidor recusa em silêncio quando a mensagem foi apagada ou quando ela já tem 20 emojis diferentes — a reação é desfeita, em vez de ficar na tela uma reação que não existe. Sem conexão, o clique não finge nada.
- **A voz deixou de caber em uma classe só.** O motor P2P (`webrtc.ts`) fazia cinco trabalhos ao mesmo tempo em mais de mil linhas: microfone, detecção de fala, malha de conexões, transmissão de tela e o formato dos eventos no WebSocket. Saíram de lá `vad.ts` (detecção de fala), `microphone.ts` (abrir o microfone e a situação dele), `screenCapture.ts` (capturar a tela e a qualidade do vídeo), `voiceSignaling.ts` (o formato dos eventos de voz), `voiceParticipants.ts` (quem está na chamada), `screenShareState.ts` (o que está sendo transmitido) e `iceRestart.ts` (trazer de volta a conexão que caiu). O motor por SFU passa a usar os mesmos módulos em vez de repetir o código, e o contrato dos dois vive em `voiceTypes.ts`. O `webrtc.ts` foi de 1093 para 788 linhas e o `sfuVoice.ts` de 505 para 438. Nada muda para quem usa o app.
- **O `main.rs` do servidor deixou de ser dono de tudo.** Eram 1969 linhas: as 35 rotas, os handlers de todos os assuntos, o upload de imagem e o protocolo inteiro do WebSocket num arquivo só, com regra de negócio misturada ao transporte. Cada assunto virou um arquivo em `server/src/routes`, o WebSocket foi para `ws.rs`, e o que mais de um módulo usa ficou em arquivos pequenos: `state.rs` (estado e respostas curtas), `events.rs` (quem recebe cada evento), `presence.rs` e `uploads.rs`. O `main.rs` agora só sobe o processo. Nada muda no comportamento do servidor.
- **O `App.tsx` deixou de ser dono de tudo.** Era um componente de 979 linhas com 23 estados, que cuidava ao mesmo tempo de sessão, servidores, canais, mensagens, voz, amigos e digitação — mexer em um assunto obrigava a entender os outros. O estado foi para um hook por assunto em `src/hooks`, e o despacho dos eventos do WebSocket, que era um `if/else` de 130 linhas, virou uma tabela que só liga cada evento ao domínio dono dele. Nada muda para quem usa o app.
- As conexões de voz renegociam durante a chamada ("perfect negotiation"), o que também corrige o áudio de quem entra num canal onde alguém estava sem microfone liberado.
- Mudo e ensurdecido agora chegam aos outros participantes; antes o ícone do microfone ficava desatualizado.

### Corrigido
- **O menu de status saía cortado.** O menu tinha largura fixa de 280px, maior que a barra lateral de 240px, e a barra corta o que passa dela: as descrições de "Não perturbe" e "Invisível" ficavam partidas no meio da palavra. Agora os menus do painel do usuário acompanham a largura da barra.
- **Tela transmitida chegava borrada em quem assiste.** O servidor de mídia manda a tela em camadas e o app nunca pedia a maior, então quem assistia recebia um quarto da resolução escolhida — 640x360 no lugar de 1280x720, medido com dois clientes. Agora o app pede a camada de cima ao começar a assistir.
- **Ensurdecer parava de silenciar quem tivesse compartilhado a tela.** Bastava alguém transmitir para o app perder de vista o áudio dessa pessoa: o botão de ensurdecer e a troca de dispositivo de saída deixavam de alcançá-la, e o áudio dela ficava tocando solto depois de sair do canal.
- **Transmissão encerrada deixava um quadro preso em "Conectando à transmissão..."** para quem assistia, até fechar na mão. Agora o quadro fecha sozinho quando a pessoa para de transmitir, como já acontecia na malha P2P.
- **Trocar a qualidade no meio da transmissão não fazia nada** no servidor de mídia (só funcionava na malha P2P). Ao mudar para um preset menor, o limite das camadas maiores também descia — antes o limite novo ia parar na camada menor, invertido.
- Conexão de voz que caía (troca de rede, VPN) deixava a pessoa muda para sempre: agora o app reinicia o ICE e mostra "Reconectando".
- Microfone desconectado no meio da chamada troca para o padrão do sistema; sem nenhum microfone, o app avisa em vez de fingir que a pessoa está falando.
- **Trocar o endereço do servidor quebrava avatares e ícones já enviados.** O endereço completo ia gravado em cada linha do banco, então mudar de domínio deixava as imagens apontando para o lugar antigo. Agora o banco guarda só o nome do arquivo e a URL é montada na leitura (esquema v7), como já era feito com as imagens do chat. Os avatares e ícones que já existem são convertidos sozinhos na primeira subida.

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
