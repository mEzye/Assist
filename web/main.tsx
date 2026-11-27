import { isValidElement, useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { FormEvent, ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  Bell,
  CalendarDays,
  Check,
  ChevronDown,
  CircleHelp,
  Clock3,
  FileText,
  Layers3,
  LayoutGrid,
  Minus,
  LogOut,
  PanelLeftClose,
  Plus,
  Settings2,
  SquarePen,
  X,
} from 'lucide-react';
import { Timeline } from './Timeline';
import {
  ApiError,
  api,
  clockText,
  dateKey,
  localDate,
  timeValue,
} from './model';
import type { Board, Note, Session, Task, TaskDraft, Workspace } from './model';
import './style.css';

const dateLabel = new Intl.DateTimeFormat('uk', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});
const weekDay = new Intl.DateTimeFormat('uk', { weekday: 'long' });
const boardColors = ['#2865f6', '#8a61e5', '#178668', '#e48749'];
const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const widgetTitles = { timeline: 'Розклад дня', notes: 'Замітки' };
type WidgetId = keyof typeof widgetTitles;
type DialogType = 'task' | 'board' | 'settings' | null;

function Brand() {
  return (
    <div className="brand">
      <img src="/assist.svg" width="35" height="35" alt="" />
      <span>Assist</span>
    </div>
  );
}

function Modal({
  title,
  close,
  children,
}: {
  title: string;
  close: () => void;
  children: ReactNode;
}) {
  return (
    <div className="overlay" onClick={close}>
      <section
        className="modal panel"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === 'Escape') close();
        }}
      >
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="icon-button" aria-label="Закрити" onClick={close}>
            <X size={19} />
          </button>
        </div>
        {children}
      </section>
    </div>
  );
}

function TaskForm({
  boardId,
  date,
  task,
  google,
  save,
  remove,
}: {
  boardId: string;
  date: string;
  task: Task | null;
  google: boolean;
  save: (draft: TaskDraft) => void;
  remove: () => void;
}) {
  const [kind, setKind] = useState(
    task?.start == null ? 'day' : task.end === null ? 'point' : 'range',
  );
  const [error, setError] = useState('');
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const day = String(values.get('date') || '') || null;
    const start =
      kind === 'day' ? null : timeValue(String(values.get('start')));
    const end = kind === 'range' ? timeValue(String(values.get('end'))) : null;
    if (!day && start !== null)
      return setError('Вибери дату для завдання з часом.');
    if (start !== null && end !== null && end <= start)
      return setError('Кінець має бути після початку.');
    const title = String(values.get('title')).trim();
    if (!title) return setError('Введи назву завдання.');
    save({
      boardId,
      title,
      date: day,
      start,
      end,
      done: values.has('done'),
      remind: Boolean(
        start !== null &&
          !task?.googleId &&
          !values.has('google') &&
          values.has('remind'),
      ),
      google: values.has('google'),
    });
  }
  return (
    <form className="form" onSubmit={submit}>
      <label>
        Назва
        <input
          name="title"
          defaultValue={task?.title}
          maxLength={200}
          required
          autoFocus
          placeholder="Що потрібно зробити?"
        />
      </label>
      <div className="form-row">
        <label>
          Дата
          <input
            name="date"
            type="date"
            defaultValue={task ? task.date || '' : date}
          />
        </label>
        <label>
          Час
          <select
            value={kind}
            onChange={(event) => setKind(event.target.value)}
          >
            <option value="day">На весь день</option>
            <option value="range">Інтервал</option>
            <option value="point">Одна точка</option>
          </select>
        </label>
      </div>
      {kind !== 'day' && (
        <div className="form-row">
          <label>
            {kind === 'point' ? 'Час' : 'Початок'}
            <input
              name="start"
              type="time"
              required
              defaultValue={clockText(task?.start ?? 540)}
            />
          </label>
          {kind === 'range' && (
            <label>
              Кінець
              <input
                name="end"
                type="time"
                required
                defaultValue={clockText(task?.end ?? 600)}
              />
            </label>
          )}
        </div>
      )}
      {kind !== 'day' && !task?.googleId && (
        <label className="check-label">
          <input
            name="remind"
            type="checkbox"
            defaultChecked={task?.remind ?? kind === 'point'}
          />{' '}
          Браузерне нагадування
        </label>
      )}
      {google && !task && (
        <label className="check-label">
          <input type="checkbox" name="google" /> Додати до Google Tasks
        </label>
      )}
      {task?.googleId && (
        <p className="muted small">
          Для сповіщень встанови час у Google Tasks.
        </p>
      )}
      {task && (
        <label className="check-label">
          <input type="checkbox" name="done" defaultChecked={task.done} />{' '}
          Виконано
        </label>
      )}
      {error && <p className="form-error">{error}</p>}
      <div className="modal-actions">
        {task && (
          <button type="button" className="button danger" onClick={remove}>
            Видалити
          </button>
        )}
        <button className="button primary" type="submit">
          {task ? 'Зберегти' : 'Додати завдання'}
        </button>
      </div>
    </form>
  );
}

