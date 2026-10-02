// Каркас витрины: шапка (крошки, свежесть, тема) и маршрут. Маршруты — в хеше адреса (#/project/EXT, с открытой
// карточкой #/project/EXT/EXT-6), чтобы раздаче web/dist сервером не нужен был запасной маршрут на index.html.
import { useCallback, useEffect, useMemo, useState } from 'react';
import Ceh from './Ceh.jsx';
import Project from './Project.jsx';
import { cehSource, idleSource, streamSource, useNow, useSource } from './data.js';
import { hms, oldest } from './format.js';
import { useTheme } from './prefs.js';

function parseRoute() {
  const m = /^#\/project\/([A-Z]{2,6})(?:\/([A-Z]{2,6}-\d+))?$/.exec(window.location.hash);
  return m ? { name: 'project', code: m[1], card: m[2] ?? null } : { name: 'ceh' };
}

function useRoute() {
  const [route, set] = useState(parseRoute);
  useEffect(() => {
    const on = () => set(parseRoute());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

function ThemeSwitch() {
  const [theme, setTheme] = useTheme();
  const items = [['auto', 'Авто'], ['light', 'Светлая'], ['dark', 'Тёмная']];
  return (
    <span className="seg" role="group" aria-label="Тема">
      {items.map(([k, label]) => (
        <button key={k} type="button" aria-pressed={theme === k} onClick={() => setTheme(k)}>{label}</button>
      ))}
    </span>
  );
}

function Header({ route, freshness, name }) {
  const read = oldest(freshness?.board?.lastOkAt, freshness?.journals?.lastOkAt);
  const mirror = freshness?.mirror?.label;
  return (
    <header className="top">
      <b>Экстрактор</b><span className="sep">/</span>
      {route.name === 'ceh'
        ? <span>Цех</span>
        : <><a href="#/">Цех</a><span className="sep">/</span><span><b className="mono pcode">{route.code}</b>{name && <> · {name}</>}</span></>}
      {freshness && (
        <span className="fresh muted mono">
          <span title="Когда кабина последний раз прочитала журналы и доску">журналы и доска · {read ? hms(read) : '—'}</span>
          {mirror && <><span className="sep">·</span><span title="Зеркало доски обновляется вручную: файлы доски отстают от Plane на время с последнего прохода">{mirror}</span></>}
        </span>
      )}
      <ThemeSwitch />
    </header>
  );
}

export default function App() {
  const route = useRoute();
  const code = route.name === 'project' ? route.code : null;
  // один источник на экран: «Цех» — /api/ceh, окно проекта — /api/project/<КОД>
  const source = useMemo(() => (code ? streamSource(`/api/project/${code}`) : cehSource), [code]);
  const { data, failingSince, error } = useSource(source);
  // счётчик (4.2): N = |а| + |б| по всем проектам — из /api/ceh и в окне проекта; Review не входит
  const ceh = useSource(code ? cehSource : idleSource);
  const count = (code ? ceh.data : data)?.waiting?.count;
  const n = Number.isInteger(count) ? count : null;
  const now = useNow(5000);

  // заголовок «(N) Экстрактор · Цех» / «(N) Экстрактор · <КОД>»; N = 0 или ещё не прочитано — без скобок
  useEffect(() => {
    const base = route.name === 'ceh' ? 'Экстрактор · Цех' : `Экстрактор · ${route.code}`;
    document.title = n > 0 ? `(${n}) ${base}` : base;
  }, [route, n]);
  // значок на иконке установленного приложения (4.2, В-8): тот же N; 0 — снят; не прочитано — не трогаем
  useEffect(() => {
    if (n == null) return;
    const p = n > 0 ? navigator.setAppBadge?.(n) : navigator.clearAppBadge?.();
    p?.catch?.(() => {});
  }, [n]);

  const open = (c) => { window.location.hash = `#/project/${c}`; };
  // карточка другого проекта (связь) открывается в окне своего проекта
  const openCard = useCallback((id) => { window.location.hash = `#/project/${id.split('-')[0]}/${id}`; }, []);
  const closeCard = useCallback(() => {
    const r = parseRoute();
    if (r.name !== 'project' || !r.card) return;
    window.location.hash = `#/project/${r.code}`;
    setTimeout(() => { // после перерисовки доски — фокус на карточку; не видна — на заголовок доски
      const el = document.querySelector(`[data-id="${r.card}"]`);
      el?.focus();
      if (!el || document.activeElement !== el) document.querySelector('details.pboard > summary')?.focus();
    }, 0);
  }, []);

  let body;
  if (!data) {
    body = <div className="foot" role="status">
      {code && error === 'HTTP 404' ? `Проекта ${code} нет на доске.` : failingSince ? 'Сервер витрины не отвечает — пробую снова каждые 5 с.' : 'Читаю данные…'}
    </div>;
  } else if (code) {
    body = <Project code={code} data={data} failing={failingSince != null} now={now} cardId={route.card} onOpenCard={openCard} onCloseCard={closeCard} />;
  } else {
    body = <Ceh data={data} failing={failingSince != null} now={now} onOpenProject={open} />;
  }

  return (
    <div className="wrap">
      <Header route={route} freshness={data?.freshness} name={code ? data?.name : null} />
      {body}
    </div>
  );
}
