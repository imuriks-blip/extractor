// Каркас витрины: шапка (крошки, свежесть, тема) и маршрут. Маршруты — в хеше адреса (#/project/EXT, с открытой
// карточкой #/project/EXT/EXT-6), чтобы раздаче web/dist сервером не нужен был запасной маршрут на index.html.
import { useCallback, useEffect, useMemo, useState } from 'react';
import Ceh from './Ceh.jsx';
import Glossary from './Glossary.jsx';
import Help from './Help.jsx';
import MirrorButton from './Mirror.jsx';
import Project from './Project.jsx';
import { cehSource, idleSource, streamSource, useNow, useSource } from './data.js';
import { dm, hms, oldest } from './format.js';
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

// «1 битая строка», «2–4 битые строки», «5+ / 11–14 битых строк»
const badLines = (n) => {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return `${n} битая строка`;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return `${n} битые строки`;
  return `${n} битых строк`;
};

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
          {mirror && <><span className="sep">·</span><span title="Зеркало доски целиком обновляется кнопкой «Обновить» или проходом дирижёра; после «Принять»/«Вернуть» подтягивается одна карточка — время свежее, а остальная доска может быть старой">{mirror}</span></>}
          {/* EXT-50 (§3.4а спеки пульта): суточная копия журнала действий; красным — удачной нет больше 48 ч, попытка
              неудачна, журнал стал короче или пропал, хранимая копия не читается; причина — /api/health → backup.lastError */}
          {route.name === 'ceh' && freshness.backup && (
            <><span className="sep">·</span>
              <span className={freshness.backup.stale ? 'fresh-bad' : undefined}
                title={freshness.backup.stale ? 'Копия журнала нажатий: нет удачной копии больше 48 ч, попытка неудачна, журнал стал короче или пропал, либо хранимая копия не читается или повреждена — причина в /api/health' : 'Суточная копия журнала нажатий пульта'}>
                копия журнала нажатий · {freshness.backup.lastOkAt ? dm(freshness.backup.lastOkAt) : 'нет'}{freshness.backup.stale ? ' — проверь' : ''}
              </span>
              {/* битые строки самого журнала — жёлтым отдельно от сбоя копии (вердикт Голема, Важно 3) */}
              {freshness.backup.journalBad && (
                <><span className="sep">·</span>
                  <span className="fresh-warn" title="Строки журнала нажатий, которые не читаются как запись (обрыв записи при сбое питания). Копии при этом верные; журнал — первичный факт и не правится">
                    в журнале {badLines(freshness.backup.journalBad.count)} (первая — строка {freshness.backup.journalBad.first})
                  </span></>
              )}
            </>
          )}
        </span>
      )}
      {/* кнопка — только пока доска живёт зеркалом Plane (есть подпись зеркала); мелочь Голема на EXT-42 */}
      {freshness && mirror && <MirrorButton label={mirror} />}
      <ThemeSwitch />
      <Glossary />
      <Help />
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
