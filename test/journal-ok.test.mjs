// Вердикт Голема на EXT-27, Важно 1: время последнего удачного чтения — у каждого журнала своё (для «устарело» треда).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createJournalReader } from '../lib/journal-reader.mjs';
import { tmpDir } from './helpers.mjs';

test('Важно 1: запертый журнал своё время удачного чтения не двигает; соседний и неизменившийся — двигают', async () => {
  const root = tmpDir('jok-');
  const pd = path.join(root, 'proj');
  fs.mkdirSync(pd);
  const line = JSON.stringify({ type: 'user', message: { role: 'user', content: 'заглушка' }, timestamp: '2026-10-02T10:00:00Z' }) + '\n';
  const A = path.join(pd, 'aaaaaaaa-0000-4000-8000-000000000001.jsonl');
  const B = path.join(pd, 'bbbbbbbb-0000-4000-8000-000000000002.jsonl');
  fs.writeFileSync(A, line);
  fs.writeFileSync(B, line);
  const t0 = Date.parse('2026-10-02T10:00:00Z');
  const clock = { t: t0 };
  let lockB = false;
  const wrapped = { ...fs, createReadStream: (p, o) => { if (lockB && p === B) throw Object.assign(new Error('заперт'), { code: 'EBUSY' }); return fs.createReadStream(p, o); } };
  const jr = createJournalReader({ root, indexDir: tmpDir('joki-'), fs: wrapped, now: () => new Date(clock.t) });
  const okAt = () => Object.fromEntries(jr.sessions().map((s) => [s.sessionId.slice(0, 8), s.okAt]));
  await jr.refresh();
  fs.appendFileSync(A, line);
  fs.appendFileSync(B, line);
  lockB = true;
  clock.t = t0 + 16 * 60000;
  await jr.refresh();
  assert.deepEqual(okAt(), { aaaaaaaa: new Date(clock.t).toISOString(), bbbbbbbb: new Date(t0).toISOString() });
  lockB = false;
  clock.t = t0 + 17 * 60000;
  await jr.refresh();
  await jr.refresh();
  assert.equal(okAt().aaaaaaaa, new Date(clock.t).toISOString(), 'исправный: журнал без новых строк читается — время идёт');
  assert.equal(okAt().bbbbbbbb, new Date(clock.t).toISOString());
});
