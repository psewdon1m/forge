import { useEffect, useRef, useState } from 'react';
import type { ChecklistData, ChecklistGroup, ChecklistItem } from './project-api';

export const checklistType = 'forge.checklist';

export function checklistSummary(items: ChecklistItem[]) {
  return items.filter(item => item.done).length + ' of ' + items.length + ' complete';
}

export function Checklist({ items, groups, busy, onChange }: {
  items: ChecklistItem[];
  groups: ChecklistGroup[];
  busy: boolean;
  onChange: (data: ChecklistData, afterSave?: () => void) => void;
}) {
  const [label, setLabel] = useState('');
  const [groupName, setGroupName] = useState('');
  const taskRows = useRef(new Map<string, HTMLLIElement>());
  const restoreFocus = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (!busy && restoreFocus.current) {
      taskRows.current.get(restoreFocus.current)?.focus();
      restoreFocus.current = undefined;
    }
  }, [items, busy]);

  function move(task: ChecklistItem, peers: ChecklistItem[], index: number, step: -1 | 1) {
    const neighbor = peers[index + step];
    if (busy || !neighbor) return;
    const moved = [...items];
    const from = moved.findIndex(item => item.id === task.id);
    const to = moved.findIndex(item => item.id === neighbor.id);
    [moved[from], moved[to]] = [moved[to], moved[from]];
    onChange({ groups, items: moved }, () => { restoreFocus.current = task.id; });
  }

  function tasks(groupId?: string) {
    const peers = items.filter(item => item.groupId === groupId);
    if (peers.length === 0) return null;
    return <ul className="project-list checklist-list">
      {peers.map((item, index) => <li key={item.id} tabIndex={0} ref={node => {
        if (node) taskRows.current.set(item.id, node);
        else taskRows.current.delete(item.id);
      }} onKeyDown={event => {
        if (!event.altKey || event.target instanceof HTMLSelectElement) return;
        const step = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0;
        if (step) {
          event.preventDefault();
          move(item, peers, index, step);
        }
      }}>
        <div>
          <label>
            <input type="checkbox" checked={item.done} disabled={busy} onChange={event => {
              const done = event.currentTarget.checked;
              onChange({ groups, items: items.map(task => task.id === item.id ? { ...task, done } : task) });
            }} />
            {item.label}
          </label>
          {item.done && <small className="checklist-completion">
            {item.completion
              ? <>Completed <time dateTime={item.completion.occurredAt}>{new Date(item.completion.occurredAt).toLocaleString()}</time> · revision {item.completion.revision}</>
              : 'Completed · time unavailable'}
          </small>}
        </div>
        <div className="file-actions">
          {groups.length > 0 && <select aria-label={'Group for ' + item.label} value={item.groupId ?? ''} disabled={busy}
            onChange={event => {
              const groupId = event.currentTarget.value || undefined;
              onChange({ groups, items: items.map(task => task.id === item.id ? { ...task, groupId } : task) },
                () => { restoreFocus.current = item.id; });
            }}>
            <option value="">Ungrouped</option>
            {groups.map(group => <option key={group.id} value={group.id}>{group.label}</option>)}
          </select>}
          <button disabled={busy || index === 0} onClick={() => move(item, peers, index, -1)} aria-label={'Move up ' + item.label}>Up</button>
          <button disabled={busy || index + 1 === peers.length} onClick={() => move(item, peers, index, 1)} aria-label={'Move down ' + item.label}>Down</button>
          <button disabled={busy} onClick={() => onChange({ groups, items: items.filter(task => task.id !== item.id) })} aria-label={'Remove ' + item.label}>Remove</button>
        </div>
      </li>)}
    </ul>;
  }

  return <section className="panel checklist" aria-label="Checklist tasks">
    <p>{checklistSummary(items)}</p>
    {groups.length > 0 && items.some(item => !item.groupId) && <h3>Ungrouped</h3>}
    {tasks()}
    {groups.map(group => <section key={group.id} className="checklist-group" aria-label={group.label}>
      <div className="checklist-group-heading">
        <h3>{group.label}</h3>
        <button disabled={busy} aria-label={'Remove group ' + group.label} onClick={() => {
          onChange({
            groups: groups.filter(other => other.id !== group.id),
            items: items.map(item => item.groupId === group.id ? { ...item, groupId: undefined } : item),
          });
        }}>Remove group</button>
      </div>
      {tasks(group.id)}
    </section>)}
    <form onSubmit={event => {
      event.preventDefault();
      if (!label.trim() || items.length >= 100 || busy) return;
      onChange({ groups, items: [...items, { id: crypto.randomUUID(), label: label.trim(), done: false }] }, () => setLabel(''));
    }}>
      <label>New task<input value={label} maxLength={240} onChange={event => setLabel(event.currentTarget.value)} /></label>
      <button className="primary" disabled={busy || !label.trim() || items.length >= 100}>Add task</button>
    </form>
    <form onSubmit={event => {
      event.preventDefault();
      if (!groupName.trim() || groups.length >= 20 || busy) return;
      onChange({ items, groups: [...groups, { id: crypto.randomUUID(), label: groupName.trim() }] }, () => setGroupName(''));
    }}>
      <label>New group<input value={groupName} maxLength={240} onChange={event => setGroupName(event.currentTarget.value)} /></label>
      <button disabled={busy || !groupName.trim() || groups.length >= 20}>Add group</button>
    </form>
  </section>;
}
