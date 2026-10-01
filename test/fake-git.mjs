// Подменный git (гейт п.7): пишет свои аргументы строкой JSON в FAKE_GIT_LOG и отвечает
// на rev-parse содержимым FAKE_GIT_HEAD, на diff — содержимым FAKE_GIT_DIFF. Больше ничего не делает.
import fs from 'node:fs';

const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_GIT_LOG, JSON.stringify(args) + '\n');
const c = args.indexOf('-C');
const sub = c >= 0 ? args[c + 2] : args[0];
if (sub === 'rev-parse') process.stdout.write(fs.readFileSync(process.env.FAKE_GIT_HEAD, 'utf8'));
else if (sub === 'diff') process.stdout.write(fs.readFileSync(process.env.FAKE_GIT_DIFF, 'utf8'));
