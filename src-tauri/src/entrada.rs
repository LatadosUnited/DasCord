//! Teclado e mouse de quem controla, aplicados nesta máquina.
//!
//! Diferente do controle virtual, aqui não há driver: o `enigo` embrulha o `SendInput`
//! do Windows, que é API de usuário comum. Em troca, valem os limites dela — entrada
//! injetada não alcança programa rodando como administrador a menos que o DasCord
//! também esteja, e some enquanto o UAC está na tela.
//!
//! Quem decide se um pacote destes pode ser aplicado é o app de quem hospeda, antes de
//! chamar qualquer coisa daqui. Este módulo é só o braço: ele não conhece participante,
//! não conhece sessão e não pergunta nada.

use serde::Serialize;

/// Um monitor desta máquina, em pixels de verdade — é contra ele que a posição
/// normalizada de quem controla vira clique no lugar certo.
#[derive(Serialize, Debug, Clone)]
pub struct Monitor {
    pub nome: String,
    pub x: i32,
    pub y: i32,
    pub largura: u32,
    pub altura: u32,
    /// Escala do Windows (125%, 150%...). Vem junto porque a tela compartilhada
    /// pode ter sido capturada em pontos lógicos, não em pixels.
    pub escala: f64,
    pub principal: bool,
}

/// Quais botões do mouse quem controla pode apertar. O navegador manda o índice
/// do `MouseEvent.button`; o que não estiver aqui é ignorado de propósito.
#[derive(Debug, Clone, Copy)]
pub enum BotaoMouse {
    Esquerdo,
    Meio,
    Direito,
}

impl BotaoMouse {
    fn do_navegador(indice: u8) -> Option<Self> {
        match indice {
            0 => Some(Self::Esquerdo),
            1 => Some(Self::Meio),
            2 => Some(Self::Direito),
            _ => None,
        }
    }
}

#[cfg(windows)]
mod braco {
    use super::BotaoMouse;
    use enigo::{Axis, Button, Coordinate, Direction, Enigo, Key, Keyboard, Mouse, Settings};
    use std::sync::Mutex;

    /// O `Enigo` é criado na primeira vez e reaproveitado: recriar a cada evento
    /// custaria caro num fluxo de 60 eventos por segundo.
    #[derive(Default)]
    pub struct Entrada(Mutex<Option<Enigo>>);

    impl Entrada {
        fn com<T>(&self, acao: impl FnOnce(&mut Enigo) -> Result<T, String>) -> Result<T, String> {
            let mut guarda = self.0.lock().unwrap();
            if guarda.is_none() {
                *guarda = Some(
                    Enigo::new(&Settings::default())
                        .map_err(|e| format!("Não foi possível preparar o teclado e o mouse: {e}"))?,
                );
            }
            acao(guarda.as_mut().expect("acabou de ser criado"))
        }

        /// `x` e `y` já vêm em pixels da área de trabalho, com o monitor certo somado
        pub fn mover_mouse(&self, x: i32, y: i32) -> Result<(), String> {
            self.com(|enigo| {
                enigo
                    .move_mouse(x, y, Coordinate::Abs)
                    .map_err(|e| format!("Não foi possível mover o mouse: {e}"))
            })
        }

        pub fn botao_mouse(&self, botao: BotaoMouse, pressionado: bool) -> Result<(), String> {
            let botao = match botao {
                BotaoMouse::Esquerdo => Button::Left,
                BotaoMouse::Meio => Button::Middle,
                BotaoMouse::Direito => Button::Right,
            };
            let direcao = if pressionado { Direction::Press } else { Direction::Release };
            self.com(|enigo| {
                enigo
                    .button(botao, direcao)
                    .map_err(|e| format!("Não foi possível apertar o botão do mouse: {e}"))
            })
        }

        pub fn roda_mouse(&self, horizontal: i32, vertical: i32) -> Result<(), String> {
            self.com(|enigo| {
                if horizontal != 0 {
                    enigo
                        .scroll(horizontal, Axis::Horizontal)
                        .map_err(|e| format!("Não foi possível rolar a tela: {e}"))?;
                }
                if vertical != 0 {
                    enigo
                        .scroll(vertical, Axis::Vertical)
                        .map_err(|e| format!("Não foi possível rolar a tela: {e}"))?;
                }
                Ok(())
            })
        }

