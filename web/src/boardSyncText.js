// Строка отправки доски на GitHub в шапке (EXT-99, спека витрины §2.12): уровень и причину считает сервер
// (/api/ceh → freshness.boardSync), здесь — только текст по таблице §2.12, класс строки и подсказка.
const p2 = (n) => String(n).padStart(2, '0');
const hhmm = (s) => {
  const d = new Date(s);
  return s && Number.isFinite(d.getTime()) ? `${p2(d.getHours())}:${p2(d.getMinutes())}` : '—';
};
const ddmm = (s) => {
  const d = new Date(s);
  return s && Number.isFinite(d.getTime()) ? `${p2(d.getDate())}.${p2(d.getMonth() + 1)} ${hhmm(s)}` : 'нет';
};
const n = (v) => (Number.isInteger(v) ? v : '?');
const BY = { extractor: 'витрина', hook: 'конец сессии', manual: 'Планировщик или руками' };
const CLS = { red: 'fresh-bad', yellow: 'fresh-warn' };
const WHY = {
  ok: 'всё отправлено', pending: 'коммиты ждут отправки', behind: 'коммиты давно не отправлены', net: 'отправка не удаётся — причина в .board-sync.json',
  'push-off': 'push: false в board.config.json', inbox: 'входящие с телефона похожи на секрет', unread: 'состояние отправки не читается',
  conflict: 'конфликт при слиянии с GitHub', dirty: 'правка файлов доски мимо board', hold: 'картинки задержаны до твоего взгляда',
  rebase: 'доска посреди перебазирования или слияния', unknown: 'нет origin/main — отставание неизвестно',
};

function textOf(f) {
  const tail = f.level === 'red' ? ' — проверь' : '';
  switch (f.why) {
    case 'ok': return `на GitHub · ${hhmm(f.lastOkAt)}`;
    case 'pending': return `на GitHub · ${hhmm(f.lastOkAt)} · ждут отправки: ${n(f.ahead)}`;
    case 'behind': return `не отправлено ${n(f.ahead)} · с ${hhmm(f.oldestAheadAt)}${tail}`;
    case 'net': return `отправка не удаётся с ${hhmm(f.errorSince)} · не отправлено ${n(f.ahead)}${tail}`;
    case 'push-off': return 'отправка выключена (push: false)';
    case 'inbox': return `входящие не приняты: ${n(f.inboxBlocked)} — похоже на секрет`;
    case 'unread': return 'состояние отправки не читается';
    case 'conflict': return `не отправляется: конфликт ${(f.conflictIds ?? []).join(', ') || '?'} — решает владелец`;
    case 'dirty': return 'не отправляется: правка мимо board — зови дирижёра';
    case 'hold': return 'не отправляется: картинки ждут твоего взгляда';
    case 'rebase': return 'доска посреди перебазирования — зови дирижёра';
    case 'unknown': return `на GitHub · ${hhmm(f.lastOkAt)} · отставание неизвестно`;
    default: return null;
  }
}

// → {text, cls, title} | null (режим не live, уровня нет)
export function boardSyncLine(f) {
  if (!f || !f.level) return null;
  const text = textOf(f);
  if (!text) return null;
  const by = f.by ? ` (${BY[f.by] ?? f.by})` : '';
  const title = `Отправка доски на GitHub. Последняя удачная: ${ddmm(f.lastOkAt)}${f.lastOkAt ? by : ''} · не отправлено: ${n(f.ahead)} · ${WHY[f.why] ?? f.why}`;
  return { text, cls: CLS[f.level] ?? '', title };
}
