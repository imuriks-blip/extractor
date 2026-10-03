// Подменный plane.py (ПТ3, EXT-43): тот же вывод и коды, что у C:\projects\_plane-rest\plane.py (строка документации):
//   show <ID> [--last] · comment <html> <ID> · state <ID> <статус>. Запускается как `node fake-plane.mjs …` —
// витрина зовёт его настройкой pult.python = node, pult.planePy = путь к копии этого файла. Состояние карточки —
// state.json рядом с копией: {status, title, comments: [{id, created_at, html}], fail: {comment, state}, clock, calls}.
// fail.comment: 'refuse' — код 1, коммента нет; 'unclear-after' — коммент лёг, код 3; 'unclear-before' — код 3, коммента нет.
// fail.state: 'net' — трасса Python в stderr, код 1; 'mismatch' — код 0 и «НЕ совпал». Каждый вызов — в calls.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const file = path.join(path.dirname(fileURLToPath(import.meta.url)), 'state.json');
const st = JSON.parse(fs.readFileSync(file, 'utf8'));
const args = process.argv.slice(2);
st.calls = [...(st.calls ?? []), args];
const save = () => fs.writeFileSync(file, JSON.stringify(st, null, 2));
const out = (s) => process.stdout.write(s + '\n');
const err = (s) => process.stderr.write(s + '\n');
const fail = st.fail ?? {};
let n = st.seq ?? 0;
const now = () => st.clock ?? new Date().toISOString().replace('Z', '123Z');
// как plain() у plane.py: блочные теги → пробел, прочие прочь, сущности, пробелы схлопнуть
const plain = (h) => String(h ?? '').replace(/<(?:br|hr|\/?(?:p|div|li|ul|ol|h[1-6]|blockquote|pre))\b[^>]*>/gi, ' ').replace(/<[^>]*>/g, '')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

const [cmd] = args;
if (cmd === 'show') {
  out(`${args[1]} · ${st.status} · ${st.title ?? 'Карточка'}`);
  if (args.includes('--last')) {
    const last = [...(st.comments ?? [])].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at)).at(-1);
    out(last ? `последний коммент · ${last.created_at} · ${plain(last.html).slice(0, 80) || '(без текста)'}` : 'комментов нет');
  }
} else if (cmd === 'comment') {
  const [, html, ref] = args;
  if (fail.comment === 'refuse') { save(); err('Доска ответила 429: {"error":"rate limited"}'); process.exit(1); }
  if (fail.comment === 'unclear-before') { save(); err('неясный исход: таймаут'); process.exit(3); }
  const c = { id: `c${++n}`, created_at: now(), html };
  st.seq = n;
  st.comments = [...(st.comments ?? []), c];
  save();
  if (fail.comment === 'unclear-after') { err('неясный исход: таймаут'); process.exit(3); }
  out(`${ref} · коммент ${c.id} · ${c.created_at}`);
} else if (cmd === 'state') {
  const [, ref, name] = args;
  if (fail.state === 'net') {
    save();
    err('Traceback (most recent call last):');
    err('  File "C:\projects\_plane-rest\plane.py", line 175, in main');
    err('requests.exceptions.ConnectionError: HTTPSConnectionPool(host=\'board.example\', port=443)');
    process.exit(1);
  }
  if (fail.state !== 'mismatch') st.status = name;
  save();
  out(`${ref} → ${name} (state ${fail.state === 'mismatch' ? 'НЕ совпал' : 'подтверждён'})`);
} else {
  save();
  err('использование');
  process.exit(1);
}
save();
