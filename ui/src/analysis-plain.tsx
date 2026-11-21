import React, { useEffect, useRef, useState } from 'react';
import type { AnalysisHistoryItem, AnalysisProvenance, AnalysisRun, AnalysisStatus, AnalysisTarget, Reply } from './project-api';

const labels = {
  notCalculated: 'Not calculated',
  current: 'Current',
  stale: 'Stale',
  sourceUnavailable: 'Source unavailable',
};

export type AnalysisPlainProps = AnalysisTarget & { revision: number; busy: boolean };

export function useAnalysis<T>(
  { projectId, targetId, revision, busy }: AnalysisPlainProps,
  readStatus: ((input: AnalysisTarget) => Promise<Reply<AnalysisStatus<T>>>) | undefined,
) {
  const [verification, setVerification] = useState<{ status: AnalysisStatus<T>; revision: number; check: number }>();
  const [refresh, setRefresh] = useState(0);
  const [running, setRunning] = useState(false);
  const [canceling, setCanceling] = useState(false);
  const [failure, setFailure] = useState('');
  const [statusError, setStatusError] = useState('');
  const [outcome, setOutcome] = useState<'Cancelled' | 'Failed'>();
  const [history, setHistory] = useState(false);
  const [selected, setSelected] = useState<T>();
  const operation = useRef<string>(undefined);
  const checked = verification?.status;
  const sourceChecked = verification?.revision === revision && verification.check === refresh;
  const state = checked?.state;
  const latest = checked?.latest;
  const ready = sourceChecked && !statusError && !busy && !running;

  useEffect(() => {
    let active = true;
    setStatusError('');
    void readStatus?.({ projectId, targetId }).then(reply => {
      if (!active) return;
      if (reply.ok) setVerification({ status: reply.value, revision, check: refresh });
      else setStatusError(reply.error.message);
    }).catch(() => { if (active) setStatusError('Analysis status is unavailable.'); });
    return () => { active = false; };
  }, [readStatus, projectId, targetId, revision, refresh]);

  useEffect(() => () => {
    if (operation.current) void window.forge?.project.cancelAnalysis({ projectId, operationId: operation.current }).catch(() => {});
  }, [projectId]);

  async function run(execute: (input: AnalysisRun) => Promise<Reply<T>>) {
    if (operation.current) return;
    const operationId = crypto.randomUUID();
    operation.current = operationId;
    setRunning(true);
    setFailure('');
    setOutcome(undefined);
    try {
      const reply = await execute({ projectId, targetId, baseRevision: revision, operationId });
      if (reply.ok) {
        setSelected(undefined);
      } else {
        setOutcome(reply.error.code === 'CANCELLED' ? 'Cancelled' : 'Failed');
        if (reply.error.code !== 'CANCELLED') setFailure(reply.error.message);
      }
    } catch {
      setOutcome('Failed');
      setFailure('Forge Core could not run the analysis.');
    } finally {
      operation.current = undefined;
      setRunning(false);
      setCanceling(false);
      setRefresh(previous => previous + 1);
    }
  }

  async function cancel() {
    if (!window.forge || !operation.current) return;
    const operationId = operation.current;
    setCanceling(true);
    try {
      const reply = await window.forge.project.cancelAnalysis({ projectId, operationId });
      if (operation.current === operationId && (!reply.ok || !reply.value)) setCanceling(false);
    } catch {
      if (operation.current === operationId) {
        setCanceling(false);
        setFailure('Forge Core could not receive the cancellation.');
      }
    }
  }

  function check() {
    setOutcome(undefined);
    setFailure('');
    setRefresh(previous => previous + 1);
  }

  return {
    checked, sourceChecked, ready, latest, refresh, running, canceling, history, selected, setSelected, run, cancel, check,
    result: selected ?? latest,
    status: running ? (canceling ? 'Cancelling…' : 'Calculating') : outcome ?? (state ? labels[state] : 'Checking source…'),
    lastSuccess: outcome && latest && state ? labels[state] : undefined,
    error: failure || statusError,
    canRun: !!(ready && checked && state !== 'sourceUnavailable' && !checked.message),
    toggleHistory: () => setHistory(previous => !previous),
  };
}

