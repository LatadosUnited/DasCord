//! Controles virtuais para o co-op remoto.
//!
//! Cada amigo que entra numa sessão de jogo ganha um Xbox 360 virtual nesta máquina,
//! e o jogo não distingue de um plugado na USB. Por aqui passa **só** estado de
//! controle, nunca teclado ou mouse: se um dia o roteamento falhar, o pior caso é
//! alguém apertar um botão no jogo, e não digitar na máquina de quem hospeda.
//!
//! Depende do driver ViGEmBus, que é instalado à parte.

use serde::Deserialize;

/// O que chega pela rede a cada quadro, já no formato do XInput para não precisar
/// de tradução deste lado. São 11 bytes por pacote — cabe num data channel a 60 Hz
/// sem pesar. Quem traduz o formato do navegador é o cliente, em `controleVirtual.ts`.
#[derive(Deserialize, Debug, Clone, Copy, Default)]
#[serde(rename_all = "camelCase")]
pub struct EstadoControle {
    /// Máscara de botões do XInput (`wButtons`)
    pub botoes: u16,
    pub gatilho_esquerdo: u8,
    pub gatilho_direito: u8,
    pub analogico_esq_x: i16,
    pub analogico_esq_y: i16,
    pub analogico_dir_x: i16,
    pub analogico_dir_y: i16,
}

#[cfg(windows)]
mod driver {
    use super::EstadoControle;
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex};
    use vigem_client::{Client, TargetId, XButtons, XGamepad, Xbox360Wired};

    /// Mensagem para a pessoa quando o driver não atende. Quase sempre é isso mesmo:
    /// o ViGEmBus não está instalado.
    const SEM_DRIVER: &str = "Não foi possível falar com o driver ViGEmBus. \
Instale o driver e reinicie o DasCord para hospedar uma sessão de co-op.";

    type Pad = Xbox360Wired<Arc<Client>>;

    #[derive(Default)]
    struct Interno {
        /// Um cliente só do ViGEm para todos os pads; cada pad guarda a própria referência
        cliente: Option<Arc<Client>>,
        /// A chave é o participante dono do controle — no teste, um nome fixo
        pads: HashMap<String, Pad>,
    }

    #[derive(Default)]
    pub struct ControlesVirtuais(Mutex<Interno>);

    impl Interno {
        /// Conecta na primeira vez e reaproveita daí em diante
        fn cliente(&mut self) -> Result<Arc<Client>, String> {
            if let Some(cliente) = &self.cliente {
                return Ok(cliente.clone());
            }
            let cliente = Arc::new(Client::connect().map_err(|_| SEM_DRIVER.to_string())?);
            self.cliente = Some(cliente.clone());
            Ok(cliente)
        }
    }

    impl ControlesVirtuais {
        /// Só responde se o driver está aí, sem criar controle nenhum
        pub fn verificar(&self) -> Result<(), String> {
            self.0.lock().unwrap().cliente().map(|_| ())
        }

        /// Cria o controle virtual daquele participante. Chamar de novo para um slot
        /// que já existe não faz nada — a sessão pode pedir duas vezes numa reconexão.
        pub fn conectar(&self, slot: String) -> Result<(), String> {
            let mut interno = self.0.lock().unwrap();
            if interno.pads.contains_key(&slot) {
                return Ok(());
            }
            let cliente = interno.cliente()?;
            let mut pad = Xbox360Wired::new(cliente, TargetId::XBOX360_WIRED);
            pad.plugin().map_err(|e| format!("Não foi possível criar o controle virtual: {e}"))?;
            // O Windows leva um instante para enumerar o dispositivo novo; sem isso o
            // primeiro update falha com TargetNotReady
            pad.wait_ready().map_err(|e| format!("O controle virtual não ficou pronto: {e}"))?;
            interno.pads.insert(slot, pad);
            Ok(())
        }

        pub fn atualizar(&self, slot: &str, entrada: EstadoControle) -> Result<(), String> {
            let mut interno = self.0.lock().unwrap();
            let pad = interno
                .pads
                .get_mut(slot)
                .ok_or_else(|| format!("Não existe controle virtual para '{slot}'."))?;
            pad.update(&XGamepad {
                buttons: XButtons { raw: entrada.botoes },
                left_trigger: entrada.gatilho_esquerdo,
                right_trigger: entrada.gatilho_direito,
                thumb_lx: entrada.analogico_esq_x,
                thumb_ly: entrada.analogico_esq_y,
                thumb_rx: entrada.analogico_dir_x,
                thumb_ry: entrada.analogico_dir_y,
            })
            .map_err(|e| format!("Não foi possível atualizar o controle virtual: {e}"))
        }

        /// Tirar o pad do mapa já o desconecta: o Drop do vigem-client desliga o dispositivo
        pub fn desconectar(&self, slot: &str) {
            self.0.lock().unwrap().pads.remove(slot);
        }

        /// Fim de sessão: ninguém fica com controle sobrando nesta máquina
        pub fn desconectar_todos(&self) {
            self.0.lock().unwrap().pads.clear();
        }
    }
}

