// Каркас витрины: шапка (крошки, свежесть, тема) и маршрут. Маршруты — в хеше адреса (#/project/EXT, с открытой
// карточкой #/project/EXT/EXT-6), чтобы раздаче web/dist сервером не нужен был запасной маршрут на index.html.
import { useCallback, useEffect, useMemo, useState } from 'react';
import Ceh from './Ceh.jsx';
import Project from './Project.jsx';
import { cehSource, pollSource, useNow, useSource } from './data.js';
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
  const source = useMemo(() => (code ? pollSource(`/api/project/${code}`, 5000) : cehSource), [code]);
  const { data, failingSince, error } = useSource(source);
  const now = useNow(5000);

  useEffect(() => {
    document.title = route.name === 'ceh' ? 'Экстрактор · Цех' : `Экстрактор · ${route.card || route.code}`;
  }, [route]);

  const open = (c) => { window.location.hash = `#/project/${c}`; };
  // карточка другого проекта (связь) открывается в окне своего проекта
  const openCard = useCallback((id) => { window.location.hash = `#/project/${id.split('-')[0]}/${id}`; }, []);
  const closeCard = useCallback(() => {
    const r = parseRoute();
    if (r.name !== 'project' || !r.card) return;
    window.location.hash = `#/project/${r.code}`;
    setTimeout(() => document.querySelector(`[data-id="${r.card}"]`)?.focus(), 0); // после перерисовки доски — фокус на карточку
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
