// Каркас витрины: шапка (крошки, свежесть, тема) и маршрут. Маршруты — в хеше адреса (#/project/EXT),
// чтобы раздаче web/dist сервером не нужен был запасной маршрут на index.html.
import { useEffect, useState } from 'react';
import Ceh from './Ceh.jsx';
import { cehSource, useNow, useSource } from './data.js';
import { hms, oldest } from './format.js';
import { useTheme } from './prefs.js';

function parseRoute() {
  const m = /^#\/project\/([A-Z]{2,6})$/.exec(window.location.hash);
  return m ? { name: 'project', code: m[1] } : { name: 'ceh' };
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

function Header({ route, freshness }) {
  const read = oldest(freshness?.board?.lastOkAt, freshness?.journals?.lastOkAt);
  const mirror = freshness?.mirror?.label;
  return (
    <header className="top">
      <b>Экстрактор</b><span className="sep">/</span>
      {route.name === 'ceh'
        ? <span>Цех</span>
        : <><a href="#/">Цех</a><span className="sep">/</span><span className="mono">{route.code}</span></>}
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

function ProjectStub({ code }) {
  return (
    <div className="stub">
      Окно проекта <span className="code">{code}</span> появится в такте В7. <a href="#/">← К «Цеху»</a>
    </div>
  );
}

export default function App() {
  const route = useRoute();
  const { data, failingSince } = useSource(cehSource);
  const now = useNow(5000);

  useEffect(() => {
    document.title = route.name === 'ceh' ? 'Экстрактор · Цех' : `Экстрактор · ${route.code}`;
  }, [route]);

  const open = (code) => { window.location.hash = `#/project/${code}`; };

  return (
    <div className="wrap">
      <Header route={route} freshness={data?.freshness} />
      {route.name === 'project'
        ? <ProjectStub code={route.code} />
        : data
          ? <Ceh data={data} failing={failingSince != null} now={now} onOpenProject={open} />
          : <div className="foot" role="status">{failingSince ? 'Сервер витрины не отвечает — пробую снова каждые 5 с.' : 'Читаю данные…'}</div>}
    </div>
  );
}
