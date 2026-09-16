# Changelog

Todas as mudanças relevantes do DasCord ficam registradas aqui.
O formato segue o [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) e as versões seguem o [Semantic Versioning](https://semver.org/lang/pt-BR/).

## [Não lançado]

### Adicionado
- **Imagens no chat**: escolha pelo botão "+" da caixa de mensagem, com pré-visualização antes de enviar, até 8 MB por imagem (PNG, JPG, GIF ou WebP). A imagem só aparece para os outros quando a mensagem é enviada; a escolhida e nunca enviada é descartada.
- **Responder mensagens**: a resposta mostra um trecho da mensagem original; se ela for apagada, o trecho vira "mensagem apagada".
- **Editar e apagar mensagens**: o autor edita a própria mensagem (fica marcada como "editada") e apaga; o dono do servidor pode apagar a de qualquer um.
- **Reações com emoji** salvas no servidor: todos veem as mesmas reações e quem reagiu, no histórico também.
- **"Fulano está digitando..."** abaixo da caixa de mensagem, some sozinho quando a pessoa para.
- **Servidor de mídia (SFU)** na voz, via LiveKit: cada pessoa envia o áudio uma vez só, em vez de uma cópia para cada participante. Sobe com `docker compose -f livekit/docker-compose.yml up -d`; sem ele, a voz continua funcionando em malha P2P.
- **Quem está no canal de voz** aparece na lista de canais mesmo para quem não entrou na chamada, com indicador de fala, microfone mutado e "AO VIVO".
- **Transmissão de tela** nos canais de voz: escolha de qualidade (720p30, 1080p30 ou 1080p60, ajustável durante a transmissão), selo "AO VIVO" e contador de quem está assistindo.
- Quem está na chamada escolhe **assistir** cada transmissão; o vídeo só é enviado para quem pediu.

### Segurança
- **Imagens do chat deixam de ser públicas.** Antes eram servidas por uma pasta aberta, com nomes sequenciais: quem acertasse (ou enumerasse) o endereço baixava a imagem, inclusive de mensagens diretas. Agora saem por `GET /api/attachments/{id}` com endereço assinado e validade de 15 minutos, gerado só para quem tem acesso ao canal. Avatares e ícones continuam abertos, por serem públicos por natureza.
- O anexo passa a ser guardado pelo **nome do arquivo** (esquema v6), não pela URL inteira: o endereço do servidor não fica mais embutido em cada linha do banco.
- **Instalação fechada**, para quando o servidor fica exposto na internet: cadastro só com convite (`DASCORD_REQUIRE_INVITE`), entrada como convidado desligável (`DASCORD_ALLOW_GUESTS`) e fim da entrada automática no servidor padrão (`DASCORD_AUTO_JOIN_DEFAULT`). Quem chega por convite entra no servidor de quem convidou. Os padrões continuam abertos, como em desenvolvimento.
- **Limite por endereço de IP** em cadastro, entrada como convidado, login e envio de imagens. O limite de login por conta continua valendo: um protege a senha, o outro impede varrer várias contas do mesmo lugar.
- O servidor passa a **enxergar o IP real** de quem chega (`ConnectInfo`), inclusive atrás de proxy reverso via `X-Forwarded-For` — mas só quando `DASCORD_BEHIND_PROXY` está ligado, para o cabeçalho não virar um IP escolhido por quem chama.
- `GET /api/version` informa as regras de entrada, para a tela de login não oferecer o que o servidor recusa.

### Alterado
- As conexões de voz renegociam durante a chamada ("perfect negotiation"), o que também corrige o áudio de quem entra num canal onde alguém estava sem microfone liberado.
- Mudo e ensurdecido agora chegam aos outros participantes; antes o ícone do microfone ficava desatualizado.

### Corrigido
- Conexão de voz que caía (troca de rede, VPN) deixava a pessoa muda para sempre: agora o app reinicia o ICE e mostra "Reconectando".
- Microfone desconectado no meio da chamada troca para o padrão do sistema; sem nenhum microfone, o app avisa em vez de fingir que a pessoa está falando.
- **A barra de sensibilidade não chegava ao fim.** O nível era a média do espectro inteiro, e as faixas agudas vazias puxavam a conta para baixo: mesmo gritando a barra mal passava da metade. Agora a medida é o volume da onda em decibéis, e a escala vai de 0 a 100% de ponta a ponta. O limiar salvo antes é convertido sozinho para a escala nova.
- **O retorno da própria voz no teste de microfone picotava.** O som saía por um caminho de áudio paralelo ao do medidor; agora os dois saem do mesmo lugar.
- **O indicador de fala piscava no meio das frases.** Passa a esperar um instante de silêncio antes de considerar que a pessoa parou de falar, em vez de reagir a cada pausa entre sílabas.
- **A sensibilidade de entrada não fazia nada quando a voz passava pelo servidor de mídia.** Quem decidia se você estava falando era o limiar do próprio LiveKit, e o controle das Configurações só valia na voz em malha P2P. Agora cada pessoa aplica o próprio limiar à própria voz nos dois modos, e o resultado é o que os outros veem.
- O tom de "Testar saída" entra e sai suave, sem o estalo de antes.
- Trocar qualquer configuração de voz reabria o microfone na chamada pelo servidor de mídia, inclusive ao arrastar o controle de sensibilidade. Agora só a troca de dispositivo mexe no microfone.

### Alterado
- O teste de microfone ganhou um botão para **desligar o retorno da própria voz**: sem fone, o alto-falante volta para o microfone e o cancelamento de eco corta pedaços da voz. Assim dá para conferir o nível sem se ouvir.
- A sensibilidade de entrada mostra o valor em porcentagem ao lado do título.

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