function App() {
  const [session, setSession] = useState<Session>();
  const [workspace, setWorkspace] = useState<Workspace>();
  const [boardId, setBoardId] = useState('');
  const [date, setDate] = useState(dateKey);
  const [selectedNote, setSelectedNote] = useState<Note>();
  const [editingNote, setEditingNote] = useState(false);
  const [conflictedNote, setConflictedNote] = useState<string>();
  const [allNotes, setAllNotes] = useState(false);
  const [dialog, setDialog] = useState<DialogType>(null);
  const [task, setTask] = useState<Task | null>(null);
  const [message, setMessage] = useState('');
  const [preview, setPreview] = useState<WidgetId>();
  const [boardsOpen, setBoardsOpen] = useState(false);
  const [googleLists, setGoogleLists] =
    useState<{ id: string; title: string }[]>();
  const [pairCode, setPairCode] = useState('');
  const [pushActive, setPushActive] = useState(false);
  const [focusMinute, setFocusMinute] = useState<{ minute: number }>();

  const report = useCallback(
    (error: unknown) =>
      setMessage(error instanceof Error ? error.message : String(error)),
    [],
  );
  const refresh = useCallback(async () => {
    const result = await api<Workspace>('/workspace');
    setWorkspace(result);
    setBoardId((current) =>
      result.boards.some((board) => board.id === current)
        ? current
        : result.boards[0]?.id || '',
    );
    return result;
  }, []);

  useEffect(() => {
    api<Session>('/session').then(setSession).catch(report);
    if ('serviceWorker' in navigator) {
      void navigator.serviceWorker
        .getRegistration('/')
        .then((registration) => registration?.pushManager.getSubscription())
        .then((subscription) => setPushActive(Boolean(subscription)))
        .catch(() => {});
    }
  }, [report]);
  useEffect(() => {
    if (!session?.user) return;
    refresh().catch(report);
    api('/preferences', 'PATCH', { timeZone: zone }).catch(() => {});
    const poll = window.setInterval(() => {
      if (!document.hidden) refresh().catch(report);
    }, 30000);
    return () => window.clearInterval(poll);
  }, [session, refresh, report]);
  useEffect(() => {
    if (!message) return;
    const timer = window.setTimeout(() => setMessage(''), 6500);
    return () => clearTimeout(timer);
  }, [message]);

  async function act(operation: () => Promise<unknown>) {
    try {
      await operation();
      await refresh();
      return true;
    } catch (error) {
      report(error);
      return false;
    }
  }

  const board = workspace?.boards.find((item) => item.id === boardId);
  const tasks =
    workspace?.tasks.filter((item) => item.boardId === boardId) ?? [];
  const notes =
    workspace?.notes.filter((item) => allNotes || item.boardId === boardId) ??
    [];
  const datedTasks = tasks.filter((item) => item.date === date);
  const completed = datedTasks.filter((item) => item.done).length;
  const collapsed = (board?.layout?.collapsed ?? []) as WidgetId[];

  function selectBoard(id: string) {
    if (id === boardId) return;
    setBoardId(id);
    setSelectedNote(undefined);
    setPreview(undefined);
  }
  function editTask(value: Task | null) {
    setTask(value);
    setDialog('task');
  }
  function toggleTask(value: Task) {
    void act(() => api('/tasks/' + value.id, 'PATCH', { done: !value.done }));
  }
  function setCollapsed(kind: WidgetId, hide: boolean) {
    if (!board) return;
    const layout = {
      ...board.layout,
      collapsed: hide
        ? [...new Set([...collapsed, kind])]
        : collapsed.filter((item) => item !== kind),
    };
    setWorkspace(
      (old) =>
        old && {
          ...old,
          boards: old.boards.map((item) =>
            item.id === board.id ? { ...item, layout } : item,
          ),
        },
    );
    setPreview(undefined);
    void act(() => api('/boards/' + board.id, 'PATCH', { layout }));
  }
  async function newNote() {
    try {
      const note = await api<Note>('/notes', 'POST', {
        boardId,
        title: 'Нова замітка',
        body: '',
      });
      setSelectedNote(note);
      setEditingNote(true);
      await refresh();
    } catch (error) {
      report(error);
    }
  }
  function focusTask(linked: Task) {
    selectBoard(linked.boardId);
    if (linked.date) setDate(linked.date);
    if (linked.start !== null) setFocusMinute({ minute: linked.start });
    if (
      workspace?.boards.find((item) => item.id === linked.boardId)?.layout
        ?.collapsed instanceof Array
    ) {
      const target = workspace.boards.find(
        (item) => item.id === linked.boardId,
      )!;
      const hidden = target.layout?.collapsed as string[];
      if (hidden.includes('timeline'))
        void act(() =>
          api('/boards/' + target.id, 'PATCH', {
            layout: {
              ...target.layout,
              collapsed: hidden.filter((item) => item !== 'timeline'),
            },
          }),
        );
    }
    setSelectedNote(undefined);
  }
  async function enablePush() {
    if (
      !session?.pushKey ||
      !('serviceWorker' in navigator) ||
      !('Notification' in window)
    )
      return report('Сповіщення недоступні на цьому пристрої.');
    try {
      if ((await Notification.requestPermission()) !== 'granted')
        return report('Дозволь сповіщення в налаштуваннях браузера.');
      await navigator.serviceWorker.register('/sw.js');
      const registration = await navigator.serviceWorker.ready;
      const key = session.pushKey.replace(/-/g, '+').replace(/_/g, '/');
      const applicationServerKey = Uint8Array.from(atob(key), (char) =>
        char.charCodeAt(0),
      );
      const subscription =
        (await registration.pushManager.getSubscription()) ||
        (await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey,
        }));
      await api('/push', 'POST', subscription.toJSON());
      setPushActive(true);
    } catch (error) {
      report(error);
    }
  }

  function timeline(day = date, compact = false, widgetBoardId = boardId) {
    return (
      <Timeline
        date={day}
        setDate={setDate}
        tasks={
          workspace?.tasks.filter((item) => item.boardId === widgetBoardId) ||
          []
        }
        focusMinute={compact ? undefined : focusMinute}
        onAdd={() => editTask(null)}
        onEdit={editTask}
        onToggle={toggleTask}
        onMove={(item, start, end) => {
          void act(() => api('/tasks/' + item.id, 'PATCH', { start, end }));
        }}
        onCollapse={compact ? undefined : () => setCollapsed('timeline', true)}
        compact={compact}
      />
    );
  }
  function notesPanel(compact = false) {
    return (
      <section className="panel notes-panel" aria-label="Замітки">
        <div
          className="panel-head"
          onDoubleClick={
            compact ? undefined : () => setCollapsed('notes', true)
          }
        >
          <div className="panel-title">
            <span className="tile-icon lavender">
              <FileText size={18} />
            </span>
            <div>
              <h2>Замітки</h2>
              <p>{allNotes ? 'Усі дошки' : 'На цій дошці'}</p>
            </div>
          </div>
          <div className="actions">
            {!compact && (
              <button
                className="icon-button"
                onClick={() => setCollapsed('notes', true)}
                aria-label="Згорнути замітки"
              >
                <Minus size={16} />
              </button>
            )}
            <button
              className="icon-button"
              onClick={newNote}
              aria-label="Створити замітку"
            >
              <Plus size={19} />
            </button>
          </div>
        </div>
        <div className="note-list">
          {notes.map((note) => (
            <button
              className="note-row"
              onClick={() => {
                setSelectedNote({ ...note });
                setEditingNote(false);
                setPreview(undefined);
              }}
              key={note.id}
            >
              <span className="note-file">
                <FileText size={16} />
              </span>
              <span>
                <strong>{note.title}</strong>
                <small>
                  {note.body
                    .replace(/^[#*>\s-]+/, '')
                    .split('\n')[0]
                    ?.slice(0, 70) || 'Markdown'}
                </small>
              </span>
            </button>
          ))}
          {!notes.length && (
            <button className="note-empty" onClick={newNote}>
              <SquarePen size={18} /> Створити замітку
            </button>
          )}
        </div>
        {!compact && (
          <button
            className="notes-footer"
            onClick={() => setAllNotes(!allNotes)}
          >
            <Layers3 size={15} />
            {allNotes ? 'Замітки цієї дошки' : 'Усі замітки'}
          </button>
        )}
      </section>
    );
  }

  if (!session?.user)
    return (
      <main className="entry">
        <Brand />
        <div className="login panel">
          <span className="tile-icon blue">
            <LayoutGrid size={21} />
          </span>
          <h1>Твій день в Assist</h1>
          <p>Дошки для справ, розклад дня та Markdown-замітки.</p>
          <a className="button primary" href="/auth/google">
            Увійти через Google
          </a>
          {session?.demo && (
            <button
              className="button subtle"
              onClick={() =>
                api('/demo', 'POST', {})
                  .then(() => api<Session>('/session'))
                  .then(setSession)
                  .catch(report)
              }
            >
              Відкрити демоверсію
            </button>
          )}
          {message && <p role="alert">{message}</p>}
        </div>
      </main>
    );

  return (
    <div className="app">
      <header className="topbar">
        <Brand />
        <div className="top-divider" />
        <div className="breadcrumb">
          <LayoutGrid size={17} />{' '}
          <span>{board?.title ?? 'Робочий простір'}</span>
        </div>
        <div className="top-right">
          <button
            className="icon-button top-settings"
            onClick={() => {
              setDialog('settings');
              setPairCode('');
            }}
            aria-label="Налаштування"
          >
            <Settings2 size={19} />
          </button>
          <button
            className="avatar"
            onClick={() => setDialog('settings')}
            aria-label="Акаунт"
          >
            {session.user.name.slice(0, 2).toUpperCase()}
          </button>
        </div>
      </header>

      <main className="workspace">
        <div className="heading">
          <div>
            <div className="heading-date">
              <CalendarDays size={16} />{' '}
              <span>
                {weekDay.format(localDate(date))},{' '}
                {dateLabel.format(localDate(date))}
              </span>
            </div>
            <h1>{board?.title ?? 'Мій простір'}</h1>
          </div>
          <button
            className="button primary add-task"
            aria-label="Нове завдання"
            onClick={() => editTask(null)}
            disabled={!board}
          >
            <Plus size={18} /> Нове завдання
          </button>
        </div>
        <div className="day-summary" aria-label="Підсумок дня">
          <div>
            <span className="tile-icon blue">
              <CalendarDays size={17} />
            </span>
            <span>
              <strong>{datedTasks.length}</strong>
              <small>Заплановано</small>
            </span>
          </div>
          <div>
            <span className="tile-icon mint">
              <Check size={18} />
            </span>
            <span>
              <strong>{completed}</strong>
              <small>Виконано</small>
            </span>
          </div>
          <div>
            <span className="tile-icon violet">
              <FileText size={17} />
            </span>
            <span>
              <strong>
                {workspace?.notes.filter((item) => item.boardId === boardId)
                  .length ?? 0}
              </strong>
              <small>Замітки</small>
            </span>
          </div>
        </div>
        {board && (
          <div
            className={
              'widget-grid' +
              (collapsed.includes('notes') || collapsed.includes('timeline')
                ? ' single'
                : '') +
              (board.layout?.notesFirst ? ' notes-first' : '')
            }
          >
            {!collapsed.includes('timeline') && timeline()}
            {!collapsed.includes('notes') && notesPanel()}
          </div>
        )}
        {collapsed.length > 0 && (
          <div
            className="widget-dock"
            aria-label="Згорнуті віджети"
            onMouseLeave={() => setPreview(undefined)}
          >
            {collapsed.map((id) => (
              <button
                key={id}
                className="dock-item"
                onMouseEnter={() => setPreview(id)}
                onFocus={() => setPreview(id)}
                onBlur={() => setPreview(undefined)}
                onClick={() => setCollapsed(id, false)}
              >
                {id === 'timeline' ? (
                  <Clock3 size={17} />
                ) : (
                  <FileText size={17} />
                )}
                <span>{widgetTitles[id]}</span>
              </button>
            ))}
            {preview && (
              <div className="widget-preview">
                {preview === 'timeline'
                  ? timeline(date, true)
                  : notesPanel(true)}
              </div>
            )}
          </div>
        )}
      </main>

      <nav
        className={'board-switcher' + (boardsOpen ? ' open' : '')}
        aria-label="Дошки"
        onMouseLeave={() => setBoardsOpen(false)}
        onWheel={(event) => {
          if (!boardsOpen || !workspace || workspace.boards.length < 2) return;
          const index = workspace.boards.findIndex(
            (item) => item.id === boardId,
          );
          const delta = event.deltaY || event.deltaX;
          selectBoard(
            workspace.boards[
              (index + (delta > 0 ? 1 : -1) + workspace.boards.length) %
                workspace.boards.length
            ].id,
          );
        }}
      >
        <button
          className="board-trigger"
          aria-expanded={boardsOpen}
          onMouseEnter={() => setBoardsOpen(true)}
          onClick={() => setBoardsOpen(!boardsOpen)}
        >
          <LayoutGrid size={15} /> Дошки <ChevronDown size={13} />
        </button>
        {boardsOpen && (
          <div className="board-options">
            {workspace?.boards.map((item) => (
              <button
                key={item.id}
                className={item.id === boardId ? 'active' : ''}
                onClick={() => {
                  selectBoard(item.id);
                  setBoardsOpen(false);
                }}
              >
                <span style={{ background: item.color }} /> {item.title}
              </button>
            ))}
            <button
              aria-label="Нова дошка"
              onClick={() => {
                setBoardsOpen(false);
                setDialog('board');
              }}
            >
              <Plus size={18} />
            </button>
          </div>
        )}
      </nav>

      {selectedNote && (
        <aside className="note-drawer panel" aria-label="Редактор замітки">
          <div className="panel-head">
            <span className="panel-title">
              <span className="tile-icon lavender">
                <FileText size={17} />
              </span>
              <strong>Замітка</strong>
            </span>
            <button
              className="icon-button"
              onClick={() => setSelectedNote(undefined)}
              aria-label="Закрити замітку"
            >
              <PanelLeftClose size={20} />
            </button>
          </div>
          <div className="note-drawer-content">
            {editingNote ? (
              <form
                className="form note-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void act(async () => {
                    try {
                      const saved = await api<Note>(
                        '/notes/' + selectedNote.id,
                        'PATCH',
                        {
                          title: selectedNote.title,
                          body: selectedNote.body,
                          revision: selectedNote.revision,
                        },
                      );
                      setSelectedNote(saved);
                      setConflictedNote(undefined);
                    } catch (error) {
                      if (error instanceof ApiError && error.status === 409) {
                        setConflictedNote(selectedNote.id);
                        throw new Error(
                          'Замітку вже змінено. Можна зберегти твою версію як копію.',
                        );
                      }
                      throw error;
                    }
                  }).then((ok) => {
                    if (ok) setEditingNote(false);
                  });
                }}
              >
                <label>
                  Назва
                  <input
                    value={selectedNote.title}
                    required
                    onChange={(event) =>
                      setSelectedNote({
                        ...selectedNote,
                        title: event.target.value,
                      })
                    }
                  />
                </label>
                <div className="note-inserts">
                  <span>Вставити</span>
                  <button
                    type="button"
                    className="button subtle"
                    onClick={() =>
                      setSelectedNote({
                        ...selectedNote,
                        body:
                          selectedNote.body +
                          '\n\n```assist\n{"type":"timeline","date":"today"}\n```\n',
                      })
                    }
                  >
                    <Clock3 size={15} /> Розклад
                  </button>
                  <select
                    aria-label="Вставити завдання"
                    value=""
                    onChange={(event) => {
                      if (event.target.value)
                        setSelectedNote({
                          ...selectedNote,
                          body:
                            selectedNote.body +
                            '\n\n```assist\n' +
                            JSON.stringify({
                              type: 'task',
                              id: event.target.value,
                            }) +
                            '\n```\n',
                        });
                    }}
                  >
                    <option value="">Завдання</option>
                    {workspace?.tasks.map((item) => (
                      <option value={item.id} key={item.id}>
                        {item.title}
                      </option>
                    ))}
                  </select>
                </div>
                <label>
                  Markdown
                  <textarea
                    value={selectedNote.body}
                    onChange={(event) =>
                      setSelectedNote({
                        ...selectedNote,
                        body: event.target.value,
                      })
                    }
                    placeholder="Почни писати…"
                  />
                </label>
                {conflictedNote === selectedNote.id && (
                  <div className="form-error">
                    Замітку оновлено в іншому вікні або в Obsidian.{' '}
                    <button
                      type="button"
                      className="button subtle"
                      onClick={() => {
                        void act(async () => {
                          const copy = await api<Note>('/notes', 'POST', {
                            boardId: selectedNote.boardId,
                            title: selectedNote.title + ' (копія)',
                            body: selectedNote.body,
                          });
                          setSelectedNote(copy);
                          setConflictedNote(undefined);
                          setEditingNote(false);
                        });
                      }}
                    >
                      Зберегти копію
                    </button>
                  </div>
                )}
                <div className="modal-actions">
                  <button
                    type="button"
                    className="button danger"
                    onClick={() => {
                      if (confirm('Видалити цю замітку?'))
                        void act(() =>
                          api('/notes/' + selectedNote.id, 'DELETE'),
                        ).then((ok) => {
                          if (ok) setSelectedNote(undefined);
                        });
                    }}
                  >
                    Видалити
                  </button>
                  <button className="button primary">Зберегти</button>
                </div>
              </form>
            ) : (
              <>
                <div className="note-heading">
                  <h2>{selectedNote.title}</h2>
                  <button
                    className="icon-button"
                    onClick={() => setEditingNote(true)}
                    aria-label="Редагувати замітку"
                  >
                    <SquarePen size={18} />
                  </button>
                </div>
                <div className="markdown">
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    components={{
                      pre({ children }) {
                        if (
                          isValidElement<{
                            className?: string;
                            children?: string;
                          }>(children) &&
                          children.props.className === 'language-assist'
                        ) {
                          try {
                            const block = JSON.parse(
                              String(children.props.children),
                            );
                            if (block.type === 'task') {
                              const linked = workspace?.tasks.find(
                                (item) => item.id === block.id,
                              );
                              return linked ? (
                                <button
                                  className="button subtle"
                                  onClick={() => focusTask(linked)}
                                >
                                  {linked.done ? (
                                    <Check size={15} />
                                  ) : (
                                    <Clock3 size={15} />
                                  )}
                                  {linked.title}
                                </button>
                              ) : (
                                <span className="muted">
                                  Завдання недоступне
                                </span>
                              );
                            }
                            if (
                              block.type === 'timeline' &&
                              (block.date === 'today' ||
                                /^\d{4}-\d{2}-\d{2}$/.test(block.date))
                            )
                              return timeline(
                                block.date === 'today' ? dateKey() : block.date,
                                true,
                                selectedNote.boardId,
                              );
                          } catch {
                            /* Keep invalid blocks as readable Markdown. */
                          }
                        }
                        return <pre>{children}</pre>;
                      },
                    }}
                  >
                    {selectedNote.body || '*Порожня замітка*'}
                  </ReactMarkdown>
                </div>
              </>
            )}
          </div>
        </aside>
      )}

      {dialog === 'task' && (
        <Modal
          title={task ? 'Редагувати завдання' : 'Нове завдання'}
          close={() => setDialog(null)}
        >
          <TaskForm
            key={task?.id ?? 'new'}
            task={task}
            date={date}
            boardId={task?.boardId ?? boardId}
            google={Boolean(workspace?.googleConnected)}
            save={(draft) => {
              void act(() =>
                api(
                  task ? '/tasks/' + task.id : '/tasks',
                  task ? 'PATCH' : 'POST',
                  draft,
                ),
              ).then((ok) => {
                if (ok) setDialog(null);
              });
            }}
            remove={() => {
              if (task && confirm('Видалити це завдання?'))
                void act(() => api('/tasks/' + task.id, 'DELETE')).then(
                  (ok) => {
                    if (ok) setDialog(null);
                  },
                );
            }}
          />
        </Modal>
      )}
      {dialog === 'board' && (
        <Modal title="Нова дошка" close={() => setDialog(null)}>
          <form
            className="form"
            onSubmit={(event) => {
              event.preventDefault();
              const values = new FormData(event.currentTarget);
              void act(async () => {
                const created = await api<Board>('/boards', 'POST', {
                  title: String(values.get('title')).trim(),
                  color:
                    boardColors[
                      (workspace?.boards.length ?? 0) % boardColors.length
                    ],
                });
                selectBoard(created.id);
              }).then((ok) => {
                if (ok) setDialog(null);
              });
            }}
          >
            <label>
              Назва дошки
              <input name="title" maxLength={100} required autoFocus />
            </label>
            <div className="modal-actions">
              <button className="button primary">Створити</button>
            </div>
          </form>
        </Modal>
      )}
      {dialog === 'settings' && (
        <Modal title="Налаштування" close={() => setDialog(null)}>
          <div className="integration">
            <span className="tile-icon blue">
              <Check size={17} />
            </span>
            <div>
              <strong>Google Tasks</strong>
              <p>
                {workspace?.googleConnected
                  ? 'Підключено'
                  : 'Синхронізація завдань із Google'}
              </p>
            </div>
            {workspace?.googleConnected ? (
              <button
                className="button subtle"
                onClick={() =>
                  api<{ lists: { id: string; title: string }[] }>(
                    '/google/lists',
                  )
                    .then((result) => setGoogleLists(result.lists))
                    .catch(report)
                }
              >
                Списки
              </button>
            ) : (
              <a className="button subtle" href="/auth/tasks">
                Підключити
              </a>
            )}
          </div>
          {googleLists && (
            <form
              className="form"
              onSubmit={(event) => {
                event.preventDefault();
                const listId = new FormData(event.currentTarget).get('list');
                if (listId)
                  void act(() =>
                    api('/google/connect', 'POST', { boardId, listId }),
                  ).then((ok) => {
                    if (ok) {
                      setGoogleLists(undefined);
                      setMessage('Список пов’язано з дошкою.');
                    }
                  });
              }}
            >
              <label>
                Список для дошки {board?.title}
                <select name="list" required>
                  {googleLists.map((list) => (
                    <option key={list.id} value={list.id}>
                      {list.title}
                    </option>
                  ))}
                </select>
              </label>
              <button className="button primary">Пов’язати</button>
            </form>
          )}
          <div className="integration">
            <span className="tile-icon lavender">
              <FileText size={17} />
            </span>
            <div>
              <strong>Obsidian</strong>
              <p>Синхронізація папки заміток</p>
            </div>
            <button
              className="button subtle"
              disabled={!board}
              onClick={() => {
                void api<{ code: string }>('/obsidian/pair', 'POST', {
                  boardId,
                })
                  .then((result) => setPairCode(result.code))
                  .catch(report);
              }}
            >
              Отримати код
            </button>
          </div>
          {pairCode && (
            <p className="pair-code">
              Адреса <code>{location.origin}</code>
              <br />
              Код <code>{pairCode}</code>
            </p>
          )}
          <div className="integration">
            <span className="tile-icon mint">
              <Bell size={17} />
            </span>
            <div>
              <strong>Сповіщення браузера</strong>
              <p>Для завдань Assist</p>
            </div>
            <button
              className="button subtle"
              disabled={pushActive || !session.pushKey}
              onClick={enablePush}
            >
              {pushActive ? 'Увімкнено' : 'Увімкнути'}
            </button>
          </div>
          <div className="integration">
            <span className="tile-icon lavender">
              <LayoutGrid size={17} />
            </span>
            <div>
              <strong>Сітка дошки</strong>
              <p>
                {board?.layout?.notesFirst ? 'Замітки зліва' : 'Розклад зліва'}
              </p>
            </div>
            <button
              className="button subtle"
              disabled={!board}
              onClick={() => {
                if (board)
                  void act(() =>
                    api('/boards/' + board.id, 'PATCH', {
                      layout: {
                        ...board.layout,
                        notesFirst: !board.layout?.notesFirst,
                      },
                    }),
                  );
              }}
            >
              Поміняти місцями
            </button>
          </div>
          <div className="integration">
            <span className="tile-icon blue">
              <CircleHelp size={17} />
            </span>
            <div>
              <strong>{session.user.name}</strong>
              <p>{session.user.email}</p>
            </div>
            <button
              className="button subtle"
              onClick={async () => {
                try {
                  await fetch('/auth/logout', { method: 'POST' });
                  location.reload();
                } catch (error) {
                  report(error);
                }
              }}
            >
              <LogOut size={15} /> Вийти
            </button>
          </div>
        </Modal>
      )}
      {message && (
        <div className="toast" role="status">
          {message}
          <button
            className="icon-button"
            aria-label="Закрити повідомлення"
            onClick={() => setMessage('')}
          >
            <X size={16} />
          </button>
        </div>
      )}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
