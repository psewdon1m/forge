import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

const wideQuery = '(min-width: 1120px)';

export function useWidePlainLayout() {
  const [wide, setWide] = useState(() => window.matchMedia(wideQuery).matches);
  useEffect(() => {
    const query = window.matchMedia(wideQuery);
    const update = () => setWide(query.matches);
    query.addEventListener('change', update);
    update();
    return () => query.removeEventListener('change', update);
  }, []);
  return wide;
}

export type PlainFocusRequest = { id: string };

export function PlainPane({ id, title, kind, site, visible, close, focus, assetVersion,
  onActivate, onDirty, children }: {
  id: string;
  title: string;
  kind: string;
  site: boolean;
  visible: boolean;
  close?: () => void;
  focus?: PlainFocusRequest;
  assetVersion?: string;
  onActivate: (id: string) => void;
  onDirty: (id: string, dirty: boolean) => void;
  children: (reportDirty: (dirty: boolean) => void) => ReactNode;
}) {
  const headingId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const handledFocus = useRef<{ request: PlainFocusRequest; assetVersion?: string } | undefined>(undefined);
  const reportDirty = useCallback((dirty: boolean) => onDirty(id, dirty), [id, onDirty]);
  useLayoutEffect(() => {
    if (visible && focus?.id === id && (handledFocus.current?.request !== focus || handledFocus.current.assetVersion !== assetVersion)) {
      handledFocus.current = { request: focus, assetVersion };
      heading.current?.focus({ preventScroll: true });
    }
  }, [assetVersion, focus, id, visible]);
  useEffect(() => () => reportDirty(false), [reportDirty]);

  return <section className={site ? 'plain site-shell' : 'plain'} aria-labelledby={headingId} hidden={!visible}
    onFocusCapture={() => onActivate(id)} onPointerDownCapture={() => onActivate(id)}>
    <div className="plain-caption"><div className="eyebrow">{kind}</div>
      {close && <button type="button" aria-label={'Close ' + title} onClick={close}>Close panel</button>}
    </div>
    <h2 id={headingId} ref={heading} tabIndex={-1}>{title}</h2>
    {children(reportDirty)}
  </section>;
}

export function NotePlain({ text, busy, onSave, onDiscard, onDirty }: {
  text: string; busy: boolean; onSave: (text: string) => void; onDiscard: () => void; onDirty: (dirty: boolean) => void;
}) {
  const [draft, setDraft] = useState(text);
  const dirty = draft !== text;
  useEffect(() => { onDirty(dirty); }, [dirty, onDirty]);
  return <div className="note-editor">
    <label>Note text<textarea value={draft} onChange={event => setDraft(event.currentTarget.value)} /></label>
    <button className="primary" disabled={busy || !dirty} onClick={() => onSave(draft)}>Save note</button>
    {dirty && <button disabled={busy} onClick={() => { setDraft(text); onDiscard(); }}>Discard changes</button>}
  </div>;
}
