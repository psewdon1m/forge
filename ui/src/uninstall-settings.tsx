import { useState } from 'react';

export function UninstallSettings({ busy }: { busy: boolean }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const forge = window.forge;
  if (!forge?.build.managed) return null;

  async function uninstall() {
    if (!forge) return;
    setError('');
    setPending(true);
    try {
      const reply = await forge.uninstall();
      if (!reply.ok) setError(reply.error.message);
    } catch {
      setError('Forge could not start the uninstaller.');
    } finally {
      setPending(false);
    }
  }

  return <section className="panel uninstall-settings" aria-labelledby="uninstall-heading">
    <h2 id="uninstall-heading">Uninstall</h2>
    <p>Remove Forge and its local settings, logs and shortcuts. Your projects and backups will stay where they are.</p>
    <button disabled={busy || pending} onClick={() => void uninstall()}>Uninstall Forge</button>
    {error && <p role="alert">{error}</p>}
  </section>;
}
