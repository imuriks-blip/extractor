// Кнопка «Обновить» в шапке (EXT-42; спека пульта, таблица 1.3 «Прогони зеркало», §1.1 п.3, §1.7, §4.2):
// POST /api/act {action: "mirror", kind: "changed"} — обычный проход зеркала; ход — GET /api/mirror раз в 4 с, только пока
// идёт. Итог — подпись «доска: зеркало Plane от …» обновится сама (она из /api/ceh); сбой прохода — красная пометка.
// Пульт выключен: флага в данных нет — узнаётся по первому 503 и запоминается на запуск сервера (токен страницы новый на
// каждый запуск, флаг pult.enabled читается при старте), кнопка до перезапуска витрины не показывается.
import { useCallback, useEffect, useRef, useState } from 'react';

const POLL_MS = 4000;
const OFF_KEY = 'vitrina.pultOff'; // токен запуска сервера, на котором пульт ответил 503
const RELOAD_KEY = 'vitrina.act403'; // {intentId, at}: страница перезагружена после 403, намерение повторяется тем же ключом
const RELOAD_FRESH_MS = 60000;
const HINT = 'прогнать зеркало доски: свежие карточки из Plane (обычный проход, несколько минут)';

const token = () => document.querySelector('meta[name="vitrina-token"]')?.content ?? '';
const store = {
  get(s, k) { try { return s.getItem(k); } catch { return null; } },
  set(s, k, v) { try { s.setItem(k, v); } catch { /* хранилище недоступно — без памяти */ } },
  del(s, k) { try { s.removeItem(k); } catch { /* то же */ } },
};

async function readMirror() {
  const r = await fetch('/api/mirror', { cache: 'no-store' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

// label — подпись зеркала из /api/ceh: сменилась (проход закончился или начат Планировщиком) — ход перечитывается
export default function MirrorButton({ label }) {
  const [off, setOff] = useState(() => { const t = token(); return !!t && store.get(localStorage, OFF_KEY) === t; });
  const [phase, setPhase] = useState('idle'); // idle | pending | running | off
  const [st, setSt] = useState(null); // последний ответ /api/mirror
  const [note, setNote] = useState(null); // красная пометка {text, title}
  const intent = useRef(null); // ключ намерения без ответа (сбой сети) — повтор нажатием с тем же ключом
  const resent = useRef(false);

  const check = useCallback(async () => {
    try {
      const m = await readMirror();
      setSt(m);
      setPhase((p) => (p === 'pending' || p === 'off' ? p : m.running ? 'running' : 'idle'));
      return m;
    } catch { return null; }
  }, []);

  useEffect(() => { if (!off) check(); }, [off, label, check]);

  // опрос — только пока идёт
  useEffect(() => {
    if (phase !== 'running') return undefined;
    const t = setInterval(check, POLL_MS);
    return () => clearInterval(t);
  }, [phase, check]);

  const press = useCallback(async (reuse) => {
    const id = reuse ?? intent.current ?? crypto.randomUUID();
    intent.current = id;
    setPhase('pending');
    setNote(null);
    let r, body;
    try {
      r = await fetch('/api/act', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Vitrina-Token': token() },
        body: JSON.stringify({ action: 'mirror', intentId: id, kind: 'changed' }),
      });
      body = await r.json().catch(() => ({}));
    } catch {
      setPhase('idle');
      setNote({ text: 'нет связи', title: 'витрина не ответила — нажми ещё раз, повтор того же нажатия' });
      return;
    }
    intent.current = null;
    if (r.status === 403) {
      // §4.2: токен на запуск сервера — одна перезагрузка страницы, второй 403 подряд — отказ
      if (!store.get(sessionStorage, RELOAD_KEY)) {
        store.set(sessionStorage, RELOAD_KEY, JSON.stringify({ intentId: id, at: Date.now() }));
        window.location.reload();
        return;
      }
      store.del(sessionStorage, RELOAD_KEY);
      setPhase('idle');
      setNote({ text: 'пульт отказал, перезапусти витрину', title: 'ответ 403 дважды подряд' });
      return;
    }
    store.del(sessionStorage, RELOAD_KEY);
    if (r.status === 503) {
      store.set(localStorage, OFF_KEY, token());
      setPhase('off');
      setTimeout(() => setOff(true), 6000);
      return;
    }
    if (r.ok || (r.status === 409 && body?.outcome === 'refused')) {
      setPhase('running'); // «уже идёт» — не ошибка: показываем ход того прохода
      check();
      return;
    }
    setPhase('idle');
    setNote({ text: 'ошибка', title: body?.message || `ошибка: HTTP ${r.status}` });
  }, [check]);

  // после перезагрузки на 403 — то же намерение тем же ключом (§1.1 п.3)
  useEffect(() => {
    if (resent.current || off) return;
    resent.current = true;
    let prev = null;
    try { prev = JSON.parse(store.get(sessionStorage, RELOAD_KEY)); } catch { prev = null; }
    if (prev?.intentId && Date.now() - prev.at < RELOAD_FRESH_MS) press(prev.intentId);
    else store.del(sessionStorage, RELOAD_KEY);
  }, [off, press]);

  if (off) return null;
  if (phase === 'off') return <span className="mbtn-off faint" role="status">пульт выключен</span>;

  const running = phase === 'running';
  const nums = running && Number.isFinite(st?.cardsDone) && Number.isFinite(st?.cardsTotal);
  const text = phase === 'pending' ? 'запускаю…' : running ? (nums ? `обновляю · ${st.cardsDone} из ${st.cardsTotal}` : 'обновляю…') : 'Обновить';
  const runTitle = running
    ? ['зеркало идёт', st?.kind, st?.phase && `фаза ${st.phase}`, Number.isFinite(st?.requests) && `запросов ${st.requests}`, Number.isFinite(st?.rpm) && `${st.rpm}/мин`].filter(Boolean).join(' · ')
    : HINT;
  const err = note ?? (!running && phase !== 'pending' && st?.lastError ? { text: 'ошибка', title: `последний проход зеркала: ${st.lastError}` } : null);
  return (
    <span className="mbtn">
      <button type="button" className={running ? 'num' : undefined} disabled={phase !== 'idle'} title={runTitle} onClick={() => press()}>{text}</button>
      <span className="mbtn-note" role="status" title={err?.title}>{err?.text}</span>
    </span>
  );
}
