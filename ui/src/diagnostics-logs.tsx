import { useEffect, useRef, useState } from 'react';
import { ArrowDownToLine } from 'lucide-react';
import type { LogsCursor, LogsHealth, LogsPage } from './project-api';

const time = new Intl.DateTimeFormat(undefined, {
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
});

export function DiagnosticsLogs({ health, busy }: { health: LogsHealth; busy: boolean }) {
  const api = window.forge?.project;
  const scroll = useRef<HTMLDivElement>(null);
  const shown = useRef<LogsPage | undefined>(undefined);
  const [before, setBefore] = useState<LogsCursor | null>(null);
  const [revision, refresh] = useState(0);
  const [page, setPage] = useState<LogsPage>();
  const [notice, setNotice] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(Boolean(api));
  const [exporting, setExporting] = useState(false);
  const [receipt, setReceipt] = useState<{ text: string; error?: true }>();

  useEffect(() => {
    if (!api) return;
    let current = true;
    let pending = false;
    setLoading(true);
    setNotice(false);
    async function read(replace = false) {
      if (!api || pending || document.hidden) return;
      pending = true;
      try {
        const answer = await api.logsPage(before);
        if (!current || document.hidden) return;
        if (!answer.ok) {
          setError(answer.error.message);
          return;
        }
        setError('');
        const next = answer.value;
        const old = shown.current;
        const displaced = Boolean(scroll.current?.scrollTop);
        if (!replace && old && displaced) {
          setNotice(next.rows[0]?.id !== old.rows[0]?.id);
          return;
        }
        if (!old || replace || old.rows[0]?.id !== next.rows[0]?.id ||
            old.rows.at(-1)?.id !== next.rows.at(-1)?.id ||
            old.recordingIssue !== next.recordingIssue || old.spaceLow !== next.spaceLow) {
          shown.current = next;
          setPage(next);
        }
      } catch {
        if (current) setError('Could not read Forge diagnostics.');
      } finally {
        pending = false;
        if (current) setLoading(false);
      }
    }
    void read(true);
    let awaitingVisible = document.hidden;
    const visible = () => {
      if (document.hidden) {
        awaitingVisible = true;
      } else if (awaitingVisible || !before) {
        void read(awaitingVisible && !shown.current);
        awaitingVisible = false;
      }
    };
    const timer = window.setInterval(() => { if (!before) void read(); }, 2500);
    document.addEventListener('visibilitychange', visible);
    return () => {
      current = false;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [api, before, revision]);

  function request(cursor: LogsCursor | null) {
    scroll.current?.scrollTo(0, 0);
    setBefore(cursor);
    refresh(value => value + 1);
  }

  async function archive() {
    if (!api || exporting) return;
    setExporting(true);
    setReceipt(undefined);
    try {
      const reply = await api.exportLogs();
      if (!reply.ok) {
        const reference = reply.error.correlationId ? ' Reference ' + reply.error.correlationId + '.' : '';
        setReceipt({ text: reply.error.message + reference, error: true });
      } else if (reply.value) {
        setReceipt({ text: 'Diagnostics archive saved.' });
        if (!before && !scroll.current?.scrollTop) refresh(value => value + 1);
      }
    } catch {
      setReceipt({ text: 'Could not confirm the diagnostics export.', error: true });
    } finally {
      setExporting(false);
    }
  }

  return <section className="panel diagnostics-panel" aria-labelledby="diagnostics-heading">
    <h2 id="diagnostics-heading">Local diagnostics</h2>
    <div className="file-actions">
      <button disabled={!api || exporting || busy} onClick={() => { void archive(); }}>
        <ArrowDownToLine size={15} aria-hidden /> {exporting ? 'Saving archive…' : 'Download archived logs'}
      </button>
      {before && <button disabled={loading} onClick={() => request(null)}>Latest events</button>}
      {notice && <button onClick={() => request(null)}>Show new events</button>}
    </div>
    {(health.recordingIssue || page?.recordingIssue) && <p role="alert">Some diagnostics could not be recorded during this session.</p>}
    {health.spaceLow && <p role="alert">The diagnostics drive has less than 64 MiB free.</p>}
    {receipt && <p role={receipt.error ? 'alert' : 'status'}>{receipt.text}</p>}
    {!api && <p>Diagnostics are available in the desktop app.</p>}
    {loading && <p role="status">Loading diagnostics…</p>}
    {error && <p role="alert">{error} <button onClick={() => request(before)}>Retry</button></p>}
    {!loading && !error && page?.rows.length === 0 && <p>No retained events.</p>}
    {Boolean(page?.rows.length) && <div ref={scroll} className="diagnostics-scroll" aria-label="Retained diagnostics" tabIndex={0}>
      <table className="diagnostics-table">
        <thead><tr><th scope="col">Outcome</th><th scope="col">Action</th><th scope="col">Target</th><th scope="col">Actor</th><th scope="col">Local time</th></tr></thead>
        <tbody>{page?.rows.map(row => <tr key={row.id}>
          <td><span data-outcome={row.outcome}>{row.outcome}</span></td>
          <td><strong>{row.summary}</strong>{row.error && <small title={row.correlationId}>{row.error.code}</small>}</td>
          <td title={row.targetId ?? undefined}>{row.target}{row.targetId ? ' ' + row.targetId.slice(0, 8) : ''}</td>
          <td>{row.actor}</td>
          <td><time dateTime={new Date(row.occurredAt).toISOString()}>{time.format(row.occurredAt)}</time></td>
        </tr>)}</tbody>
      </table>
    </div>}
    {page?.older && <button disabled={loading} onClick={() => request(page.older)}>Load older events</button>}
    <details><summary>Retention</summary>
      <p>Audit events are kept for up to 30 days, 10,000 events and 64 MiB of retained payload. Each event is limited to 8 KiB. Forge keeps up to six runtime files of 5 MiB each, with a 64 MiB budget for the diagnostics directory. Each page shows up to 200 events.</p>
    </details>
  </section>;
}
