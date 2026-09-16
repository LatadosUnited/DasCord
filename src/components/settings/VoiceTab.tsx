import { FC, useCallback, useEffect, useRef, useState } from 'react';
import { Headphones, HeadphoneOff, Info, Mic, Square, Volume2 } from 'lucide-react';
import {
  ANALYSER_FFT_SIZE,
  AudioDevices,
  LevelMeter,
  SENSITIVITY_MAX,
  SENSITIVITY_MIN,
  SpeechGate,
  applyOutputDevice,
  audioInputConstraints,
  createLevelMeter,
  createSpeechGate,
  deviceLabel,
  listAudioDevices,
  requestMicrophonePermission,
  supportsOutputSelection,
  updateVoiceSettings,
  useVoiceSettings,
} from '../../services/voiceSettings';

/** Sobe/desce em ~30 ms: sem a rampa o retorno estala ao ligar e desligar */
const MONITOR_RAMP = 0.03;

export const VoiceTab: FC = () => {
  const settings = useVoiceSettings();
  const [devices, setDevices] = useState<AudioDevices>({ inputs: [], outputs: [] });
  const [testing, setTesting] = useState(false);
  const [level, setLevel] = useState(0);
  const [speaking, setSpeaking] = useState(false);
  const [testError, setTestError] = useState<string | null>(null);
  const [playingTone, setPlayingTone] = useState(false);

  const streamRef = useRef<MediaStream | null>(null);
  const contextRef = useRef<AudioContext | null>(null);
  const frameRef = useRef<number | null>(null);
  const meterRef = useRef<LevelMeter | null>(null);
  const gateRef = useRef<SpeechGate | null>(null);
  // Devolve a propria voz durante o teste, como no Discord
  const monitorRef = useRef<HTMLAudioElement | null>(null);
  const monitorGainRef = useRef<GainNode | null>(null);

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
    monitorGainRef.current = null;
    meterRef.current = null;
    gateRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    contextRef.current?.close().catch(() => {});
    contextRef.current = null;
    setLevel(0);
    setSpeaking(false);
    setTesting(false);
  }, []);

  const startTest = useCallback(
    async (deviceId: string) => {
      stopTest();
      setTestError(null);
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: audioInputConstraints(deviceId) });
        const context = new AudioContext();
        // Em alguns navegadores o contexto nasce suspenso e nada tocaria nem seria medido
        await context.resume().catch(() => {});

        const source = context.createMediaStreamSource(stream);
        const analyser = context.createAnalyser();
        analyser.fftSize = ANALYSER_FFT_SIZE;
        source.connect(analyser);

        // O retorno sai pelo mesmo grafo do medidor. Ligar o stream cru num <audio>
        // faz o navegador abrir um segundo caminho de áudio e é o que picotava a voz.
        const monitorGain = context.createGain();
        monitorGain.gain.value = settings.monitorInput ? 1 : 0;
        const destination = context.createMediaStreamDestination();
        source.connect(monitorGain).connect(destination);

        const monitor = new Audio();
        monitor.srcObject = destination.stream;
        applyOutputDevice(monitor, settings.outputDeviceId);
        monitor.play().catch(() => {});

        streamRef.current = stream;
        contextRef.current = context;
        monitorRef.current = monitor;
        monitorGainRef.current = monitorGain;
        meterRef.current = createLevelMeter(analyser);
        gateRef.current = createSpeechGate();

        setTesting(true);
        refreshDevices(); // com a permissão concedida, os nomes aparecem

        const tick = () => {
          const current = meterRef.current?.read() ?? 0;
          setLevel(current);
          setSpeaking(gateRef.current?.update(current) ?? false);
          frameRef.current = requestAnimationFrame(tick);
        };
        tick();
      } catch {
        setTestError('Não foi possível acessar o microfone. Verifique a permissão do sistema.');
      }
    },
    [refreshDevices, stopTest, settings.outputDeviceId, settings.monitorInput]
  );

  // Trocar a saida durante o teste redireciona o retorno na hora
  useEffect(() => {
    if (monitorRef.current) applyOutputDevice(monitorRef.current, settings.outputDeviceId);
  }, [settings.outputDeviceId]);

  // Ligar/desligar o retorno só mexe no ganho: o teste e o medidor continuam
  useEffect(() => {
    const gain = monitorGainRef.current;
    const context = contextRef.current;
    if (!gain || !context) return;
    gain.gain.setTargetAtTime(settings.monitorInput ? 1 : 0, context.currentTime, MONITOR_RAMP);
  }, [settings.monitorInput]);

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
    await context.resume().catch(() => {});
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const destination = context.createMediaStreamDestination();
    oscillator.frequency.value = 440;
    // Entra e sai em rampa: um seno cortado no zero estala no alto-falante
    gain.gain.setValueAtTime(0, context.currentTime);
    gain.gain.linearRampToValueAtTime(0.15, context.currentTime + 0.05);
    gain.gain.setValueAtTime(0.15, context.currentTime + 0.6);
    gain.gain.linearRampToValueAtTime(0, context.currentTime + 0.7);
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
    }, 800);
  };

  const grantPermission = async () => {
    if (await requestMicrophonePermission()) refreshDevices();
    else setTestError('O acesso ao microfone foi negado.');
  };

  const needsPermission = devices.inputs.length > 0 && devices.inputs.every((d) => !d.label);

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
          Fale algo: a barra mostra o volume captado e a marca indica a partir de onde você aparece como
          falando. Com o retorno ligado você também se ouve — sem fone, o alto-falante volta para o microfone e
          o cancelamento de eco corta pedaços da sua voz.
        </p>
        <div className="mic-test-row">
          <button
            className={`btn fit ${testing ? 'danger' : ''}`}
            onClick={() => (testing ? stopTest() : startTest(settings.inputDeviceId))}
          >
            {testing ? <Square size={14} /> : <Mic size={16} />}
            {testing ? 'Parar teste' : 'Vamos checar'}
          </button>
          <button
            className="btn secondary fit"
            onClick={() => updateVoiceSettings({ monitorInput: !settings.monitorInput })}
            aria-pressed={settings.monitorInput}
          >
            {settings.monitorInput ? <Headphones size={16} /> : <HeadphoneOff size={16} />}
            {settings.monitorInput ? 'Ouvindo minha voz' : 'Retorno desligado'}
          </button>
          <button className="btn secondary fit" onClick={playTestTone} disabled={playingTone}>
            <Volume2 size={16} />
            {playingTone ? 'Tocando...' : 'Testar saída'}
          </button>
        </div>
        {testError && <div className="settings-feedback error">{testError}</div>}
      </section>

      <section className="settings-group">
        <div className="settings-group-header">
          <h3 className="settings-group-title">Sensibilidade de entrada</h3>
          <span className="sensitivity-value">{settings.inputSensitivity}%</span>
        </div>
        <div className={`sensitivity-meter ${speaking ? 'speaking' : ''}`}>
          <div className="sensitivity-level" style={{ width: `${level}%` }} />
          <div className="sensitivity-threshold" style={{ left: `${settings.inputSensitivity}%` }} />
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
          estiverem abrindo o microfone. Em 0% o microfone conta como sempre aberto.
        </p>
      </section>

      <p className="settings-help settings-footnote">As configurações de voz ficam salvas só neste computador.</p>
    </div>
  );
};
