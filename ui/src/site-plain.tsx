import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { SiteBounds, SiteCommand, SiteData, SiteReference, SiteState } from './project-api';

type Props = {
  projectId: string;
  nodeId: string;
  saved: SiteReference | null;
  busy: boolean;
  visible: boolean;
  onDirty: (value: boolean) => void;
  onSave: (data: SiteData, finished: () => void) => void;
};

function clippedBounds(host: HTMLElement): SiteBounds | null {
  const stage = host.getBoundingClientRect();
  const container = host.closest('.site-shell')?.getBoundingClientRect();
  if (!container) return null;
  const x = Math.ceil(Math.max(0, container.left, stage.left + 1));
  const y = Math.ceil(Math.max(0, container.top, stage.top + 1));
  const width = Math.floor(Math.min(window.innerWidth, container.right, stage.right - 1)) - x;
  const height = Math.floor(Math.min(window.innerHeight, container.bottom, stage.bottom - 1)) - y;
  return width > 0 && height > 0 ? { x, y, width, height } : null;
}

export default function SitePlain({ projectId, nodeId, saved, busy, visible, onDirty, onSave }: Props) {
  const api = window.forge?.project;
  const [lease] = useState(() => crypto.randomUUID());
  const [connected, setConnected] = useState(false);
  const [state, setState] = useState<SiteState>();
  const [address, setAddress] = useState(saved?.url ?? '');
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<SiteReference>();
  const [notice, setNotice] = useState('');
  const stage = useRef<HTMLDivElement>(null);
  const lastAddress = useRef(saved?.url ?? '');
  const lastBounds = useRef('');

  useEffect(() => {
    if (!api) return;
    let mounted = true;
    const unsubscribe = api.onSiteState(event => {
      if (!mounted || event.lease !== lease) return;
      setState(event.state);
      const next = event.state.address;
      if (next && next !== lastAddress.current) {
        lastAddress.current = next;
        setAddress(next);
      }
      if (!next) lastAddress.current = '';
    });
    void api.siteAttach({ projectId, nodeId, lease }).then(reply => {
      if (!mounted) return;
      if (reply.ok) setConnected(true);
      else setError(reply.error.message);
    }).catch(() => { if (mounted) setError('The Site browser could not open.'); });
    return () => {
      mounted = false;
      unsubscribe();
      void api.siteDetach(lease).catch(() => {});
    };
  }, [api, lease, nodeId, projectId]);

  useLayoutEffect(() => {
    const host = stage.current;
    if (!api || !host || !connected) return;
    const publishBounds = () => {
      const bounds = visible ? clippedBounds(host) : null;
      const serialized = JSON.stringify(bounds);
      if (serialized === lastBounds.current) return;
      lastBounds.current = serialized;
      void api?.siteBounds({ lease, bounds }).catch(() => {});
    };
    const resize = new ResizeObserver(publishBounds);
    resize.observe(host);
    const shell = host.closest('.site-shell');
    if (shell) resize.observe(shell);
    window.addEventListener('scroll', publishBounds, true);
    window.addEventListener('resize', publishBounds);
    publishBounds();
    return () => {
      resize.disconnect();
      window.removeEventListener('scroll', publishBounds, true);
      window.removeEventListener('resize', publishBounds);
    };
  }, [api, lease, connected, visible]);

  useEffect(() => { onDirty(Boolean(preview)); }, [preview, onDirty]);
  useEffect(() => () => onDirty(false), [onDirty]);

  async function run(command: SiteCommand) {
    if (!api || !connected) return;
    setError('');
    setNotice('');
    try {
      const reply = await api.siteCommand({ lease, ...command });
      if (!reply.ok) setError(reply.error.message);
      else if (typeof reply.value !== 'boolean') {
        const page = reply.value;
        setPreview({ ...page, quote: saved?.url === page.url ? saved.quote : '' });
      }
    } catch {
      setError('The Site browser could not complete the action.');
    }
  }

  const locked = !connected || Boolean(state?.clearing || state?.loginOpen) || busy;
  const download = state?.download;
  const displayStatus = error || state?.status || 'Opening Site…';
  return <div className="site-panel" aria-label="Site controls">
    <div className="site-toolbar">
      <button disabled={locked || !state?.canBack} onClick={() => { void run({ action: 'back' }); }}>Back</button>
      <button disabled={locked || !state?.canForward} onClick={() => { void run({ action: 'forward' }); }}>Forward</button>
      <button disabled={locked || !state?.hasPage} onClick={() => { void run({ action: 'reload' }); }}>Reload</button>
      <form className="site-location" onSubmit={event => {
        event.preventDefault();
        void run({ action: 'go', address });
      }}>
        <input type="text" aria-label="HTTPS address" placeholder="https://example.com/" spellCheck={false}
          autoComplete="off" value={address} disabled={locked}
          maxLength={4096} onChange={event => setAddress(event.currentTarget.value)} />
        <button className="primary" disabled={locked || !address.trim()}>Go</button>
      </form>
      <button disabled={locked || !state?.address || state.level !== 'ready' || Boolean(preview)}
        onClick={() => { void run({ action: 'reference' }); }}>Capture current page</button>
      <button disabled={locked || Boolean(preview)} onClick={() => { void run({ action: 'clear' }); }}>Clear site data</button>
    </div>
    <p className="site-status" role={error || state?.level === 'error' ? 'alert' : 'status'}>
      {displayStatus}
    </p>
    {state?.loginOrigin && <div className="site-decision">
      <p>Open a sign-in window for <strong>{state.loginOrigin}</strong>?</p>
      <button disabled={locked} onClick={() => { void run({ action: 'login' }); }}>Open sign-in window</button>
      <button disabled={locked} onClick={() => { void run({ action: 'discard-login' }); }}>Dismiss window request</button>
    </div>}
    {download && <div className="site-decision">
      <p role={download.phase === 'error' ? 'alert' : 'status'}>{download.message}
        {download.name && <> <strong>{download.name}</strong> · {new Intl.NumberFormat().format(download.bytes ?? 0)} bytes.</>}
      </p>
      {download.phase === 'approval' && <button disabled={locked} onClick={() => { void run({ action: 'save-download' }); }}>Save download</button>}
      {(download.phase === 'approval' || download.phase === 'saving') &&
        <button disabled={locked} onClick={() => { void run({ action: 'cancel-download' }); }}>Cancel download</button>}
      {['saved', 'canceled', 'error'].includes(download.phase) &&
        <button disabled={locked} onClick={() => { void run({ action: 'dismiss-download' }); }}>Dismiss download status</button>}
    </div>}
    {preview && <section className="site-reference" aria-label="Reference preview">
      <div className="site-reference-fields">
        <div><strong>{preview.title}</strong><code>{preview.url}</code></div>
        <label>Manual quote<textarea value={preview.quote} disabled={busy} rows={2} onChange={event => {
          const quote = event.currentTarget.value;
          if (new TextEncoder().encode(quote).length <= 16 * 1024) setPreview({ ...preview, quote });
          else setError('A quote can contain up to 16 KiB of UTF-8 text.');
        }} /></label>
      </div>
      <div className="file-actions">
        <button className="primary" disabled={busy} onClick={() => {
          onSave({ reference: preview }, () => {
            setPreview(undefined);
            setError('');
            setNotice('Site reference saved.');
          });
        }}>Save reference</button>
        <button disabled={busy} onClick={() => { setPreview(undefined); setError(''); }}>Discard reference draft</button>
      </div>
    </section>}
    {notice && <p className="site-status" role="status">{notice}</p>}
    <div className="site-stage" aria-label="Website view" role="region" ref={stage} />
    {saved && <details className="site-saved-reference">
      <summary>Saved reference</summary>
      <strong>{saved.title}</strong>
      <code>{saved.url}</code>
      {saved.quote && <blockquote>{saved.quote}</blockquote>}
    </details>}
  </div>;
}
