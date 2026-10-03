// Подменный git (гейт п.7): пишет свои аргументы строкой JSON в FAKE_GIT_LOG и отвечает
// на rev-parse содержимым FAKE_GIT_HEAD, на diff — содержимым FAKE_GIT_DIFF, на worktree — FAKE_GIT_WT,
// на status — FAKE_GIT_STATUS, на branch — FAKE_GIT_BRANCH (если заданы); merge-base выходит кодом из
// FAKE_GIT_MB_EXIT (по умолчанию 0). Больше ничего не делает.
import fs from 'node:fs';

const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_GIT_LOG, JSON.stringify(args) + '\n');
const c = args.indexOf('-C');
const sub = c >= 0 ? args[c + 2] : args[0];
const answer = { 'rev-parse': 'FAKE_GIT_HEAD', diff: 'FAKE_GIT_DIFF', worktree: 'FAKE_GIT_WT', status: 'FAKE_GIT_STATUS', branch: 'FAKE_GIT_BRANCH' }[sub];
if (answer && process.env[answer]) process.stdout.write(fs.readFileSync(process.env[answer], 'utf8'));
if (sub === 'merge-base') process.exitCode = Number(process.env.FAKE_GIT_MB_EXIT ?? 0);
