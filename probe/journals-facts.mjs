// Факты для ревью В2 (EXT-26, вердикт Голема: Важно 3–6). Только чтение ~/.claude; печатает числа и id, без текстов.
// node probe/journals-facts.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { newAgentState, feedAgent, isConductorMessage, userText, PARTIAL_RE } from '../lib/journal-parse.mjs';

const HOME = os.homedir();
const ROOT = path.join(HOME, '.claude', 'projects');
const hash = (s) => crypto.createHash('sha1').update(s).digest('hex');
const tag = (s, t) => s.match(new RegExp(`<${t}>([^<]*)</${t}>`))?.[1]?.trim() ?? null;
const readJsonl = (f) => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

const sessions = [];
const subs = new Map(); // agentId → путь журнала субагента
for (const p of fs.readdirSync(ROOT)) {
  const pd = path.join(ROOT, p);
  for (const f of fs.readdirSync(pd)) {
    if (f.endsWith('.jsonl')) sessions.push({ id: f.slice(0, -6), file: path.join(pd, f) });
    const sd = path.join(pd, f, 'subagents');
    if (fs.existsSync(sd)) for (const g of fs.readdirSync(sd)) { const m = g.match(/^agent-(\w+)\.jsonl$/); if (m && !subs.has(m[1])) subs.set(m[1], path.join(sd, g)); }
  }
}
const maxTurns = {};
for (const f of fs.readdirSync(path.join(HOME, '.claude', 'agents')).filter((x) => x.endsWith('.md'))) {
  const m = fs.readFileSync(path.join(HOME, '.claude', 'agents', f), 'utf8').match(/^maxTurns:\s*(\d+)/m);
  if (m) maxTurns[f.slice(0, -3)] = Number(m[1]);
}
const notifText = (d) => (d.type === 'attachment' && d.attachment?.type === 'queued_command' && typeof d.attachment.prompt === 'string' ? d.attachment.prompt
  : d.type === 'user' ? userText(d) : null);

// ход за ходом журнала субагента: границы заходов с временем и ходы каждого захода по правилу кода
function zakhodsOf(agentId) {
  const f = subs.get(agentId);
  if (!f) return null;
  const st = newAgentState();
  const bounds = [];
  let lastAssistantAt = null;
  for (const d of readJsonl(f)) {
    if (isConductorMessage(d)) bounds.push(d.timestamp);
    if (d.type === 'assistant') lastAssistantAt = d.timestamp;
    feedAgent(st, d);
  }
  return { zakhods: st.zakhods, bounds, lastAt: st.lastAt, lastAssistantAt };
}

const v3 = { agentIdAfterCont: [], oldContIdAfterNewer: [] };
const v4partial = [];
const v4live = [];
const v6 = { total: 0, notLt: 0, followed: 0, notFollowed: 0, followedKinds: {}, modes: {}, renderedInHumanTurn: 0 };
const v4count = [];
const endsByAgent = new Map(); // agentId → [{session, kind}]
const runInfo = new Map(); // `${session}/${agent}` → {type, contStarts, liveMsgs}

