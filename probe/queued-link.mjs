// Связь вложения queued_command (commandMode prompt) с последующей строкой user того же текста: какие поля
// совпадают, есть ли между ними строка assistant, сколько склеек дало бы окно 5 мин. Только числа, id и имена ключей.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { userText, isIvanMessage } from '../lib/journal-parse.mjs';

const ROOT = path.join(os.homedir(), '.claude', 'projects');
const hash = (s) => crypto.createHash('sha1').update(s).digest('hex');
const files = [];
for (const p of fs.readdirSync(ROOT)) for (const f of fs.readdirSync(path.join(ROOT, p))) if (f.endsWith('.jsonl')) files.push(path.join(ROOT, p, f));

let queued = 0;
const pairs = [];
const ids = (d) => ({ uuid: d.uuid, parentUuid: d.parentUuid, promptId: d.promptId, source_uuid: d.attachment?.source_uuid, sourceToolAssistantUUID: d.sourceToolAssistantUUID });
for (const f of files) {
  const L = fs.readFileSync(f, 'utf8').split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } });
  L.forEach((d, i) => {
    if (d?.type !== 'attachment' || d.attachment?.type !== 'queued_command' || d.attachment.commandMode !== 'prompt' || typeof d.attachment.prompt !== 'string') return;
    queued++;
    const h = hash(d.attachment.prompt);
    let assistantBetween = false;
    for (let j = i + 1; j < L.length; j++) {
      const x = L[j];
      if (!x) continue;
      if (x.type === 'assistant') assistantBetween = true;
      if (x.type === 'user' && isIvanMessage(x) && hash(userText(x)) === h) {
        const a = ids(d);
        const u = ids(x);
        const links = [];
        for (const [ka, va] of Object.entries(a)) for (const [ku, vu] of Object.entries(u)) if (va && va === vu) links.push(`вложение.${ka}=user.${ku}`);
        pairs.push({ file: path.basename(f).slice(0, 8), line: i + 1, userLine: j + 1, gapS: Math.round((Date.parse(x.timestamp) - Date.parse(d.timestamp)) / 1000), assistantBetween, links: links.join(' ') || 'нет', attKeys: Object.keys(d.attachment).sort().join(',') });
        break;
      }
    }
  });
}
console.log(`вложений queued_command с commandMode prompt (prompt строкой): ${queued}; за которыми есть строка user того же текста (до конца файла): ${pairs.length}`);
console.log(`склеек по старому правилу (окно 5 мин): ${pairs.filter((p) => p.gapS <= 300).length}`);
console.table(pairs);
