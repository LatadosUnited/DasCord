import { ChangeEvent, FC, useEffect, useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, ImagePlus } from 'lucide-react';
import { User } from '../../types';
import { AVATAR_TYPES, MAX_AVATAR_BYTES, apiUpdateProfile, apiUploadAvatar, isGuestUser } from '../../services/users';
import { MAX_DISPLAY_NAME_CHARS, statusLabel } from '../../services/presence';

interface ProfileTabProps {
  user: User;
  onUserUpdated: (user: User) => void;
  onDirtyChange: (dirty: boolean) => void;
  /** Muda quando o usuário tenta sair com alterações pendentes */
  attentionSignal: number;
}

export const ProfileTab: FC<ProfileTabProps> = ({ user, onUserUpdated, onDirtyChange, attentionSignal }) => {
  const guest = isGuestUser(user);
  const [displayName, setDisplayName] = useState(user.name);
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [shake, setShake] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const trimmedName = displayName.trim();
  const dirty = trimmedName !== user.name || avatarFile !== null;

  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);

  // Ao sair da aba, não deixa o modal achando que há alterações pendentes
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);

  // Libera a URL temporária da prévia
  useEffect(() => {
    if (!avatarFile) {
      setAvatarPreview(null);
      return;
    }
    const url = URL.createObjectURL(avatarFile);
    setAvatarPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [avatarFile]);

  useEffect(() => {
    if (attentionSignal === 0) return;
    setShake(true);
    const timer = setTimeout(() => setShake(false), 500);
    return () => clearTimeout(timer);
  }, [attentionSignal]);

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // permite escolher o mesmo arquivo de novo
    if (!file) return;

    setSaved(false);
    if (!AVATAR_TYPES.includes(file.type)) {
      setError('Formato não suportado. Use PNG, JPG, GIF ou WebP.');
      return;
    }
    if (file.size > MAX_AVATAR_BYTES) {
      setError('A imagem é grande demais. O máximo é 2 MB.');
      return;
    }
    setError(null);
    setAvatarFile(file);
  };

  const reset = () => {
    setDisplayName(user.name);
    setAvatarFile(null);
    setError(null);
  };

  const save = async () => {
    if (!trimmedName) {
      setError('O nome de exibição não pode ficar vazio.');
      return;
    }
    setSaving(true);
    setError(null);

    let latest = user;
    if (avatarFile) {
      const res = await apiUploadAvatar(avatarFile);
      if (!res.ok) {
        setSaving(false);
        setError(res.error);
        return;
      }
      latest = res.data.user;
      onUserUpdated(latest);
      setAvatarFile(null);
    }

    if (trimmedName !== user.name) {
      const res = await apiUpdateProfile(trimmedName);
      if (!res.ok) {
        setSaving(false);
        setError(res.error);
        return;
      }
      latest = res.data.user;
      onUserUpdated(latest);
    }

    setDisplayName(latest.name);
    setSaving(false);
    setSaved(true);
  };

  if (guest) {
    return (
      <div className="settings-section">
        <div className="settings-notice">
          <AlertCircle size={18} />
          <span>Convidados não podem personalizar o perfil. Crie uma conta para trocar o avatar e o nome.</span>
        </div>
      </div>
    );
  }

  const previewAvatar = avatarPreview ?? user.avatar;
  const previewName = trimmedName || user.name;

  return (
    <div className="settings-section">
      <div className="profile-layout">
        <div className="profile-form">
          <div className="settings-field">
            <span className="settings-label">Avatar</span>
            <div className="avatar-picker">
              <button
                type="button"
                className="avatar-picker-preview"
                onClick={() => fileInputRef.current?.click()}
                title="Escolher imagem"
              >
                <img src={previewAvatar} alt="Prévia do avatar" />
                <span className="avatar-picker-overlay">
                  <ImagePlus size={20} />
                </span>
              </button>
              <div className="avatar-picker-actions">
                <button type="button" className="settings-btn fit" onClick={() => fileInputRef.current?.click()}>
                  Alterar avatar
                </button>
                {avatarFile && (
                  <button type="button" className="link-btn" onClick={() => setAvatarFile(null)}>
                    Descartar imagem escolhida
                  </button>
                )}
                <span className="settings-help">PNG, JPG, GIF ou WebP, até 2 MB.</span>
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept={AVATAR_TYPES.join(',')}
                onChange={handleFileChange}
                hidden
              />
            </div>
          </div>

          <label className="settings-field">
            <span className="settings-label">Nome de exibição</span>
            <input
              className="settings-input"
              value={displayName}
              maxLength={MAX_DISPLAY_NAME_CHARS}
              onChange={(e) => {
                setDisplayName(e.target.value);
                setSaved(false);
              }}
            />
            <span className="settings-help">
              É assim que as pessoas veem você. Seu nome de usuário e sua tag não mudam.
            </span>
          </label>

          {error && (
            <div className="settings-feedback error">
              <AlertCircle size={16} />
              <span>{error}</span>
            </div>
          )}
          {saved && !dirty && (
            <div className="settings-feedback success">
              <CheckCircle2 size={16} />
              <span>Perfil salvo.</span>
            </div>
          )}
        </div>

        <div className="profile-preview">
          <span className="settings-label">Prévia</span>
          <div className="profile-card">
            <div className="profile-card-banner" />
            <div className="avatar-wrapper profile-card-avatar">
              <img src={previewAvatar} alt={previewName} className="avatar-img" />
              <div className={`status-dot ${user.status}`} />
            </div>
            <div className="profile-card-body">
              <span className="profile-card-name">{previewName}</span>
              <span className="profile-card-tag">{user.tag}</span>
              <div className="profile-card-divider" />
              <span className="profile-card-status">{user.customStatus || statusLabel(user.status)}</span>
            </div>
          </div>
        </div>
      </div>

      {dirty && (
        <div className={`unsaved-bar ${shake ? 'shake' : ''}`}>
          <span>Cuidado — você tem alterações que não foram salvas!</span>
          <div className="settings-actions">
            <button className="link-btn" onClick={reset} disabled={saving}>
              Redefinir
            </button>
            <button className="settings-btn success" onClick={save} disabled={saving}>
              {saving ? 'Salvando...' : 'Salvar alterações'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
