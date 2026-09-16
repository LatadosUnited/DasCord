import { FC, useCallback, useEffect, useRef, useState } from 'react';
import { Info, Mic, Square, Volume2 } from 'lucide-react';
import {
  AudioDevices,
  SENSITIVITY_MAX,
  SENSITIVITY_MIN,
  applyOutputDevice,
  audioInputConstraints,
  averageVolume,
  deviceLabel,
  listAudioDevices,
  requestMicrophonePermission,
  supportsOutputSelection,
  updateVoiceSettings,
  useVoiceSettings,
} from '../../services/voiceSettings';

const toPercent = (value: number) => Math.min(100, (value / SENSITIVITY_MAX) * 100);

export const VoiceTab: FC = () => {
  const settings = useVoiceSettings();
  const [devices, setDevices] = useState<AudioDevices>({ inputs: [], outputs: [] });
  const [testing, setTesting] = useState(false);
  const [level, setLevel] = useState(0);
  const [testError, setTestError] = useState<string | null>(null);
  const [playingTone, setPlayingTone] = useState(false);

  const streamRef = useRef<MediaStream | null>(null);
  const contextRef = useRef<AudioContext | null>(null);
  const frameRef = useRef<number | null>(null);
  // Devolve a propria voz durante o teste, como no Discord
  const monitorRef = useRef<HTMLAudioElement | null>(null);

  const refreshDevices = useCallback(() => {
    listAudioDevices().then(setDevices);
  }, []);

  useEffect(() => {
    refreshDevices();
    navigator.mediaDevices?.addEventListener?.('devicechange', refreshDevices);
    return () => navigator.mediaDevices?.removeEventListener?.('devicechange', refreshDevices);
  }, [refreshDevices]);

  const stopTest = useCallback(() => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
    if (monitorRef.current) {
      monitorRef.current.pause();
      monitorRef.current.srcObject = null;
      monitorRef.current = null;
    }
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    contextRef.current?.close().catch(() => {});
    contextRef.current = null;
    setLevel(0);
    setTesting(false);
  }, []);

  const startTest = useCallback(
    async (deviceId: string) => {
      stopTest();
      setTestError(null);
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: audioInputConstraints(deviceId) });
        const context = new AudioContext();
        const analyser = context.createAnalyser();
        analyser.fftSize = 256;
        context.createMediaStreamSource(stream).connect(analyser);
        const buffer = new Uint8Array(analyser.frequencyBinCount);

        streamRef.current = stream;
        contextRef.current = context;

        // Ouvir a propria voz e o que torna o teste util: da para julgar volume e ruido
        const monitor = new Audio();
        monitor.srcObject = stream;
        applyOutputDevice(monitor, settings.outputDeviceId);
        monitor.play().catch(() => {});
        monitorRef.current = monitor;
        setTesting(true);
        refreshDevices(); // com a permissão concedida, os nomes aparecem

        const tick = () => {
          setLevel(averageVolume(analyser, buffer));
          frameRef.current = requestAnimationFrame(tick);
        };
        tick();
      } catch {
        setTestError('Não foi possível acessar o microfone. Verifique a permissão do sistema.');
      }
    },
    [refreshDevices, stopTest, settings.outputDeviceId]
  );

  // Trocar a saida durante o teste redireciona o retorno na hora
  useEffect(() => {
    if (monitorRef.current) applyOutputDevice(monitorRef.current, settings.outputDeviceId);
  }, [settings.outputDeviceId]);

  // Encerra o teste ao sair da aba
  useEffect(() => stopTest, [stopTest]);

  // Trocar o microfone durante o teste reinicia com o novo dispositivo
  useEffect(() => {
    if (streamRef.current) startTest(settings.inputDeviceId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.inputDeviceId]);

  const playTestTone = async () => {
    setPlayingTone(true);
    const context = new AudioContext();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const destination = context.createMediaStreamDestination();
    oscillator.frequency.value = 440;
    gain.gain.value = 0.15;
    oscillator.connect(gain).connect(destination);

    const audio = new Audio();
    audio.srcObject = destination.stream;
    applyOutputDevice(audio, settings.outputDeviceId);
    oscillator.start();
    await audio.play().catch(() => {});

    setTimeout(() => {
      oscillator.stop();
      audio.pause();
      context.close().catch(() => {});
      setPlayingTone(false);
    }, 700);
  };

  const grantPermission = async () => {
    if (await requestMicrophonePermission()) refreshDevices();
    else setTestError('O acesso ao microfone foi negado.');
  };

  const needsPermission = devices.inputs.length > 0 && devices.inputs.every((d) => !d.label);
  const speaking = testing && level > settings.inputSensitivity;

  return (
    <div className="settings-section">
      {needsPermission && (
        <div className="settings-notice">
          <Info size={18} />
          <span>Permita o acesso ao microfone para ver o nome dos dispositivos.</span>
          <button className="btn fit" onClick={grantPermission}>
            Permitir
          </button>
        </div>
      )}

      <div className="voice-grid">
        <label className="settings-field">
          <span className="settings-label">Dispositivo de entrada</span>
          <select
            className="input"
            value={settings.inputDeviceId}
            onChange={(e) => updateVoiceSettings({ inputDeviceId: e.target.value })}
          >
            {devices.inputs.length === 0 && <option value="default">Padrão</option>}
            {devices.inputs.map((device, index) => (
              <option key={device.deviceId || index} value={device.deviceId}>
                {deviceLabel(device, index)}
              </option>
            ))}
          </select>
        </label>

        <label className="settings-field">
          <span className="settings-label">Dispositivo de saída</span>
          <select
            className="input"
            value={settings.outputDeviceId}
            onChange={(e) => updateVoiceSettings({ outputDeviceId: e.target.value })}
            disabled={!supportsOutputSelection}
          >
            {devices.outputs.length === 0 && <option value="default">Padrão</option>}
            {devices.outputs.map((device, index) => (
              <option key={device.deviceId || index} value={device.deviceId}>
                {deviceLabel(device, index)}
              </option>
            ))}
          </select>
          {!supportsOutputSelection && (
            <span className="settings-help">Este navegador não permite escolher a saída.</span>
          )}
        </label>
      </div>

      <section className="settings-group">
        <h3 className="settings-group-title">Teste de microfone</h3>
        <p className="settings-help">
          Fale algo: você vai se ouvir de volta e a barra mostra o volume captado. A marca indica a partir de
          onde sua voz é transmitida. Se estiver sem fone, o som pode realimentar o microfone.
        </p>
        <div className="mic-test-row">
          <button
            className={`btn fit ${testing ? 'danger' : ''}`}
            onClick={() => (testing ? stopTest() : startTest(settings.inputDeviceId))}
          >
            {testing ? <Square size={14} /> : <Mic size={16} />}
            {testing ? 'Parar teste' : 'Vamos checar'}
          </button>
          <button className="btn secondary fit" onClick={playTestTone} disabled={playingTone}>
            <Volume2 size={16} />
            {playingTone ? 'Tocando...' : 'Testar saída'}
          </button>
        </div>
        {testError && <div className="settings-feedback error">{testError}</div>}
      </section>

      <section className="settings-group">
        <h3 className="settings-group-title">Sensibilidade de entrada</h3>
        <div className={`sensitivity-meter ${speaking ? 'speaking' : ''}`}>
          <div className="sensitivity-level" style={{ width: `${toPercent(level)}%` }} />
          <div className="sensitivity-threshold" style={{ left: `${toPercent(settings.inputSensitivity)}%` }} />
        </div>
        <input
          type="range"
          className="sensitivity-slider"
          min={SENSITIVITY_MIN}
          max={SENSITIVITY_MAX}
          value={settings.inputSensitivity}
          onChange={(e) => updateVoiceSettings({ inputSensitivity: Number(e.target.value) })}
          aria-label="Sensibilidade de entrada"
        />
        <p className="settings-help">
          Arraste para a esquerda se sua voz não estiver sendo detectada, ou para a direita se ruídos de fundo
          estiverem abrindo o microfone.
        </p>
      </section>

      <p className="settings-help settings-footnote">As configurações de voz ficam salvas só neste computador.</p>
    </div>
  );
};
