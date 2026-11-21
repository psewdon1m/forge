import { useEffect, useState } from 'react';
import type {
  DatasetChange, DatasetDelimiter, DatasetFile, DatasetKind, DatasetOptions, DatasetPage,
  DatasetPreview, DatasetQuery,
} from './project-api';

const pageSize = 25;
const inputLimit = 512 * 1024;
const kinds: { id: DatasetKind; label: string }[] = [
  { id: 'string', label: 'String' }, { id: 'number', label: 'Number' },
  { id: 'boolean', label: 'Boolean' }, { id: 'date', label: 'Date' },
];
type Save = (change: DatasetChange, done: () => void) => void;

function DatasetImport({ projectId, file, replacing, busy, onSave, onCancel }: {
  projectId: string; file: DatasetFile; replacing: boolean; busy: boolean; onSave: Save; onCancel: () => void;
}) {
  const [options, setOptions] = useState<DatasetOptions>({ delimiter: file.delimiter, header: true, types: [] });
  const [result, setResult] = useState<{ options: DatasetOptions; preview?: DatasetPreview; error?: string }>();
  const api = window.forge?.project;

  useEffect(() => {
    if (!api) return;
    let active = true;
    api.datasetPreview({ projectId, text: file.text, options }).then(reply => {
      if (active) setResult(reply.ok ? { options, preview: reply.value } : { options, error: reply.error.message });
    }).catch(() => {
      if (active) setResult({ options, error: 'Could not preview this table.' });
    });
    return () => { active = false; };
  }, [api, file, options, projectId]);

  const current = result?.options === options;
  const preview = result?.preview;
  const allowed = Boolean(current && preview && preview.issueCount === 0 && preview.columns.length > 0);
  return <section className="dataset-import" aria-label="Dataset import preview" aria-busy={!current}>
    <h3>{file.name}</h3>
    <div className="file-actions dataset-controls">
      <label>Delimiter <select value={options.delimiter} disabled={busy} onChange={event =>
        setOptions({ ...options, delimiter: event.target.value as DatasetDelimiter, types: [] })}>
        <option value="comma">Comma (CSV)</option><option value="tab">Tab (TSV)</option>
      </select></label>
      <label><input type="checkbox" checked={options.header} disabled={busy} onChange={event =>
        setOptions({ ...options, header: event.target.checked, types: [] })} /> First row contains headers</label>
    </div>
    {!current && <p role="status">Checking table…</p>}
    {current && result?.error && <p role="alert">{result.error}</p>}
    {current && preview && <>
      <p>{preview.total} data rows{preview.rows.length < preview.total && ' · First ' + preview.rows.length + ' shown'}</p>
      {preview.columns.length > 0 && <div className="dataset-scroll" tabIndex={0} aria-label="Preview columns and values">
        <table className="dataset-table">
          <thead><tr><th scope="col">Source row</th>{preview.columns.map((column, index) =>
            <th scope="col" key={index}>{column.name}
              <label className="dataset-kind"><select value={column.kind} disabled={busy}
                aria-label={'Type for column ' + (index + 1) + ' ' + column.name}
                onChange={event => {
                  const kind = event.target.value as DatasetKind;
                  setOptions({ ...options, types: preview.columns.map((item, i) => i === index ? kind : item.kind) });
                }}>{kinds.map(kind => <option value={kind.id} key={kind.id}>{kind.label}</option>)}</select></label>
            </th>)}</tr></thead>
          <tbody>{preview.rows.map(row => <tr key={row.line}>
            <th scope="row">{row.line}</th>{row.cells.map((cell, index) => <td key={index}>{cell || '—'}</td>)}
          </tr>)}</tbody>
        </table>
      </div>}
      {preview.issueCount > 0 && <div role="alert">
        <p>{preview.issueCount} {preview.issueCount === 1 ? 'problem' : 'problems'} to resolve</p>
        <ul>{preview.issues.map((issue, index) => <li key={index}>
          {issue.line > 0 && ('Row ' + issue.line + (issue.column ? ', column ' + issue.column : '') + '. ')}{issue.message}
        </li>)}</ul>
      </div>}
    </>}
    <div className="file-actions">
      <button className="primary" disabled={busy || !allowed} onClick={() =>
        onSave({ kind: 'importDataset', text: file.text, options }, onCancel)}>{replacing ? 'Replace table' : 'Import table'}</button>
      <button disabled={busy} onClick={onCancel}>Cancel preview</button>
    </div>
  </section>;
}

