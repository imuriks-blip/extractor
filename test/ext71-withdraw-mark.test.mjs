// EXT-71, ПТ7б, §1.9 «Местная отметка»: у отозванного слова отметка (ring «отозвано…») для кнопок считается красной — строка (б)/(в)
// возвращается из «Отвечено, ждёт зеркала» в свою группу и в счётчик; исправный рядом — слово без отзыва — остаётся «отвечено».
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SID, boot, makeEnv, thread } from './ext71-harness.mjs';

test('отзыв слова по карточке в Review: строка снова в своей группе и в счётчике; слово без отзыва — «отвечено»; окно проекта — то же', async () => {
  const s = await boot(makeEnv(), { threads: [thread(SID, { card: 'EXT-22' })] });
  const view = async () => {
    const c = await s.get('/api/ceh');
    const p = await s.get('/api/project/EXT');
    return { row: c.waiting.review.find((x) => x.id === 'EXT-22') ?? c.waiting.yes.find((x) => x.id === 'EXT-22'), count: c.waiting.count + c.waiting.more,
      proj: p.waiting.find((x) => x.id === 'EXT-22' && x.group !== 'thread'), projCount: p.waitingCount.count + p.waitingCount.more };
  };
  const before = await view();
  assert.equal(before.row.answered, false, 'исходное: строка в своей группе');
  const w = await s.word('yes', 'EXT-22');
  assert.equal(w.outcome, 'ok', w.message);
  const sent = await view();
  assert.equal(sent.row.pultMark.ring, 'положено');
  assert.equal(sent.row.answered, true, 'исправный рядом: слово без отзыва — «Отвечено, ждёт зеркала»');
  assert.equal(sent.count, before.count - 1);
  assert.equal(sent.proj.answered, true);
  const wd = (await s.press({ action: 'withdraw', target: w.id })).json();
  assert.equal(wd.outcome, 'ok', wd.message);
  const back = await view();
  assert.equal(back.row.pultMark.ring, 'отозвано', 'отметка остаётся в данных со статусом «отозвано»');
  assert.equal(back.row.answered, false, 'отозванное слово — отметка как красная: строка в своей группе');
  assert.equal(back.count, before.count, 'и в счётчике');
  assert.equal(back.proj.answered, false, 'окно проекта: то же');
  assert.equal(back.projCount, before.projCount);
});
