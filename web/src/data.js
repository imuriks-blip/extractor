// Источник данных экрана. Сейчас — опрос ручки раз в 5 с; в В8 его заменит поток событий сервера
// (SSE `changed {scope}` → перезапрос ручки): достаточно отдать новый источник с тем же subscribe().
import { useEffect, useState } from 'react';

// Источник: subscribe(onData, onError) → отписка.
export function pollSource(url, everyMs = 5000) {
  return {
    subscribe(onData, onError) {
      let stopped = false, timer = null, ctl = null;
      const tick = async () => {
        ctl = new AbortController();
        try {
          const r = await fetch(url, { cache: 'no-store', signal: ctl.signal });
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          const json = await r.json();
          if (!stopped) onData(json);
        } catch (e) {
          if (!stopped) onError(e);
        }
        if (!stopped) timer = setTimeout(tick, everyMs);
      };
      tick();
      return () => { stopped = true; clearTimeout(timer); ctl?.abort(); };
    },
  };
}

export const cehSource = pollSource('/api/ceh', 5000);

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