for (const s of sessions) {
  const L = readJsonl(s.file);
  const pend = {};
  const runs = {};
  L.forEach((d, i) => {
    const c = d.message?.content;
    if (d.type === 'assistant' && Array.isArray(c)) for (const p of c) if (p.type === 'tool_use') pend[p.id] = { name: p.name, input: p.input, at: d.timestamp };
    if (d.type === 'user' && Array.isArray(c)) for (const p of c) if (p.type === 'tool_result' && pend[p.tool_use_id]) {
      const u = pend[p.tool_use_id];
      const tr = typeof d.toolUseResult === 'object' && d.toolUseResult ? d.toolUseResult : {};
      if (u.name === 'Agent' && tr.agentId && !p.is_error) runs[tr.agentId] = { type: u.input?.subagent_type, agentUse: p.tool_use_id, starts: [p.tool_use_id], live: [], partial: [] };
      if (u.name === 'SendMessage' && !p.is_error && runs[u.input?.to]) {
        const r = runs[u.input.to];
        if (tr.resumedAgentId) r.starts.push(p.tool_use_id); else r.live.push(d.timestamp);
      }
    }
    // Важно 6: вложения queued_command
    if (d.type === 'attachment' && d.attachment?.type === 'queued_command' && typeof d.attachment.prompt === 'string') {
      v6.total++;
      if (!d.attachment.prompt.trimStart().startsWith('<')) {
        v6.notLt++;
        const md = String(d.attachment.commandMode ?? '-'); v6.modes[md] = (v6.modes[md] ?? 0) + 1;
        if (d.renderedInHumanTurn) v6.renderedInHumanTurn++;
        const h = hash(d.attachment.prompt);
        const next = L.slice(i + 1, i + 40).find((x) => x.type === 'user' && typeof userText(x) === 'string' && hash(userText(x)) === h);
        if (next) { v6.followed++; const k = `origin=${next.origin?.kind ?? '-'} meta=${!!next.isMeta}`; v6.followedKinds[k] = (v6.followedKinds[k] ?? 0) + 1; } else v6.notFollowed++;
      }
    }
    const t = notifText(d);
    if (t && t.trimStart().startsWith('<task-notification>')) {
      const id = tag(t, 'task-id');
      const tu = tag(t, 'tool-use-id');
      if (id) { if (!endsByAgent.has(id)) endsByAgent.set(id, []); endsByAgent.get(id).push({ session: s.id.slice(0, 8), kind: 'notification' }); }
      const r = runs[id];
      if (r && tu) {
        if (tu === r.agentUse && r.starts.length > 1) v3.agentIdAfterCont.push(`${s.id.slice(0, 8)}/${id} (${d.type}, продолжений до него ${r.starts.length - 1})`);
        else if (r.starts.indexOf(tu) > 0 && r.starts.indexOf(tu) < r.starts.length - 1) v3.oldContIdAfterNewer.push(`${s.id.slice(0, 8)}/${id}`);
      }
      const m = t.match(PARTIAL_RE);
      if (m && r) r.partial.push({ limit: Number(m[1]), at: d.timestamp, where: 'notification' });
    }
    if (d.origin?.kind === 'peer' && d.origin.from) { if (!endsByAgent.has(d.origin.from)) endsByAgent.set(d.origin.from, []); endsByAgent.get(d.origin.from).push({ session: s.id.slice(0, 8), kind: 'handback' }); }
    if (d.type === 'user' && Array.isArray(c)) for (const p of c) if (p.type === 'tool_result') {
      const u = pend[p.tool_use_id];
      const tr = typeof d.toolUseResult === 'object' && d.toolUseResult ? d.toolUseResult : {};
      const txt = typeof p.content === 'string' ? p.content : Array.isArray(p.content) ? p.content.map((q) => q.text ?? '').join('\n') : '';
      const m = txt.match(PARTIAL_RE);
      if (m && u?.name === 'Agent' && runs[tr.agentId]) runs[tr.agentId].partial.push({ limit: Number(m[1]), at: d.timestamp, where: 'Agent' });
    }
  });
  for (const [id, r] of Object.entries(runs)) {
    runInfo.set(`${s.id}/${id}`, { ...r, session: s.id, lastLineAt: L.at(-1)?.timestamp ?? L.findLast((x) => x.timestamp)?.timestamp });
    // Важно 4а: обрыв — N против ходов захода, в котором оборвался (по правилу кода)
    for (const p of r.partial) {
      const z = zakhodsOf(id);
      if (!z) { v4partial.push(`${s.id.slice(0, 8)}/${id}: N=${p.limit}, журнала субагента нет`); continue; }
      const idx = z.bounds.filter((b) => b <= p.at).length - 1;
      v4partial.push(`${s.id.slice(0, 8)}/${id} ${r.type}: N=${p.limit} (${p.where}), заход №${idx + 1} из ${z.zakhods.length}, ходов в нём ${z.zakhods[idx]}, все заходы [${z.zakhods.join(',')}]`);
    }
    // Важно 4б: SendMessage живому агенту — граница ли захода для тормоза
    if (r.live.length) {
      const z = zakhodsOf(id);
      if (!z) continue;
      v4count.push(`${s.id.slice(0, 8)}/${id} ${r.type}: продолжений ${r.starts.length - 1} + сообщений живому ${r.live.length} = ${r.starts.length - 1 + r.live.length}; границ после ТЗ в журнале субагента ${z.bounds.length - 1}; заходы [${z.zakhods.join(',')}]`);
      for (const at of r.live) {
        const bi = z.bounds.findIndex((b) => b >= at && Date.parse(b) - Date.parse(at) < 120000);
        if (bi <= 0) { v4live.push(`${s.id.slice(0, 8)}/${id} ${r.type}: граница в журнале субагента не найдена`); continue; }
        const before = z.zakhods[bi - 1];
        const after = z.zakhods[bi];
        const brake = maxTurns[r.type];
        v4live.push(`${s.id.slice(0, 8)}/${id} ${r.type}: до сообщения ${before} ходов, после ${after}, вместе ${before + after}, тормоз ${brake ?? '?'}, обрыв в запуске: ${r.partial.length ? 'да' : 'нет'}${brake && before + after > brake + 1 && !r.partial.length ? ' → вместе больше тормоза без обрыва: сообщение обнулило запас' : ''}`);
      }
    }
  }
}

