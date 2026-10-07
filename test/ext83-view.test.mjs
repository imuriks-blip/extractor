// EXT-83, ПТ8б, такт 2 (экран): чистые функции вида «Рабочих копий» (web/src/worktreesData.js) — строки списка, подписи
// «годна» / «разбери руками», ответ первого щелчка (окно подтверждения со списком сервера), итог второго, отказы.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WT_CONFIRM_MS, WT_URL, finalAnswer, firstAnswer, isManual, wtCounts, wtName, wtRows } from '../web/src/worktreesData.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (f) => fs.readFileSync(path.join(ROOT, 'web', 'src', f), 'utf8');
const row = (o) => ({ repo: 'C:/r', path: 'C:/r-ext-1', branch: 'ext-1-x', card: 'EXT-1', eligible: false, reason: 'не слита', ignored: [], ...o });

test('строки: годна — подпись «годна»; «разбери руками» — подпись и признак; обычный отказ — без подписи', () => {
  const rows = wtRows([
    row({ path: 'C:/p/a', eligible: true, reason: 'слита, карточка EXT-501 закрыта, чистая' }),
    row({ path: 'C:/p/b', reason: 'внутри ссылка — разбери руками' }),
    row({ path: 'C:/p/c', reason: 'есть игнорируемые: .env — разбери руками', ignored: ['.env'] }),
    row({ path: 'C:/p/d', reason: 'не слита' }),
  ]);
  assert.deepEqual(rows.map((r) => r.badge), ['годна', 'разбери руками', 'разбери руками', null]);
  assert.deepEqual(rows.map((r) => r.manual), [false, true, true, false]);
  assert.equal(rows[0].name, 'a');
  assert.deepEqual(wtCounts([row({ eligible: true }), row({ path: 'x' })]), { total: 2, ok: 1 });
  assert.equal(isManual(row({ eligible: true, reason: 'разбери руками' })), false, 'годная не просит разбирать');
  assert.deepEqual(wtRows(null), []);
  assert.equal(wtName(String.raw`C:\a\b-wt\\`.slice(0, -1)), 'b-wt');
});

test('адрес: по проекту — ?project=, «Цех» — без', () => {
  assert.equal(WT_URL('EXT'), '/api/worktrees?project=EXT');
  assert.equal(WT_URL(undefined), '/api/worktrees');
  assert.equal(WT_CONFIRM_MS, 300000);
});

test('первый щелчок: need-confirm → окно со списком сервера; ok → строка-итог без окна', () => {
  const a = firstAnswer(200, { outcome: 'need-confirm', id: 'id1', confirm: { what: '«Прибери…»', follows: 'уберу 2 копии: a, b; ветки остаются', mirrorAt: '2026-10-07T10:00:00Z',
    candidates: [{ repo: 'R', path: 'C:/p/a', branch: 'ext-1-a', card: 'EXT-1' }, { repo: 'R', path: 'C:/p/b', branch: 'ext-2-b', card: null }] } });
  assert.equal(a.kind, 'confirm');
  assert.equal(a.id, 'id1');
  assert.deepEqual(a.candidates.map((c) => [c.name, c.branch, c.card]), [['a', 'ext-1-a', 'EXT-1'], ['b', 'ext-2-b', null]]);
  const b = firstAnswer(200, { outcome: 'ok', message: 'убирать нечего (3 пропущено: не слита)' });
  assert.deepEqual(b, { kind: 'done', cls: 'pmark', text: 'убирать нечего (3 пропущено: не слита)' });
});

test('итог второго щелчка: ok — спокойный, partial — янтарный, отказы и ошибки — по виду', () => {
  assert.equal(finalAnswer(200, { outcome: 'ok', message: 'убрано 2, пропущено 0' }).cls, 'pmark');
  assert.deepEqual(finalAnswer(200, { outcome: 'partial', message: 'убрано 1, пропущено 0; ошибок 1' }), { cls: 'pamb', text: 'убрано 1, пропущено 0; ошибок 1' });
  assert.equal(finalAnswer(200, { outcome: 'refused', refusal: 'confirm-expired' }).text, 'подтверждение просрочено — нажми заново');
  assert.equal(finalAnswer(200, { outcome: 'refused', refusal: 'bad-confirm' }).cls, 'pamb');
  assert.deepEqual(finalAnswer(409, { outcome: 'refused', refusal: 'cleanup-running' }), { cls: 'pamb', text: 'уборка уже идёт — подожди' });
  assert.equal(finalAnswer(200, { outcome: 'refused', refusal: 'other', message: 'нельзя' }).cls, 'pbad');
  assert.equal(finalAnswer(500, { outcome: 'error', message: 'git отказал' }).cls, 'pbad');
  assert.match(finalAnswer(502, {}).text, /HTTP 502/);
});

test('экран: второй щелчок один (серверный) — локальной панели нет; окно проекта и «Цех» смонтированы, источник по проекту', () => {
  const w = src('Words.jsx');
  assert.ok(!/ph === 'confirm' \? \(\s*<span className="cfm"/.test(w), 'локальная панель убрана');
  assert.match(w, /\{ action: 'cleanup', intentId: crypto\.randomUUID\(\), \.\.\.\(confirm \? \{ confirm \} : \{\}\), \.\.\.\(project \? \{ project \} : \{\}\) \}/);
  assert.match(src('Project.jsx'), /<Worktrees project=\{code\} \/>/);
  assert.match(src('Ceh.jsx'), /<Worktrees \/>/);
});