#[cfg(not(windows))]
mod driver {
    use super::EstadoControle;

    const SO_WINDOWS: &str = "Hospedar co-op com controle virtual só funciona no Windows.";

    #[derive(Default)]
    pub struct ControlesVirtuais;

    impl ControlesVirtuais {
        pub fn verificar(&self) -> Result<(), String> {
            Err(SO_WINDOWS.to_string())
        }
        pub fn conectar(&self, _slot: String) -> Result<(), String> {
            Err(SO_WINDOWS.to_string())
        }
        pub fn atualizar(&self, _slot: &str, _entrada: EstadoControle) -> Result<(), String> {
            Err(SO_WINDOWS.to_string())
        }
        pub fn desconectar(&self, _slot: &str) {}
        pub fn desconectar_todos(&self) {}
    }
}

pub use driver::ControlesVirtuais;

use tauri::State;

#[tauri::command]
pub fn controle_virtual_verificar(controles: State<'_, ControlesVirtuais>) -> Result<(), String> {
    controles.verificar()
}

#[tauri::command]
pub fn controle_virtual_conectar(slot: String, controles: State<'_, ControlesVirtuais>) -> Result<(), String> {
    controles.conectar(slot)
}

#[tauri::command]
pub fn controle_virtual_atualizar(
    slot: String,
    entrada: EstadoControle,
    controles: State<'_, ControlesVirtuais>,
) -> Result<(), String> {
    controles.atualizar(&slot, entrada)
}

#[tauri::command]
pub fn controle_virtual_desconectar(slot: String, controles: State<'_, ControlesVirtuais>) {
    controles.desconectar(&slot);
}

#[tauri::command]
pub fn controle_virtual_desconectar_todos(controles: State<'_, ControlesVirtuais>) {
    controles.desconectar_todos();
}

/// Nome do instalador do driver que vai junto do app, em `src-tauri/resources`
#[cfg(windows)]
const INSTALADOR_DRIVER: &str = "resources/ViGEmBus_1.22.0_x64_x86_arm64.exe";

/// Dispara o instalador do ViGEmBus que veio junto do app. Não espera terminar: quem
/// diz se deu certo é o `controle_virtual_verificar` depois, porque o instalador roda
/// elevado, em outro processo, e cancelar o UAC daqui não é erro do nosso lado.
#[cfg(windows)]
#[tauri::command]
pub fn controle_virtual_instalar_driver(app: tauri::AppHandle) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    use tauri::path::BaseDirectory;
    use tauri::Manager;

    /// Sem isso, o console do PowerShell pisca na cara da pessoa
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let caminho = app
        .path()
        .resolve(INSTALADOR_DRIVER, BaseDirectory::Resource)
        .map_err(|e| format!("O instalador do driver não veio com este app: {e}"))?;
    if !caminho.exists() {
        return Err("O instalador do driver não veio com este app.".to_string());
    }

    // O instalador pede elevação pelo manifesto dele, e o CreateProcess do Command não
    // sabe elevar — daí o Start-Process, que passa pelo shell e mostra o UAC
    std::process::Command::new("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Start-Process -Verb RunAs -FilePath $args[0]",
            "--",
        ])
        .arg(&caminho)
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map_err(|e| format!("Não foi possível abrir o instalador do driver: {e}"))?;
    Ok(())
}

#[cfg(not(windows))]
#[tauri::command]
pub fn controle_virtual_instalar_driver(_app: tauri::AppHandle) -> Result<(), String> {
    Err("O driver de controle virtual só existe no Windows.".to_string())
}
