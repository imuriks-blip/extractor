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

// Ошибка не стирает прежние данные (2.7): data остаётся, failingSince — с первого сбоя подряд.
export function useSource(source) {
  const [st, set] = useState({ data: null, failingSince: null });
  useEffect(() => source.subscribe(
    (data) => set({ data, failingSince: null }),
    () => set((s) => (s.failingSince ? s : { ...s, failingSince: Date.now() })),
  ), [source]);
  return st;
}

// Часы для подписей давности: перерисовка, даже когда данные не меняются.
export function useNow(everyMs = 5000) {
  const [now, set] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => set(Date.now()), everyMs); return () => clearInterval(t); }, [everyMs]);
  return now;
}
