// Источник данных экрана. В8: поток событий сервера (SSE /api/events, `changed {scope}` → перезапрос ручки);
// поток оборвался — откат на опрос раз в 5 с, поток вернулся — опрос снят (streamSource).
import { useEffect, useState } from 'react';

// Источник: subscribe(onData, onError) → отписка.

// Один EventSource на страницу, общий для всех источников экрана. Браузер переподключается к потоку сам (retry с
// сервера — 5 с); поток, закрытый навсегда (ответ не 200), пересоздаётся через 5 с.
const stream = { es: null, open: false, subs: new Set(), retry: null };
function streamUp() {
  if (stream.es || typeof EventSource === 'undefined') return;
  const es = new EventSource('/api/events');
  stream.es = es;
  es.addEventListener('open', () => { stream.open = true; for (const s of stream.subs) s.up(); });
  es.addEventListener('changed', () => { for (const s of stream.subs) s.changed(); });
  es.addEventListener('error', () => {
    stream.open = false;
    for (const s of stream.subs) s.down();
    if (es.readyState === EventSource.CLOSED && stream.es === es) {
      stream.es = null;
      clearTimeout(stream.retry);
      stream.retry = setTimeout(() => { if (stream.subs.size) streamUp(); }, 5000);
    }
  });
}
function streamDown() {
  if (stream.subs.size) return;
  stream.es?.close();
  stream.es = null;
  stream.open = false;
  clearTimeout(stream.retry);
}

// Источник на потоке: ручка читается при подписке, при открытии потока и на каждое `changed`; пока потока нет —
// опросом раз в fallbackMs. Ошибка ручки — onError, как у опроса (серая строка 2.7 и «Сервер витрины не отвечает»).
export function streamSource(url, fallbackMs = 5000) {
  const loads = new Set(); // загрузчики подписчиков — для reload()
  return {
    // перечитать сейчас (после действия, меняющего данные ручки)
    reload() { loads.forEach((f) => f()); },
    subscribe(onData, onError) {
      let stopped = false, ctl = null, busy = false, again = false, timer = null;
      const load = async () => {
        if (busy) { again = true; return; }
        busy = true;
        ctl = new AbortController();
        try {
          const r = await fetch(url, { cache: 'no-store', signal: ctl.signal });
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          const json = await r.json();
          if (!stopped) onData(json);
        } catch (e) {
          if (!stopped) onError(e);
        }
        busy = false;
        if (again && !stopped) { again = false; load(); }
      };
      // опрос, пока потока нет; уже идущий таймер не сбрасывается (ошибки переподключения приходят часто)
      const poll = () => {
        if (stopped || stream.open || timer) return;
        timer = setTimeout(async () => { timer = null; if (stream.open || stopped) return; await load(); poll(); }, fallbackMs);
      };
      const sub = { up: () => { clearTimeout(timer); timer = null; load(); }, changed: load, down: poll };
      stream.subs.add(sub);
      loads.add(load);
      streamUp();
      load();
      poll();
      return () => { stopped = true; loads.delete(load); clearTimeout(timer); ctl?.abort(); stream.subs.delete(sub); streamDown(); };
    },
  };
}

// Простой опрос ручки раз в everyMs без потока событий (экран «Расход»: данные тяжёлые, сервер кэширует их на 15 с)
export function pollSource(url, everyMs = 30000) {
  return {
    subscribe(onData, onError) {
      let stopped = false, ctl = null, timer = null;
      const load = async () => {
        ctl = new AbortController();
        try {
          const r = await fetch(url, { cache: 'no-store', signal: ctl.signal });
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          const json = await r.json();
          if (!stopped) onData(json);
        } catch (e) {
          if (!stopped) onError(e);
        }
        if (!stopped) timer = setTimeout(load, everyMs);
      };
      load();
      return () => { stopped = true; clearTimeout(timer); ctl?.abort(); };
    },
  };
}
export const usageSource = pollSource('/api/usage', 30000);

export const cehSource =streamSource('/api/ceh');
// источник без данных (экран, которому нечего читать)
export const idleSource = { subscribe: () => () => {} };

// Ошибка не стирает прежние данные (2.7): data остаётся, failingSince — с первого сбоя подряд, okAt — последний удачный ответ.
// Сменился источник (другой проект, другая карточка) — прежние данные не показываем: состояние помнит, чьё оно.
const EMPTY = { data: null, failingSince: null, okAt: null, error: null };
export function useSource(source) {
  const [st, set] = useState(() => ({ ...EMPTY, source }));
  useEffect(() => source.subscribe(
    (data) => set({ source, data, failingSince: null, okAt: Date.now(), error: null }),
    (e) => set((s) => {
      const cur = s.source === source ? s : { ...EMPTY, source };
      return { ...cur, failingSince: cur.failingSince ?? Date.now(), error: e?.message ?? 'ошибка' };
    }),
  ), [source]);
  return st.source === source ? st : EMPTY;
}

// Часы для подписей давности: перерисовка, даже когда данные не меняются.
export function useNow(everyMs = 5000) {
  const [now, set] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => set(Date.now()), everyMs); return () => clearInterval(t); }, [everyMs]);
  return now;
}