export function AnalysisActions<T>({ analysis, onRun, children }: {
  analysis: ReturnType<typeof useAnalysis<T>>; onRun: () => void; children?: React.ReactNode;
}) {
  const { checked, latest, status, error, lastSuccess, running, canceling, canRun, history, toggleHistory, cancel, check } = analysis;
  return <>
    <p role="status">{status}</p>
    {lastSuccess && <p>Last successful result · {lastSuccess}</p>}
    {checked?.message && <p>{checked.message}</p>}
    {checked?.state === 'sourceUnavailable' && <p>Checked <time dateTime={checked.checkedAt}>{new Date(checked.checkedAt).toLocaleString()}</time></p>}
    {error && <p role="alert">{error}</p>}
    <div className="file-actions">
      {children}
      <button className="primary" disabled={!canRun} onClick={onRun}>{latest ? 'Recalculate' : 'Calculate'}</button>
      {running && <button disabled={canceling} onClick={() => void cancel()}>Cancel analysis</button>}
      <button disabled={running} onClick={check}>Check source</button>
      {latest && <button aria-expanded={history} onClick={toggleHistory}>{history ? 'Hide history' : 'Result history'}</button>}
    </div>
  </>;
}

export function AnalysisHistory<T extends AnalysisProvenance>({
  projectId, targetId, label, selected, onSelect, read, describe,
}: AnalysisTarget & {
  label: string; selected?: string; onSelect: (summary?: T) => void;
  read?: (input: AnalysisTarget & { before?: number }) => Promise<Reply<AnalysisHistoryItem<T>[]>>;
  describe: (summary: T) => string;
}) {
  const [before, setBefore] = useState<number>();
  const [entries, setEntries] = useState<AnalysisHistoryItem<T>[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    setError('');
    void read?.({ projectId, targetId, before }).then(reply => {
      if (!active) return;
      if (reply.ok) setEntries(previous => before === undefined ? reply.value : [...previous, ...reply.value]);
      else setError(reply.error.message);
    }).catch(() => { if (active) setError('Result history is unavailable.'); });
    return () => { active = false; };
  }, [projectId, targetId, before, read]);
  const last = entries.at(-1)?.cursor;
  const canLoad = entries.length > 0 && entries.length % 30 === 0 && before !== last;
  return <section aria-label={label}>
    {selected && <button onClick={() => onSelect(undefined)}>Show latest result</button>}
    {error && <p role="alert">{error}</p>}
    <ul className="project-list">{entries.map(({ summary }) => <li key={summary.id}>
      <div><time dateTime={summary.calculatedAt}>{new Date(summary.calculatedAt).toLocaleString()}</time>
        <span> · Revision {summary.projectRevision} · {describe(summary)}</span></div>
      <button aria-pressed={summary.id === selected} onClick={() => onSelect(summary)}>View result</button>
    </li>)}</ul>
    {canLoad && <button onClick={() => setBefore(last)}>Load older results</button>}
  </section>;
}

export function ResultProvenance({ summary, children }: { summary: AnalysisProvenance; children?: React.ReactNode }) {
  return <details className="analysis-detail">
    <summary>Result provenance</summary>
    <dl className="analysis-provenance">
      <dt>Calculated</dt><dd><time dateTime={summary.calculatedAt}>{new Date(summary.calculatedAt).toLocaleString()}</time></dd>
      <dt>Algorithm</dt><dd>{summary.algorithm}</dd>
      {children}
      <dt>Project revision</dt><dd>{summary.projectRevision}</dd>
      <dt>Source node</dt><dd><code>{summary.source.nodeId}</code></dd>
      <dt>Link</dt><dd><code>{summary.source.linkId}</code></dd>
      <dt>Source revision</dt><dd><code>{summary.source.revision}</code></dd>
      <dt>Result SHA-256</dt><dd><code>{summary.resultDigest}</code></dd>
    </dl>
  </details>;
}