        /// `vk` é o código de tecla virtual do Windows, que o cliente traduz a partir
        /// do `KeyboardEvent.code` — assim o layout de quem controla não interfere
        pub fn tecla(&self, vk: u16, pressionado: bool) -> Result<(), String> {
            let direcao = if pressionado { Direction::Press } else { Direction::Release };
            self.com(|enigo| {
                enigo
                    .key(Key::Other(vk as u32), direcao)
                    .map_err(|e| format!("Não foi possível apertar a tecla: {e}"))
            })
        }
    }
}

#[cfg(not(windows))]
mod braco {
    use super::BotaoMouse;

    const SO_WINDOWS: &str = "Controlar esta máquina só funciona no Windows.";

    #[derive(Default)]
    pub struct Entrada;

    impl Entrada {
        pub fn mover_mouse(&self, _x: i32, _y: i32) -> Result<(), String> {
            Err(SO_WINDOWS.to_string())
        }
        pub fn botao_mouse(&self, _botao: BotaoMouse, _pressionado: bool) -> Result<(), String> {
            Err(SO_WINDOWS.to_string())
        }
        pub fn roda_mouse(&self, _horizontal: i32, _vertical: i32) -> Result<(), String> {
            Err(SO_WINDOWS.to_string())
        }
        pub fn tecla(&self, _vk: u16, _pressionado: bool) -> Result<(), String> {
            Err(SO_WINDOWS.to_string())
        }
    }
}

pub use braco::Entrada;

use tauri::State;

/// Os monitores desta máquina, para quem hospeda escolher qual está compartilhando.
/// O `getDisplayMedia` não conta qual tela a pessoa escolheu, então a escolha é dela.
#[tauri::command]
pub fn entrada_monitores(app: tauri::AppHandle) -> Result<Vec<Monitor>, String> {
    let principal = app
        .primary_monitor()
        .map_err(|e| format!("Não foi possível ler os monitores: {e}"))?
        .and_then(|m| m.name().cloned());

    let monitores = app
        .available_monitors()
        .map_err(|e| format!("Não foi possível ler os monitores: {e}"))?;

    Ok(monitores
        .into_iter()
        .enumerate()
        .map(|(i, m)| {
            let nome = m.name().cloned().unwrap_or_else(|| format!("Monitor {}", i + 1));
            Monitor {
                principal: Some(&nome) == principal.as_ref(),
                x: m.position().x,
                y: m.position().y,
                largura: m.size().width,
                altura: m.size().height,
                escala: m.scale_factor(),
                nome,
            }
        })
        .collect())
}

/// Posição vem normalizada (0 a 1) dentro do monitor compartilhado: assim a resolução
/// do vídeo, o recorte da captura e a escala do Windows deixam de importar.
#[tauri::command]
pub fn entrada_mouse_mover(
    monitor: String,
    x: f64,
    y: f64,
    app: tauri::AppHandle,
    entrada: State<'_, Entrada>,
) -> Result<(), String> {
    let alvo = entrada_monitores(app)?
        .into_iter()
        .find(|m| m.nome == monitor)
        .ok_or_else(|| format!("O monitor escolhido não existe mais nesta máquina: {monitor}"))?;

    // Fora de 0..1 é pacote estragado ou ponteiro fora da tela; prender na borda é mais
    // seguro do que deixar o cursor sair para outro monitor
    let x = x.clamp(0.0, 1.0);
    let y = y.clamp(0.0, 1.0);
    let absoluto_x = alvo.x + (x * alvo.largura as f64).round() as i32;
    let absoluto_y = alvo.y + (y * alvo.altura as f64).round() as i32;
    entrada.mover_mouse(absoluto_x, absoluto_y)
}

#[tauri::command]
pub fn entrada_mouse_botao(botao: u8, pressionado: bool, entrada: State<'_, Entrada>) -> Result<(), String> {
    let botao = BotaoMouse::do_navegador(botao).ok_or("Botão de mouse desconhecido.")?;
    entrada.botao_mouse(botao, pressionado)
}

#[tauri::command]
pub fn entrada_mouse_roda(horizontal: i32, vertical: i32, entrada: State<'_, Entrada>) -> Result<(), String> {
    entrada.roda_mouse(horizontal, vertical)
}

#[tauri::command]
pub fn entrada_tecla(vk: u16, pressionado: bool, entrada: State<'_, Entrada>) -> Result<(), String> {
    entrada.tecla(vk, pressionado)
}
