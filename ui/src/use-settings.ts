import { useCallback, useEffect, useState } from 'react';
import type { SettingsState } from './project-api';

export function useSettings() {
  const api = window.forge?.project;
  const [state, setState] = useState<SettingsState>();
  const [busy, setBusy] = useState(Boolean(api));
  const [message, setMessage] = useState('');
  const [previewSnap, setPreviewSnap] = useState(true);

  function adopt(value: SettingsState) {
    setState(current => !current || value.revision >= current.revision ? value : current);
    setMessage('');
  }

  const refresh = useCallback(async () => {
    if (!api) return;
    setBusy(true);
    try {
      const reply = await api.readSettings();
      if (reply.ok) adopt(reply.value);
      else setMessage(reply.error.message);
    } catch {
      setMessage('Could not load application settings.');
    } finally {
      setBusy(false);
    }
  }, [api]);

  useEffect(() => { void refresh(); }, [refresh]);

  async function toggleSnap() {
    if (!api) {
      setPreviewSnap(value => !value);
      return;
    }
    if (!state || busy) return;
    const { revision, preferences } = state;
    setBusy(true);
    setMessage('');
    try {
      const reply = await api.saveSettings({ baseRevision: revision, snapToGrid: !preferences.snapToGrid });
      if (reply.ok) adopt(reply.value);
      else {
        if (reply.error.code === 'SETTINGS_CHANGED') await refresh();
        setMessage(reply.error.message);
      }
    } catch {
      setMessage('Could not confirm the settings change.');
    } finally {
      setBusy(false);
    }
  }

  return {
    snap: state?.preferences.snapToGrid ?? previewSnap,
    canToggle: !api || Boolean(state) && !busy,
    toggleSnap, message, refresh, adopt, busy,
  };
}
