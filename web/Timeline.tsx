import { useEffect, useRef, useState } from 'react';
import {
  Bell,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock3,
  LocateFixed,
  Minus,
  Plus,
} from 'lucide-react';
import type { PointerEvent } from 'react';
import {
  clockText,
  dateKey,
  lanesFor,
  localDate,
  moveDay,
  taskWidth,
  TIMELINE_SCALE as SCALE,
} from './model';
import type { Task } from './model';

const HOURS = Array.from({ length: 24 }, (_, index) => index);
const dayFormat = new Intl.DateTimeFormat('uk', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
});

export function Timeline({
  date,
  setDate,
  tasks,
  onAdd,
  onEdit,
  onToggle,
  onMove,
  onCollapse,
  focusMinute,
  compact = false,
}: {
  date: string;
  setDate: (date: string) => void;
  tasks: Task[];
  onAdd: () => void;
  onEdit: (task: Task) => void;
  onToggle: (task: Task) => void;
  onMove: (task: Task, start: number, end: number | null) => void;
  onCollapse?: () => void;
  focusMinute?: { minute: number };
  compact?: boolean;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const drag = useRef<{ task: Task; startX: number; delta: number } | null>(
    null,
  );
  const suppressClick = useRef(false);
  const programmatic = useRef(0);
  const [now, setNow] = useState(() => new Date());
  const [follow, setFollow] = useState(true);
  const [dragging, setDragging] = useState<{
    id: string;
    delta: number;
  } | null>(null);
  const isToday = date === dateKey(now);
  const minutes =
    now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;
  const today = dateKey();
  const { entries, count } = lanesFor(
    tasks.filter((task) => task.date === date),
  );
  const allDay = tasks.filter(
    (task) => task.date === date && task.start === null,
  );
  const backlog = tasks.filter((task) => task.date === null);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  function center(minute: number) {
    const element = viewport.current;
    if (!element) return;
    programmatic.current = performance.now() + 100;
    element.scrollLeft = minute * SCALE - element.clientWidth * 0.47;
  }

  useEffect(() => {
    if (follow && isToday && !compact) center(minutes);
  }, [follow, isToday, minutes, compact]);

  useEffect(() => {
    if (!isToday || compact) center((entries[0]?.task.start ?? 540) + 110);
  }, [date]);

  useEffect(() => {
    if (!focusMinute) return;
    setFollow(false);
    center(focusMinute.minute);
  }, [focusMinute]);

  function pointerDown(event: PointerEvent<HTMLButtonElement>, task: Task) {
    if (event.button !== 0 || compact) return;
    drag.current = { task, startX: event.clientX, delta: 0 };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function pointerMove(event: PointerEvent<HTMLButtonElement>) {
    const active = drag.current;
    if (!active) return;
    const diff = event.clientX - active.startX;
    if (!active.delta && Math.abs(diff) < 7) return;
    setFollow(false);
    const start = active.task.start!;
    const end = active.task.end ?? start;
    const delta = Math.max(
      -start,
      Math.min(1439 - end, Math.round(diff / SCALE / 5) * 5),
    );
    active.delta = delta;
    setDragging({ id: active.task.id, delta });
  }

  function pointerUp() {
    const active = drag.current;
    drag.current = null;
    setDragging(null);
    if (active?.delta) {
      suppressClick.current = true;
      onMove(
        active.task,
        active.task.start! + active.delta,
        active.task.end === null ? null : active.task.end + active.delta,
      );
      window.setTimeout(() => {
        suppressClick.current = false;
      }, 0);
    }
  }

  return (
    <section className="panel timeline" aria-label="Таймлайн">
      <div className="panel-head" onDoubleClick={onCollapse}>
        <div className="panel-title">
          <span className="tile-icon blue">
            <Clock3 size={18} />
          </span>
          <div>
            <h2>Розклад дня</h2>
            <p>{dayFormat.format(localDate(date))}</p>
          </div>
        </div>
        {!compact && (
          <div className="actions">
            <button
              className="icon-button"
              aria-label="Попередній день"
              onClick={() => setDate(moveDay(date, -1))}
            >
              <ChevronLeft size={17} />
            </button>
            <button
              className="icon-button"
              aria-label="Наступний день"
              onClick={() => setDate(moveDay(date, 1))}
            >
              <ChevronRight size={17} />
            </button>
            <button
              className={
                'button subtle now-button' +
                (follow && isToday ? ' following' : '')
              }
              aria-label="Повернутися до поточного часу"
              onClick={() => {
                setDate(today);
                setFollow(true);
                center(minutes);
              }}
            >
              <LocateFixed size={15} /> Зараз
            </button>
            {onCollapse && (
              <button
                className="icon-button"
                aria-label="Згорнути розклад"
                onClick={onCollapse}
              >
                <Minus size={16} />
              </button>
            )}
          </div>
        )}
      </div>
      <div className="all-day">
        <span className="section-label">На весь день</span>
        <div className="day-items">
          {allDay.map((task) => (
            <div className="day-task" key={task.id}>
              <button
                className={'checkbox' + (task.done ? ' checked' : '')}
                aria-label={
                  task.done ? 'Позначити невиконаним' : 'Позначити виконаним'
                }
                onClick={() => onToggle(task)}
              >
                {task.done && <Check size={12} />}
              </button>
              <button
                className={task.done ? 'struck' : ''}
                onClick={() => onEdit(task)}
              >
                {task.title}
              </button>
            </div>
          ))}
          {allDay.length === 0 && (
            <span className="muted small">Поки немає завдань</span>
          )}
          {!compact && (
            <button
              className="icon-button mini"
              aria-label="Додати завдання"
              onClick={onAdd}
            >
              <Plus size={16} />
            </button>
          )}
        </div>
      </div>
      <div
        className="timeline-view"
        ref={viewport}
        onPointerDown={(event) => {
          if (
            event.target instanceof Element &&
            !event.target.closest('button')
          )
            setFollow(false);
        }}
        onTouchMove={() => setFollow(false)}
        onWheel={(event) => {
          if (Math.abs(event.deltaX) > 0) setFollow(false);
        }}
        onScroll={() => {
          if (performance.now() > programmatic.current) setFollow(false);
        }}
      >
        <div
          className="time-track"
          style={{ width: 1440 * SCALE, height: 49 + count * 65 }}
        >
          {HOURS.map((hour) => (
            <div
              className="hour"
              key={hour}
              style={{ left: hour * 60 * SCALE }}
            >
              <span>{clockText(hour * 60)}</span>
            </div>
          ))}
          {Array.from({ length: count }, (_, lane) => (
            <div key={lane} className="lane" style={{ top: 45 + lane * 65 }} />
          ))}
          {entries.map(({ task, lane }, index) => {
            const start =
              task.start! + (dragging?.id === task.id ? dragging.delta : 0);
            const point = task.end === null || task.end === task.start;
            const width = taskWidth(task);
            return (
              <button
                key={task.id}
                className={`time-task color-${index % 3} ${point ? 'point' : ''} ${task.done ? 'done' : ''}`}
                style={{ left: start * SCALE, top: 52 + lane * 65, width }}
                title={task.title}
                onPointerDown={(event) => pointerDown(event, task)}
                onPointerMove={pointerMove}
                onPointerCancel={() => {
                  drag.current = null;
                  setDragging(null);
                }}
                onPointerUp={pointerUp}
                onClick={() => {
                  if (!suppressClick.current) {
                    setFollow(false);
                    onEdit(task);
                  }
                }}
              >
                {point && (
                  <span className="point-marker">
                    {task.done ? <Check size={10} /> : <Bell size={10} />}
                  </span>
                )}
                <span className="time-task-title">{task.title}</span>
                <span className="time-task-time">
                  {clockText(start)}
                  {!point && ' – ' + clockText(start + task.end! - task.start!)}
                </span>
              </button>
            );
          })}
          {isToday && (
            <div className="now-line" style={{ left: minutes * SCALE }}>
              <span>{clockText(Math.floor(minutes))}</span>
            </div>
          )}
        </div>
      </div>
      {!compact && (
        <div className="timeline-footer">
          <span>
            <span className="live-dot" />{' '}
            {isToday ? 'Поточний час' : 'Перегляд дня'}
          </span>
          <span>{entries.length} у розкладі</span>
        </div>
      )}
      {!compact && backlog.length > 0 && (
        <div className="backlog">
          <span className="section-label">Без дати</span>
          {backlog.map((task) => (
            <button
              className="button subtle"
              key={task.id}
              onClick={() => onEdit(task)}
            >
              {task.title}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