export function DatasetPlain({ projectId, nodeId, revision, busy, onSave, onDirty }: {
  projectId: string; nodeId: string; revision: number; busy: boolean; onSave: Save; onDirty: (dirty: boolean) => void;
}) {
  const api = window.forge?.project;
  const [source, setSource] = useState<{ id: string; file: DatasetFile }>();
  const [paste, setPaste] = useState<string>();
  const [page, setPage] = useState<DatasetPage>();
  const [query, setQuery] = useState<DatasetQuery>({ offset: 0, limit: pageSize });
  const [filter, setFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [fileBusy, setFileBusy] = useState(false);
  const [pageError, setPageError] = useState('');
  const [notice, setNotice] = useState<{ text: string; error?: true }>();
  const [draft, setDraft] = useState<{ rowId: string; ordinal: number; column: number; raw: string }>();

  useEffect(() => {
    onDirty(Boolean(draft || source) || paste !== undefined);
  }, [draft, onDirty, paste, source]);

  useEffect(() => () => onDirty(false), [onDirty]);

  useEffect(() => {
    if (!api) return;
    let active = true;
    setLoading(true);
    setPageError('');
    api.datasetPage({ projectId, nodeId, query }).then(reply => {
      if (!active) return;
      if (reply.ok) setPage(reply.value);
      else setPageError(reply.error.message);
    }).catch(() => { if (active) setPageError('Could not read this Dataset.'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [api, nodeId, projectId, query, revision]);

  function resetPage() {
    setQuery({ offset: 0, limit: pageSize, filter: query.filter, sort: query.sort });
  }

  async function readFile() {
    if (!api) return;
    setFileBusy(true);
    setNotice(undefined);
    try {
      const reply = await api.datasetRead({ projectId });
      if (!reply.ok) setNotice({ error: true, text: reply.error.message });
      else if (reply.value) {
        setSource({ file: reply.value, id: crypto.randomUUID() }); setPaste(undefined);
      }
    } catch { setNotice({ error: true, text: 'Could not read the selected table.' }); }
    finally { setFileBusy(false); }
  }

  async function exportFile(delimiter: DatasetDelimiter) {
    if (!api || !page) return;
    setFileBusy(true);
    setNotice(undefined);
    try {
      const reply = await api.datasetExport({ projectId, nodeId, sourceRevision: page.sourceRevision, delimiter });
      if (!reply.ok) setNotice({ error: true, text: reply.error.message });
      else if (reply.value) setNotice({ text: delimiter === 'comma' ? 'CSV saved in safe-text mode.' : 'TSV saved in safe-text mode.' });
    } catch { setNotice({ error: true, text: 'Could not export the table.' }); }
    finally { setFileBusy(false); }
  }

  const locked = busy || fileBusy || !api;
  const tableReady = Boolean(page?.columns.length && !loading && !pageError);
  const selectDraft = (row: DatasetPage['rows'][number], column: number) => {
    setDraft({ rowId: row.id, ordinal: row.ordinal, column, raw: row.cells[column].raw });
  };
  return <section className="panel dataset-panel" aria-label="Dataset table">
    <div className="file-actions">
      <button disabled={locked || Boolean(draft)} onClick={() => { void readFile(); }}>Open CSV or TSV</button>
      <button disabled={locked || Boolean(draft)} onClick={() => { setPaste(''); setSource(undefined); setNotice(undefined); }}>Paste table</button>
      <button disabled={locked || !tableReady} onClick={() => { void exportFile('comma'); }}>Export CSV</button>
      <button disabled={locked || !tableReady} onClick={() => { void exportFile('tab'); }}>Export TSV</button>
    </div>
    {notice && <p role={notice.error ? 'alert' : 'status'}>{notice.text}</p>}
    {paste !== undefined && <form className="dataset-import" onSubmit={event => {
      event.preventDefault();
      if (!paste || locked) return;
      setSource({ file: { name: 'Pasted table', text: paste, delimiter: 'tab' }, id: crypto.randomUUID() });
      setPaste(undefined);
    }}>
      <label>Tabular text<textarea value={paste} onChange={event => {
        const text = event.currentTarget.value;
        if (new TextEncoder().encode(text).length > inputLimit) {
          setNotice({ error: true, text: 'Pasted tables are limited to 512 KiB.' });
        } else {
          setPaste(text);
          setNotice(undefined);
        }
      }} /></label>
      <div className="file-actions">
        <button disabled={locked || !paste}>Preview pasted table</button>
        <button type="button" onClick={() => setPaste(undefined)}>Cancel paste</button>
      </div>
    </form>}
    {source && <DatasetImport key={source.id} projectId={projectId} file={source.file}
      replacing={Boolean(page?.columns.length)} busy={locked}
      onCancel={() => setSource(undefined)}
      onSave={(change, done) => onSave(change, () => {
        setFilter(''); setQuery({ offset: 0, limit: pageSize }); done();
      })} />}
    {loading && <p role="status">Loading rows…</p>}
    {pageError && <p role="alert">{pageError} <button onClick={resetPage}>Reload rows</button></p>}
    {tableReady && page && <>
      <form className="file-actions dataset-controls" onSubmit={event => {
        event.preventDefault(); setQuery({ offset: 0, limit: pageSize, filter, sort: query.sort });
      }}>
        <label>Filter rows <input value={filter} maxLength={240} onChange={event => setFilter(event.currentTarget.value)} /></label>
        <button disabled={locked || Boolean(draft)}>Apply filter</button>
        {query.filter && <button type="button" onClick={() => {
          setFilter(''); setQuery({ offset: 0, limit: pageSize, sort: query.sort });
        }}>Clear filter</button>}
        {query.sort && <button type="button" onClick={() => setQuery({ offset: 0, limit: pageSize, filter: query.filter })}>Clear sort</button>}
      </form>
      <div className="dataset-scroll" tabIndex={0} aria-label="Dataset rows">
        <table className="dataset-table">
          <thead><tr><th scope="col">Row</th>{page.columns.map((column, index) => <th scope="col" key={index}
            aria-sort={query.sort?.column === index ? (query.sort.descending ? 'descending' : 'ascending') : undefined}>
            <button disabled={locked || Boolean(draft)} aria-label={'Sort column ' + (index + 1) + ' ' + column.name}
              onClick={() => setQuery({ offset: 0, limit: pageSize, filter: query.filter,
                sort: { column: index, descending: query.sort?.column === index && !query.sort.descending } })}>
              {column.name}{query.sort?.column === index ? (query.sort.descending ? ' ↓' : ' ↑') : ''}
            </button>
            <small>{kinds.find(kind => kind.id === column.kind)?.label}</small>
          </th>)}</tr></thead>
          <tbody>{page.rows.map(row => <tr key={row.id}><th scope="row">{row.ordinal}</th>{row.cells.map((cell, index) =>
            <td key={index}><button disabled={locked || Boolean(source) || Boolean(draft)}
              aria-label={'Edit row ' + row.ordinal + ' column ' + (index + 1) + ' ' + page.columns[index].name}
              onClick={() => selectDraft(row, index)}>{cell.raw || '—'}</button></td>)}</tr>)}</tbody>
        </table>
      </div>
      <div className="file-actions">
        <button disabled={locked || !query.offset || Boolean(draft)} onClick={() => setQuery({
          ...query, sourceRevision: page.sourceRevision, offset: Math.max(0, query.offset - pageSize),
        })}>Previous rows</button>
        <span>{page.total ? (query.offset + 1) + '–' + (query.offset + page.rows.length) + ' of ' + page.total : 'No matching rows'}</span>
        <button disabled={locked || page.nextOffset === null || Boolean(draft)} onClick={() => {
          if (page.nextOffset !== null) setQuery({ ...query, sourceRevision: page.sourceRevision, offset: page.nextOffset });
        }}>Next rows</button>
      </div>
    </>}
    {draft && <form className="dataset-import" onSubmit={event => {
      event.preventDefault();
      onSave({ kind: 'editDatasetCell', rowId: draft.rowId, column: draft.column, raw: draft.raw }, () => {
        setDraft(undefined); resetPage();
      });
    }}>
      <label>{'Value for row ' + draft.ordinal + ', column ' + (draft.column + 1)}
        <textarea autoFocus value={draft.raw} onChange={event => setDraft({ ...draft, raw: event.currentTarget.value })} /></label>
      <div className="file-actions">
        <button className="primary" disabled={locked || new TextEncoder().encode(draft.raw).length > 4096}>Save cell</button>
        <button type="button" disabled={busy} onClick={() => setDraft(undefined)}>Cancel edit</button>
      </div>
    </form>}
    {!loading && !tableReady && !pageError && !source && paste === undefined && <p>Open a file or paste tabular text to add rows.</p>}
  </section>;
}