// Важно 5: «без распознанного конца» — список из читателя, раскладка по признакам
const live = new Set();
for (const f of fs.readdirSync(path.join(HOME, '.claude', 'sessions')).filter((x) => /^\d+\.json$/.test(x))) {
  try { const j = JSON.parse(fs.readFileSync(path.join(HOME, '.claude', 'sessions', f), 'utf8')); if (j.sessionId) live.add(j.sessionId); } catch { /* занят или битый */ }
}
const { createJournalReader } = await import('../lib/journal-reader.mjs');
const rules = JSON.parse(fs.readFileSync(new URL('../config.default.json', import.meta.url), 'utf8')).boardWriteTools;
const reader = createJournalReader({ root: ROOT, indexDir: fs.mkdtempSync(path.join(os.tmpdir(), 'vf-')), rules });
await reader.refresh();
const v5 = [];
for (const s of reader.sessions()) for (const r of s.runs.filter((x) => x.alive)) {
  const z = zakhodsOf(r.agentId);
  const info = runInfo.get(`${s.sessionId}/${r.agentId}`);
  const elsewhere = (endsByAgent.get(r.agentId) ?? []).filter((e) => e.session !== s.sessionId.slice(0, 8));
  const agentAfterSession = z?.lastAt && info?.lastLineAt ? (Date.parse(z.lastAt) > Date.parse(info.lastLineAt) ? 'агент писал после последней строки сессии' : `сессия писала ещё ${Math.round((Date.parse(info.lastLineAt) - Date.parse(z.lastAt)) / 60000)} мин после последней строки агента`) : 'нет журнала субагента';
  v5.push(`${s.sessionId.slice(0, 8)}/${r.agentId} ${r.agentType}: сессия жива=${live.has(s.sessionId)}; ${agentAfterSession}; итог в другой сессии=${elsewhere.length ? elsewhere.map((e) => e.session + ':' + e.kind).join(',') : 'нет'}; уведомление с id Agent после продолжения=${v3.agentIdAfterCont.some((x) => x.includes(r.agentId)) ? 'да' : 'нет'}`);
}

console.log(`Важно 3: уведомлений с tool-use-id исходного Agent после продолжения: ${v3.agentIdAfterCont.length}`);
v3.agentIdAfterCont.forEach((x) => console.log('  ' + x));
console.log(`        уведомлений с id прежнего продолжения после нового: ${v3.oldContIdAfterNewer.length}`); v3.oldContIdAfterNewer.forEach((x) => console.log('  ' + x));
console.log(`Важно 4а: обрывы (${v4partial.length}):`); v4partial.forEach((x) => console.log('  ' + x));
console.log(`Важно 4б: SendMessage живому агенту (без resumedAgentId): ${v4live.length}`); v4live.forEach((x) => console.log('  ' + x));
console.log('Важно 4б, счёт границ:'); v4count.forEach((x) => console.log('  ' + x));
console.log(`Важно 5: без распознанного конца: ${v5.length}; живых сессий в ~/.claude/sessions: ${live.size}`); v5.forEach((x) => console.log('  ' + x));
console.log(`Важно 6: queued_command всего ${v6.total}; prompt не с «<»: ${v6.notLt}; из них за ним строка user с тем же текстом (хеш): ${v6.followed}, без такой строки: ${v6.notFollowed}; виды: ${JSON.stringify(v6.followedKinds)}; commandMode: ${JSON.stringify(v6.modes)}; renderedInHumanTurn: ${v6.renderedInHumanTurn}`);
