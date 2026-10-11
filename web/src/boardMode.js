// Режим доски для страницы (EXT-91 такт 3, спека пульта §3.3 п.15–16): 'mirror' | 'live' | null (неясный — вид как в mirror).
// Приходит в /api/ceh полем boardMode; App кладёт его сюда, чтобы строки и кнопки глубоко в дереве (Pult.jsx) не тянули проп.
import { useSyncExternalStore } from 'react';

let mode = null;
const subs = new Set();

export function setBoardMode(m) {
  const next = m === 'live' || m === 'mirror' ? m : null;
  if (next === mode) return;
  mode = next;
  subs.forEach((f) => f());
}

export const isLiveMode = () => mode === 'live';
export const useBoardMode = () => useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => mode);
