'use strict';

/* Данные: window.CLASSIFIER из data.js (генерируется tools/build_data.py). */
const DATA = window.CLASSIFIER || { groups: [] };
const GROUPS = DATA.groups;
const TOPICS = [];
const BY_ID = new Map();
const BACKLINKS = new Map();      // id темы → темы, где она указана в «Не путать»

for (const g of GROUPS) {
  BY_ID.set(g.id, g);
  g.topics.forEach(t => {
    t.group = g;
    t.subIdx = t.sub ? g.subs.findIndex(s => s.name === t.sub) : -1;
    TOPICS.push(t);
    BY_ID.set(t.id, t);
  });
}
for (const t of TOPICS) {
  for (const c of t.conf) {
    if (!c.ref) continue;
    if (!BACKLINKS.has(c.ref)) BACKLINKS.set(c.ref, []);
    if (!BACKLINKS.get(c.ref).includes(t)) BACKLINKS.get(c.ref).push(t);
  }
}

const $ = sel => document.querySelector(sel);
const view = $('#view');
const sidebar = $('#sidebar');
const input = $('#q');

/* ---------- утилиты ---------- */

function esc(s) {
  return String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

/* \u0002…\u0003 в данных — жирный текст */
function rich(s, hl) {
  let html = esc(s);
  if (hl) html = highlight(html, hl);
  return html.replace(/\u0002/g, '<strong>').replace(/\u0003/g, '</strong>');
}

function plain(s) {
  return s.replace(/[\u0002\u0003]/g, '');
}

function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
  return many;
}

const topicsWord = n => n + ' ' + plural(n, 'тема', 'темы', 'тем');

function copyString(t) {
  return 'Группа тем/тема - "' + t.group.name + '" / "' + t.name + '"';
}

try { localStorage.removeItem('klassiki-recent'); } catch (e) { /* недавние темы больше не ведутся */ }

const store = {
  get(key, def) {
    try { const v = localStorage.getItem('klassiki-' + key); return v ? JSON.parse(v) : def; } catch (e) { return def; }
  },
  set(key, val) {
    try { localStorage.setItem('klassiki-' + key, JSON.stringify(val)); } catch (e) { /* приватный режим */ }
  },
};

/* ---------- поиск ---------- */

const STOP = new Set(['и', 'в', 'во', 'на', 'с', 'со', 'по', 'от', 'для', 'из', 'за', 'к', 'о', 'об', 'или', 'а',
  'не', 'при', 'до', 'у', 'что', 'как', 'это', 'то', 'же', 'ли', 'бы', 'нет', 'да', 'так', 'уже', 'еще', 'мы', 'вы',
  'я', 'он', 'она', 'они', 'наш', 'нас', 'нам', 'вам', 'мне', 'меня', 'все', 'всё', 'тт', 'т', 'ч',
  // типичные «вежливые» и вопросительные слова из обращений
  'когда', 'где', 'почему', 'зачем', 'сколько', 'кто', 'будет', 'будут', 'можно', 'нужно', 'надо', 'очень',
  'просто', 'вообще', 'подскажите', 'пожалуйста', 'здравствуйте', 'добрый', 'день', 'вечер', 'спасибо',
  'помогите', 'опять', 'снова', 'сегодня', 'вчера', 'ещё', 'этот', 'эта', 'эти', 'там', 'тут']);

function norm(s) {
  return plain(s).toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]+/g, ' ').trim();
}

/* Грубый стемминг: отрезаем типичные окончания, дальше ищем слова, начинающиеся с основы */
const ENDINGS = new RegExp('(' + [
  'иями', 'ями', 'ами', 'ого', 'его', 'ому', 'ему', 'ыми', 'ими', 'иях', 'ях', 'ах',
  'или', 'ыли', 'али', 'яли', 'ели', 'ила', 'ала', 'ыла', 'ило', 'ают', 'яют', 'еют', 'уют', 'ует',
  'ют', 'ят', 'ат', 'ет', 'ит', 'ил', 'ал', 'ел', 'ла', 'ли', 'ло',
  'ов', 'ев', 'ей', 'ой', 'ий', 'ый', 'ая', 'яя', 'ое', 'ее', 'ые', 'ие', 'ую', 'юю', 'ам', 'ям', 'ом', 'ем',
  'ия', 'ию', 'ья', 'ье', 'ью', 'ть', 'а', 'я', 'о', 'е', 'ы', 'и', 'у', 'ю', 'ь',
].join('|') + ')$');

function stem(w) {
  if (/\d/.test(w) || w.length <= 2) return w;
  if (w.length === 3) return /[аеиоуыэюяь]$/.test(w) ? w.slice(0, 2) : w;   // «яма» → «ям», «газ» → «газ»
  let s = w.replace(ENDINGS, '');
  if (s.length < 3) s = w.slice(0, 3);
  if (s.length > 7) s = s.slice(0, s.length - 1);   // «электричества» → «электричест»
  return s;
}

/* Разговорные слова → как это названо в классификаторе (по началу основы) */
const SYNONYMS = [
  [/^свет/, ['электр', 'освещ']],
  [/^ребен|^ребят|^дочь|^доч|^сын/, ['дет']],
  [/^зарплат/, ['заработн']],
  [/^мусор/, ['тко', 'отход']],
  [/^врач/, ['медицин', 'медработ']],
  [/^больниц|^поликлин/, ['медицин', 'здравоохран']],
  [/^школ/, ['образоват', 'сош']],
  [/^садик|^детсад/, ['доу', 'детск']],
  [/^маршрутк|^автобус|^трамва|^троллейб/, ['транспорт', 'маршрут']],
  [/^батаре/, ['отоплен']],
  [/^коммуналк|^квартплат/, ['жку', 'коммунальн']],
  [/^ям$|^выбоин/, ['ям', 'выбоин']],
  [/^пенси/, ['пенсионер']],
  [/^военкомат/, ['военкомат', 'призыв']],
];

function variants(st) {
  const out = [];
  for (const [re, extra] of SYNONYMS) if (re.test(st)) out.push(...extra);
  // глагольные приставки: «отремонтируют» → «ремонт…», «вывозят» → «воз…» не трогаем (слишком коротко)
  const m = st.match(/^(пере|от|по|за|вы|на|при|до|об|пр)(.{5,})$/);
  if (m) out.push(m[2]);
  return out.filter(v => v !== st);
}

/* слово подходит к основе: начинается с неё, либо само является началом длинной основы (≥5 букв) */
function fits(w, st) {
  return w.startsWith(st) || (w.length >= 5 && st.startsWith(w));
}

function blocksText(blocks) {
  return blocks.map(b => b.text).join(' ');
}

for (const t of TOPICS) {
  t.ix = {
    title: norm(t.name),
    ctx: norm(t.group.name + ' ' + (t.sub || '')),
    must: norm(blocksText(t.must)),
    conf: norm(t.conf.map(c => c.text).join(' ') + ' ' + (t.confNote || '')),
    notes: '',
  };
  t.ixWords = {};
  for (const f in t.ix) t.ixWords[f] = t.ix[f].split(' ');
}

const WEIGHTS = { title: 12, ctx: 4, must: 3, notes: 2, conf: 1 };

function parseQuery(q) {
  let words = norm(q).split(' ').filter(Boolean);
  const meaningful = words.filter(w => !STOP.has(w));
  if (meaningful.length) words = meaningful;
  return [...new Set(words)].map(w => {
    const st = stem(w);
    return { word: w, stem: st, alt: variants(st) };
  });
}

function termScore(t, term) {
  let best = 0;
  for (const f in WEIGHTS) {
    let hits = 0, exact = false, alt = false;
    for (const w of t.ixWords[f]) {
      if (fits(w, term.stem)) { hits++; if (w === term.word) exact = true; }
      else if (term.alt.some(a => fits(w, a))) { hits++; alt = true; }
    }
    if (hits) best = Math.max(best, WEIGHTS[f] * (exact ? 1.3 : alt && hits === 1 ? 0.8 : 1) + Math.min(hits, 4) * 0.2);
  }
  return best;
}

/* Ранжирование: редкие слова весят больше (idf), темы с бо́льшей долей совпавших слов — выше.
   Запрос живым языком («собаки бегают стаями во дворе») не требует совпадения всех слов. */
function search(q) {
  const terms = parseQuery(q);
  if (!terms.length) return { terms, results: [], partial: false };
  const phrase = norm(q);
  const N = TOPICS.length;
  const per = TOPICS.map(t => terms.map(term => termScore(t, term)));
  terms.forEach((term, i) => {
    const df = per.reduce((n, row) => n + (row[i] ? 1 : 0), 0);
    term.idf = df ? Math.log(1 + N / df) : 0;
  });
  const idfSum = terms.reduce((a, t) => a + t.idf, 0) || 1;
  const scored = [];
  TOPICS.forEach((t, k) => {
    let score = 0, cover = 0, matched = 0;
    terms.forEach((term, i) => {
      if (!per[k][i]) return;
      matched++;
      cover += term.idf;
      score += per[k][i] * term.idf;
    });
    if (!matched) return;
    cover /= idfSum;
    if (terms.length > 1 && phrase.length > 3) {
      if (t.ix.title.includes(phrase)) score += 40;
      else if (t.ix.must.includes(phrase)) score += 15;
    }
    if (t.ix.title.startsWith(terms[0].stem)) score += 3;
    scored.push({ t, score: score * (0.25 + cover * cover), matched, cover });
  });
  const full = scored.filter(r => r.matched === terms.length);
  const minCover = terms.length > 2 ? 0.3 : 0;
  const results = scored.filter(r => r.cover >= minCover || r.matched === terms.length);
  results.sort((a, b) => b.score - a.score || a.t.name.localeCompare(b.t.name, 'ru'));
  return { terms, results, partial: !full.length && terms.length > 1 };
}

/* подсветка слов, начинающихся со стеммов запроса (е/ё не различаются) */
function highlight(html, terms) {
  if (!terms || !terms.length) return html;
  const parts = terms.flatMap(t => [t.stem, ...t.alt]).map(x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/е/g, '[её]'));
  const re = new RegExp('(^|[^a-zа-яё0-9])((?:' + parts.join('|') + ')[a-zа-яё0-9]*)', 'giu');
  return html.split(/(<[^>]+>|&[a-z#0-9]+;)/i).map(chunk =>
    chunk.startsWith('<') || chunk.startsWith('&') ? chunk : chunk.replace(re, '$1<mark>$2</mark>')
  ).join('');
}

function snippet(t, terms) {
  const text = plain(blocksText(t.must));
  const lower = text.toLowerCase().replace(/ё/g, 'е');
  let pos = -1;
  for (const term of terms) {
    const re = new RegExp('(^|[^a-zа-я0-9])' + term.stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'u');
    const m = re.exec(lower);
    if (m && (pos === -1 || m.index < pos)) pos = m.index + m[1].length;
  }
  const LEN = 220;
  if (pos === -1 || text.length <= LEN) return { text: text.slice(0, LEN), cut: text.length > LEN, lead: false };
  let start = Math.max(0, pos - 60);
  if (start > 0) {
    const sp = text.indexOf(' ', start);
    if (sp !== -1 && sp < pos) start = sp + 1;
  }
  return { text: text.slice(start, start + LEN), cut: start + LEN < text.length, lead: start > 0 };
}

/* ---------- боковая панель ---------- */

function renderSidebar(active) {
  const activeGroup = active && (active.group || (active.topics ? active : null));
  let html = '<div class="side-head"><a href="#/" class="side-all">Все группы</a>' +
    '<span class="side-count">' + GROUPS.length + ' групп · ' + TOPICS.length + ' тем</span></div><ul class="side-list">';
  for (const g of GROUPS) {
    const open = activeGroup === g;
    html += '<li class="side-group' + (open ? ' open' : '') + '" style="--gc:' + g.color + '">' +
      '<a href="#/g/' + g.id + '" class="side-link' + (active === g ? ' current' : '') + '">' +
      '<span class="dot"></span><span class="side-title">' + esc(g.title) + '</span>' + ncHtml(g.id) +
      '<span class="side-n">' + g.topics.length + '</span></a>';
    if (open) {
      html += '<ul class="side-topics">';
      for (const t of g.topics) {
        html += '<li><a href="#/t/' + t.id + '"' + (active === t ? ' class="current" aria-current="page"' : '') + '>' +
          esc(t.title) + ncHtml(t.id) + '</a></li>';
      }
      html += '</ul>';
    }
    html += '</li>';
  }
  html += '</ul>';
  sidebar.innerHTML = html;
  const cur = sidebar.querySelector('.current');
  if (cur) {
    const r = cur.getBoundingClientRect(), sr = sidebar.getBoundingClientRect();
    if (r.top < sr.top || r.bottom > sr.bottom) cur.scrollIntoView({ block: 'center' });
  }
}

/* ---------- общие куски разметки ---------- */

function blocksHtml(blocks, terms) {
  let html = '', list = null;
  const flush = () => { if (list !== null) { html += '<ul>' + list + '</ul>'; list = null; } };
  for (const b of blocks) {
    if (b.t === 'li') {
      if (list === null) list = '';
      list += '<li>' + rich(b.text, terms) + '</li>';
      continue;
    }
    flush();
    const cls = b.t === 'note' ? ' class="note"' : b.t === 'fn' ? ' class="fn"' : '';
    html += '<p' + cls + '>' + rich(b.text, terms) + '</p>';
  }
  flush();
  return html;
}

function topicLink(t, opts = {}) {
  const other = opts.from && opts.from.group !== t.group;
  return '<a class="tlink" href="#/t/' + t.id + '" style="--gc:' + t.group.color + '">' +
    '<span class="tlink-title">' + esc(t.title) + '</span>' +
    (other || opts.showGroup ? '<span class="chip">' + esc(t.group.title) + '</span>' : '') + '</a>';
}

function starBtn(t) {
  const fav = store.get('fav', []).includes(t.id);
  return '<button class="star' + (fav ? ' on' : '') + '" data-star="' + t.id + '" aria-pressed="' + fav + '" ' +
    'title="' + (fav ? 'Убрать из избранного' : 'В избранное') + '" aria-label="Избранное">' +
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/></svg></button>';
}

/* ---------- примечания: общие для всех, хранятся в Google Таблице (tools/notes-apps-script.gs) ---------- */

const NOTES_URL = String((window.KLASSIKI_CONFIG || {}).notesUrl || '').trim();
const notes = { list: [], byTopic: new Map(), loaded: false, error: '', at: 0, pending: null };
let current = null;   // что открыто: тема, группа, 'home', 'notes', 'search'

function setNotes(list) {
  notes.list = (Array.isArray(list) ? list : []).filter(n => n && n.id && n.topicId);
  notes.byTopic = new Map();
  for (const n of notes.list) {
    if (!notes.byTopic.has(n.topicId)) notes.byTopic.set(n.topicId, []);
    notes.byTopic.get(n.topicId).push(n);
  }
  for (const arr of notes.byTopic.values()) arr.sort((a, b) => String(a.created).localeCompare(String(b.created)));
  for (const t of TOPICS) {
    t.ix.notes = norm((notes.byTopic.get(t.id) || []).map(n => n.text).join(' '));
    t.ixWords.notes = t.ix.notes ? t.ix.notes.split(' ') : [];
  }
  store.set('notes-cache', notes.list);
}

/* число примечаний у темы, а для группы — сумма по всем её темам */
function noteCount(id) {
  const g = BY_ID.get(id);
  if (g && g.topics) return g.topics.reduce((n, t) => n + (notes.byTopic.get(t.id) || []).length, 0);
  return (notes.byTopic.get(id) || []).length;
}

async function notesRequest(body) {
  const opts = body
    ? { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body) }
    : { cache: 'no-store' };
  let res;
  try {
    res = await fetch(NOTES_URL, opts);
  } catch (e) {
    throw new Error('нет связи с хранилищем примечаний');
  }
  if (!res.ok) throw new Error('хранилище ответило ошибкой ' + res.status);
  let data;
  try { data = await res.json(); } catch (e) { throw new Error('хранилище вернуло непонятный ответ'); }
  if (!data.ok) throw new Error(data.error || 'ошибка хранилища');
  return data.notes;
}

function loadNotes(force) {
  if (!NOTES_URL) return Promise.resolve();
  if (notes.pending) return notes.pending;
  if (!force && notes.loaded && Date.now() - notes.at < 30000) return Promise.resolve();
  notes.pending = notesRequest()
    .then(list => { setNotes(list); notes.loaded = true; notes.error = ''; notes.at = Date.now(); })
    .catch(err => { notes.error = err.message; })
    .finally(() => { notes.pending = null; refreshNotesUI(); });
  return notes.pending;
}

async function changeNotes(body, okMsg) {
  try {
    const list = await notesRequest(body);
    setNotes(list);
    notes.loaded = true;
    notes.error = '';
    notes.at = Date.now();
    if (okMsg) toast(okMsg);
    return true;
  } catch (err) {
    toast('Не сохранилось: ' + err.message);
    return false;
  } finally {
    refreshNotesUI(true);
  }
}

function fmtDate(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/* текст примечания: экранирование + кликабельные ссылки */
function linkify(text) {
  const re = /https?:\/\/[^\s<>"]+[^\s<>".,;:!?)»]/g;
  let out = '', last = 0, m;
  while ((m = re.exec(text))) {
    out += esc(text.slice(last, m.index)) +
      '<a href="' + esc(m[0]) + '" target="_blank" rel="noopener noreferrer">' + esc(m[0]) + '</a>';
    last = m.index + m[0].length;
  }
  return out + esc(text.slice(last));
}

const NC_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12Z"/></svg>';

/* счётчик примечаний у темы или группы; обновляется на месте после загрузки */
function ncHtml(id) {
  if (!NOTES_URL) return '';
  const n = noteCount(id);
  return '<span class="nc" data-nc="' + id + '" title="Примечаний: ' + n + '"' + (n ? '' : ' hidden') + '>' +
    NC_ICON + '<span>' + n + '</span></span>';
}

function noteHtml(n, showTopic) {
  const t = BY_ID.get(n.topicId);
  const edited = n.updated && new Date(n.updated) - new Date(n.created) > 60000;
  let head = '';
  if (showTopic) {
    head = t ? '<div class="note-topic">' + topicLink(t, { showGroup: true }) + '</div>'
      : '<div class="note-topic"><span class="muted">Тема не найдена: ' + esc(n.topic || n.topicId) + '</span></div>';
  }
  return '<article class="note" data-note="' + esc(n.id) + '">' + head +
    '<div class="note-meta"><b>' + esc(n.author || 'Без имени') + '</b><span>' + fmtDate(n.created) +
    (edited ? ' · изменено ' + fmtDate(n.updated) : '') + '</span></div>' +
    '<div class="note-text">' + linkify(String(n.text)) + '</div>' +
    '<div class="note-actions"><button class="link-btn" data-note-edit>Изменить</button>' +
    '<button class="link-btn danger" data-note-del>Удалить</button></div></article>';
}

function notesStateHtml(emptyText) {
  if (notes.error && !notes.loaded) {
    return '<p class="notes-state">Не удалось загрузить примечания: ' + esc(notes.error) +
      '. <button class="link-btn" data-notes-reload>Повторить</button></p>';
  }
  if (!notes.loaded) return '<p class="notes-state muted">Загрузка примечаний…</p>';
  return '<p class="notes-state muted">' + emptyText + '</p>';
}

function topicNotesHtml(t) {
  const list = notes.byTopic.get(t.id) || [];
  if (!list.length) return notesStateHtml('Примечаний пока нет — добавьте первое.');
  return list.map(n => noteHtml(n, false)).join('');
}

function notesSectionHtml(t) {
  if (!NOTES_URL) return '';
  return '<section class="notes" id="notes"><h2 class="h-small">Примечания коллег ' + ncHtml(t.id) + '</h2>' +
    '<div class="notes-list" id="notesList">' + topicNotesHtml(t) + '</div>' +
    '<form class="note-form" id="noteForm" data-topic="' + t.id + '">' +
    '<textarea name="text" rows="3" maxlength="3000" required ' +
    'placeholder="Новое примечание: что относить к этой теме, частые ошибки, договорённости…"></textarea>' +
    '<div class="note-form-row">' +
    '<input name="author" maxlength="80" autocomplete="name" placeholder="Ваше имя (необязательно)" value="' +
    esc(store.get('author', '')) + '">' +
    '<button class="btn btn-primary" type="submit">Добавить примечание</button></div>' +
    '<p class="note-hint">Примечания видны всем, кто открывает сайт, и все могут их изменить. ' +
    '<kbd>Ctrl</kbd>+<kbd>Enter</kbd> — отправить.</p></form></section>';
}

function allNotesHtml(q) {
  const k = norm(q || '');
  let list = notes.list.slice().sort((a, b) => String(b.created).localeCompare(String(a.created)));
  if (k) {
    list = list.filter(n => {
      const t = BY_ID.get(n.topicId);
      return norm([n.text, n.author, n.topic, n.group, t ? t.title : ''].join(' ')).includes(k);
    });
  }
  if (!list.length) return notesStateHtml(k ? 'Ничего не найдено.' : 'Примечаний пока нет. Их можно добавить на странице любой темы.');
  return list.map(n => noteHtml(n, true)).join('');
}

function latestNotesHtml() {
  const list = notes.list.slice().sort((a, b) => String(b.created).localeCompare(String(a.created))).slice(0, 3);
  if (!list.length) return '';
  return '<h2 class="h-small">Новые примечания <a class="h-link" href="#/notes">все →</a></h2>' +
    '<div class="notes-list">' + list.map(n => noteHtml(n, true)).join('') + '</div>';
}

/* Перерисовывает только части с примечаниями: формы и открытое редактирование не сбрасываются. */
function refreshNotesUI(force) {
  if (!NOTES_URL) return;
  const total = notes.list.length;
  const badge = $('#notesBadge');
  badge.textContent = total;
  badge.hidden = !total;
  document.querySelectorAll('[data-nc]').forEach(el => {
    const n = noteCount(el.getAttribute('data-nc'));
    el.hidden = !n;
    el.title = 'Примечаний: ' + n;
    el.querySelector('span').textContent = n;
  });
  if (!force && view.querySelector('.note.editing')) return;   // не мешаем редактировать
  const box = document.getElementById('notesList');
  if (box && current && current.must) box.innerHTML = topicNotesHtml(current);
  const all = document.getElementById('notesAll');
  if (all) all.innerHTML = allNotesHtml(($('#notesFilter') || {}).value);
  const latest = document.getElementById('homeNotes');
  if (latest) latest.innerHTML = latestNotesHtml();
}

function startEdit(article) {
  const n = notes.list.find(x => x.id === article.getAttribute('data-note'));
  if (!n) return;
  article.classList.add('editing');
  article.querySelector('.note-text').outerHTML =
    '<textarea class="note-edit" rows="4" maxlength="3000">' + esc(n.text) + '</textarea>';
  article.querySelector('.note-actions').innerHTML =
    '<button class="btn btn-primary btn-sm" data-note-save>Сохранить</button>' +
    '<button class="btn btn-sm" data-note-cancel>Отмена</button>';
  const ta = article.querySelector('.note-edit');
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
}

document.addEventListener('click', async e => {
  const btn = e.target.closest('[data-note-edit], [data-note-del], [data-note-save], [data-note-cancel], [data-notes-reload]');
  if (!btn) return;
  if (btn.hasAttribute('data-notes-reload')) {
    btn.disabled = true;
    await loadNotes(true);
    btn.disabled = false;
    toast(notes.error ? 'Не удалось обновить: ' + notes.error : 'Примечания обновлены');
    return;
  }
  const article = btn.closest('.note');
  const id = article.getAttribute('data-note');
  if (btn.hasAttribute('data-note-edit')) {
    startEdit(article);
  } else if (btn.hasAttribute('data-note-cancel')) {
    article.classList.remove('editing');
    refreshNotesUI(true);
  } else if (btn.hasAttribute('data-note-save')) {
    const text = article.querySelector('.note-edit').value.trim();
    if (!text) { toast('Примечание пустое'); return; }
    btn.disabled = true;
    btn.textContent = 'Сохранение…';
    const ok = await changeNotes({ action: 'edit', id, text }, 'Примечание изменено');
    if (!ok) { btn.disabled = false; btn.textContent = 'Сохранить'; }
  } else if (btn.hasAttribute('data-note-del')) {
    if (!confirm('Удалить примечание? Владелец таблицы сможет его восстановить.')) return;
    btn.disabled = true;
    await changeNotes({ action: 'delete', id }, 'Примечание удалено');
  }
});

document.addEventListener('submit', async e => {
  const form = e.target.closest('#noteForm');
  if (!form) return;
  e.preventDefault();
  const t = BY_ID.get(form.getAttribute('data-topic'));
  const text = form.elements.text.value.trim();
  const author = form.elements.author.value.trim();
  if (!t || !text) { toast('Напишите текст примечания'); return; }
  store.set('author', author);
  const btn = form.querySelector('button[type=submit]');
  btn.disabled = true;
  btn.textContent = 'Сохранение…';
  const ok = await changeNotes({ action: 'add', topicId: t.id, group: t.group.name, topic: t.name, author, text },
    'Примечание добавлено');
  btn.disabled = false;
  btn.textContent = 'Добавить примечание';
  if (ok) form.elements.text.value = '';
});

document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    if (e.target.closest && e.target.closest('#noteForm')) { e.preventDefault(); e.target.closest('#noteForm').requestSubmit(); }
    else if (e.target.classList && e.target.classList.contains('note-edit')) {
      e.preventDefault();
      const save = e.target.closest('.note').querySelector('[data-note-save]');
      if (save && !save.disabled) save.click();
    }
  }
});

/* ---------- экраны ---------- */

function renderHome() {
  const fav = store.get('fav', []).map(id => BY_ID.get(id)).filter(Boolean);
  let html = '<section class="hero">' +
    '<h1>Подбор группы тем и темы</h1>' +
    '<p class="lead">Начните вводить слова из обращения в поиске — он ищет по названиям тем, описаниям ' +
    '«Тема должна содержать» и спискам «Не путать с темами». <span class="hint">Клавиша <kbd>/</kbd> — сразу к поиску, ' +
    '<kbd>↑</kbd><kbd>↓</kbd> и <kbd>Enter</kbd> — выбор результата.</span></p>' +
    '<div class="stats"><span><b>' + GROUPS.length + '</b> групп тем</span><span><b>' + TOPICS.length + '</b> тем</span></div>' +
    '</section>';

  if (fav.length) {
    html += '<section><h2 class="h-small">Избранное</h2><div class="tlinks">' +
      fav.map(t => topicLink(t, { showGroup: true })).join('') + '</div></section>';
  }

  if (NOTES_URL) html += '<section id="homeNotes">' + latestNotesHtml() + '</section>';

  html += '<h2 class="h-small">Группы тем</h2><div class="grid">';
  for (const g of GROUPS) {
    html += '<a class="gcard" href="#/g/' + g.id + '" style="--gc:' + g.color + '">' +
      '<span class="gcard-title">' + esc(g.title) + '</span>' +
      '<span class="gcard-n">' + topicsWord(g.topics.length) + '</span>' +
      (g.subs.length ? '<span class="gcard-subs">' + g.subs.map(s => esc(s.name)).join(' · ') + '</span>' : '') +
      '</a>';
  }
  html += '</div>';
  html += footer();
  view.innerHTML = html;
  current = 'home';
  renderSidebar(null);
  document.title = 'Классификатор инцидентов';
}

function renderGroup(g, subIdx) {
  let html = '<nav class="crumbs"><a href="#/">Все группы</a></nav>' +
    '<header class="ghead" style="--gc:' + g.color + '">' +
    '<h1>' + esc(g.title) + '</h1>' +
    '<div class="ghead-meta"><span>' + topicsWord(g.topics.length) + '</span>' +
    '<button class="btn btn-ghost" data-copy="' + esc(g.name) + '">Копировать группу</button></div>';
  if (g.intro.length) html += '<div class="prose ghead-intro">' + blocksHtml(g.intro) + '</div>';
  html += '</header>';

  const sections = [];
  if (g.subs.length) {
    g.subs.forEach((s, i) => sections.push({ sub: s, idx: i, topics: g.topics.filter(t => t.subIdx === i) }));
    const loose = g.topics.filter(t => t.subIdx === -1);
    if (loose.length) sections.unshift({ sub: null, idx: -1, topics: loose });
  } else {
    sections.push({ sub: null, idx: -1, topics: g.topics });
  }
  for (const sec of sections) {
    if (!sec.topics.length) continue;
    html += '<section class="sub" id="sub-' + sec.idx + '">';
    if (sec.sub) html += '<h2 class="sub-title" style="--gc:' + g.color + '">' + esc(sec.sub.name) + '</h2>';
    if (sec.sub && sec.sub.intro.length) html += '<div class="prose">' + blocksHtml(sec.sub.intro) + '</div>';
    html += '<div class="trows">';
    for (const t of sec.topics) {
      const s = snippet(t, []);
      html += '<a class="trow" href="#/t/' + t.id + '"><span class="trow-title">' + esc(t.title) + ncHtml(t.id) + '</span>' +
        '<span class="trow-desc">' + esc(s.text) + (s.cut ? '…' : '') + '</span></a>';
    }
    html += '</div></section>';
  }
  html += footer();
  view.innerHTML = html;
  current = g;
  renderSidebar(g);
  document.title = g.title + ' — Классификатор инцидентов';
  if (subIdx != null) {
    const el = document.getElementById('sub-' + subIdx);
    if (el) el.scrollIntoView();
  }
}

function renderTopic(t) {
  const g = t.group;
  const sub = t.subIdx >= 0 ? g.subs[t.subIdx] : null;
  const siblings = g.topics.filter(x => x.subIdx === t.subIdx && x !== t);
  const back = (BACKLINKS.get(t.id) || []).filter(x => x !== t);

  let html = '<nav class="crumbs"><a href="#/">Все группы</a><span>›</span>' +
    '<a href="#/g/' + g.id + '">' + esc(g.title) + '</a>' +
    (sub ? '<span>›</span><a href="#/g/' + g.id + '/' + t.subIdx + '">' + esc(sub.name) + '</a>' : '') + '</nav>';

  html += '<article class="topic" style="--gc:' + g.color + '">' +
    '<header class="thead"><h1>' + esc(t.title) + '</h1>' + starBtn(t) + '</header>' +
    '<div class="copybox">' +
    '<code class="copy-preview" title="Так будет скопировано">' + esc(copyString(t)) + '</code>' +
    '<div class="copy-actions">' +
    '<button class="btn btn-primary" data-copy-all="' + t.id + '">Копировать всё</button>' +
    '<button class="btn" data-copy="' + esc(g.name) + '">Группу</button>' +
    '<button class="btn" data-copy="' + esc(t.name) + '">Тему</button>' +
    '</div></div>';

  html += '<div class="cols">' +
    '<section class="card card-must"><h2><span class="sign">+</span>Тема должна содержать</h2>' +
    '<div class="prose">' + blocksHtml(t.must) + '</div></section>';

  html += '<section class="card card-conf"><h2><span class="sign">−</span>Не путать с ' +
    (t.conf.length === 1 ? 'темой' : 'темами') + '</h2>';
  if (t.confNote) html += '<p class="conf-note">' + rich(t.confNote) + '</p>';
  if (t.conf.length) {
    html += '<ul class="conf-list">';
    for (const c of t.conf) {
      if (c.ref) {
        const r = BY_ID.get(c.ref);
        const sameName = norm(r.name) === norm(c.text);
        html += '<li>' + topicLink(r, { from: t }) +
          (sameName ? '' : '<span class="conf-orig">в своде: «' + esc(c.text) + '»</span>') + '</li>';
      } else if (c.group) {
        const rg = BY_ID.get(c.group);
        const href = '#/g/' + rg.id + (c.sub ? '/' + rg.subs.findIndex(s => s.name === c.sub) : '');
        html += '<li><a class="tlink" href="' + href + '" style="--gc:' + rg.color + '"><span class="tlink-title">' +
          esc(c.text) + '</span><span class="chip">' + (c.sub ? 'блок тем' : 'группа тем') + '</span></a></li>';
      } else {
        html += '<li class="conf-plain">' + rich(c.text) + '</li>';
      }
    }
    html += '</ul>';
  } else if (!t.confNote) {
    html += '<p class="muted">Не указано.</p>';
  }
  html += '</section></div>';
  html += notesSectionHtml(t);

  if (back.length) {
    html += '<section class="related"><h2 class="h-small">Эту тему упоминают в «Не путать»</h2>' +
      '<div class="tlinks">' + back.map(x => topicLink(x, { from: t })).join('') + '</div></section>';
  }
  if (siblings.length) {
    html += '<section class="related"><h2 class="h-small">' + (sub ? 'Другие темы блока «' + esc(sub.name) + '»' : 'Другие темы группы') +
      '</h2><div class="tlinks">' + siblings.map(x => topicLink(x)).join('') + '</div></section>';
  }
  html += '<p class="meta">Страница ' + t.page + ' в своде документации · официальное название: ' + esc(t.name) + '</p>';
  html += '</article>' + footer();

  view.innerHTML = html;
  current = t;
  renderSidebar(t);
  document.title = t.title + ' — Классификатор инцидентов';
}

let selIndex = 0;

function renderSearch(q) {
  const { terms, results, partial } = search(q);
  selIndex = 0;
  let html = '<div class="results-head"><h1 class="h-results">' +
    (results.length ? 'Найдено: ' + topicsWord(results.length) : 'Ничего не найдено') + '</h1>';
  if (partial && results.length) html += '<p class="muted">Нет темы, где встречаются все слова, — показаны самые близкие.</p>';
  html += '</div>';
  if (!results.length) {
    html += '<div class="empty"><p>Попробуйте другие слова: короче, без окончаний или синонимы ' +
      '(например, «мусор», «яма», «отопление», «пособие»).</p><p><a href="#/">Открыть список групп</a></p></div>';
  }
  html += '<ol class="results" id="results">';
  results.slice(0, 80).forEach((r, i) => {
    const t = r.t;
    const s = snippet(t, terms);
    const inNotes = terms.some(term => t.ixWords.notes.some(w => fits(w, term.stem)));
    html += '<li><a class="result' + (i === 0 ? ' sel' : '') + '" href="#/t/' + t.id + '" style="--gc:' + t.group.color + '">' +
      '<span class="result-ctx"><span class="dot"></span>' + esc(t.group.title) + (t.sub ? ' · ' + esc(t.sub) : '') +
      (inNotes ? '<span class="chip">есть в примечаниях</span>' : '') + '</span>' +
      '<span class="result-title">' + highlight(esc(t.title), terms) + ncHtml(t.id) + '</span>' +
      '<span class="result-desc">' + (s.lead ? '…' : '') + highlight(esc(s.text), terms) + (s.cut ? '…' : '') + '</span>' +
      '</a></li>';
  });
  html += '</ol>';
  if (results.length > 80) html += '<p class="muted">Показаны первые 80 — уточните запрос.</p>';
  view.innerHTML = html;
  current = 'search';
  renderSidebar(null);
  document.title = 'Поиск: ' + q + ' — Классификатор инцидентов';
}

function renderNotesPage() {
  let html = '<nav class="crumbs"><a href="#/">Все группы</a></nav>';
  if (!NOTES_URL) {
    html += '<h1 class="h-results">Примечания</h1><p class="empty">Примечания пока не подключены.</p>';
  } else {
    html += '<header class="notes-head"><h1>Примечания коллег</h1>' +
      '<button class="btn btn-sm" data-notes-reload>Обновить</button></header>' +
      '<p class="muted notes-sub">Добавить примечание можно на странице любой темы. Здесь — все примечания, сначала новые.</p>' +
      '<input class="notes-filter" id="notesFilter" type="search" autocomplete="off" ' +
      'placeholder="Фильтр по тексту, теме или автору…" aria-label="Фильтр примечаний">' +
      '<div class="notes-list" id="notesAll">' + allNotesHtml('') + '</div>';
  }
  view.innerHTML = html + footer();
  current = 'notes';
  renderSidebar(null);
  document.title = 'Примечания — Классификатор инцидентов';
  const f = $('#notesFilter');
  if (f) f.addEventListener('input', () => { $('#notesAll').innerHTML = allNotesHtml(f.value); });
}

function footer() {
  return '<footer class="foot">Источник: «Свод документации по Классификатору инцидентов» (кроме регламента внесения изменений). ' +
    'Данные собраны автоматически скриптом <code>tools/build_data.py</code>.</footer>';
}

/* ---------- маршрутизация ---------- */

function route() {
  const h = decodeURIComponent(location.hash.replace(/^#/, ''));
  closeMenu();
  let m;
  if ((m = h.match(/^\/search\/(.*)$/))) {
    const q = m[1];
    if (input.value !== q) input.value = q;
    renderSearch(q);
    return;
  }
  if (document.activeElement !== input) input.value = '';
  if (h === '/notes') {
    renderNotesPage();
    loadNotes(false);
  } else if ((m = h.match(/^\/t\/([\w-]+)/)) && BY_ID.has(m[1])) {
    renderTopic(BY_ID.get(m[1]));
  } else if ((m = h.match(/^\/g\/([\w-]+)(?:\/(\d+))?/)) && BY_ID.has(m[1])) {
    renderGroup(BY_ID.get(m[1]), m[2] != null ? +m[2] : null);
    if (m[2] != null) return;
  } else {
    renderHome();
  }
  window.scrollTo(0, 0);
}

let typingTimer;
input.addEventListener('input', () => {
  clearTimeout(typingTimer);
  typingTimer = setTimeout(() => {
    const q = input.value.trim();
    if (q) {
      const target = '#/search/' + encodeURIComponent(q);
      if (location.hash.startsWith('#/search/')) history.replaceState(null, '', target);
      else history.pushState(null, '', target);
      renderSearch(q);
      window.scrollTo(0, 0);
    } else if (location.hash.startsWith('#/search/')) {
      history.replaceState(null, '', '#/');
      renderHome();
    }
  }, 120);
});

function moveSel(delta) {
  const items = [...document.querySelectorAll('#results .result')];
  if (!items.length) return;
  items[selIndex] && items[selIndex].classList.remove('sel');
  selIndex = (selIndex + delta + items.length) % items.length;
  items[selIndex].classList.add('sel');
  items[selIndex].scrollIntoView({ block: 'nearest' });
}

input.addEventListener('keydown', e => {
  if (e.key === 'ArrowDown') { e.preventDefault(); moveSel(1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); moveSel(-1); }
  else if (e.key === 'Enter') {
    const sel = document.querySelector('#results .result.sel');
    if (sel) { e.preventDefault(); location.hash = sel.getAttribute('href'); input.blur(); }
  } else if (e.key === 'Escape') {
    if (input.value) { input.value = ''; input.dispatchEvent(new Event('input')); }
    else input.blur();
  }
});

document.addEventListener('keydown', e => {
  const typing = e.target.closest && e.target.closest('input, textarea, select, [contenteditable]');
  if (e.key === '/' && !typing && !e.ctrlKey && !e.metaKey && !e.altKey) {
    e.preventDefault();
    input.focus();
    input.select();
  }
});

/* ---------- копирование ---------- */

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove('show'), 2200);
}

function copyText(text) {
  const done = () => toast('Скопировано: ' + (text.length > 70 ? text.slice(0, 70) + '…' : text));
  const fallback = () => {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    ok ? done() : toast('Не удалось скопировать — выделите текст вручную');
  };
  if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(done, fallback);
  else fallback();
}

document.addEventListener('click', e => {
  const btn = e.target.closest('[data-copy], [data-copy-all], [data-star]');
  if (!btn) return;
  if (btn.hasAttribute('data-copy')) copyText(btn.getAttribute('data-copy'));
  else if (btn.hasAttribute('data-copy-all')) copyText(copyString(BY_ID.get(btn.getAttribute('data-copy-all'))));
  else {
    const id = btn.getAttribute('data-star');
    let fav = store.get('fav', []);
    const on = !fav.includes(id);
    fav = on ? [id, ...fav] : fav.filter(x => x !== id);
    store.set('fav', fav);
    btn.classList.toggle('on', on);
    btn.setAttribute('aria-pressed', on);
    btn.title = on ? 'Убрать из избранного' : 'В избранное';
    toast(on ? 'Добавлено в избранное' : 'Убрано из избранного');
  }
});

/* ---------- меню, тема, «наверх» ---------- */

const menuBtn = $('#menuBtn');
function closeMenu() {
  document.body.classList.remove('menu-open');
  menuBtn.setAttribute('aria-expanded', 'false');
}
menuBtn.addEventListener('click', () => {
  const open = document.body.classList.toggle('menu-open');
  menuBtn.setAttribute('aria-expanded', String(open));
});
$('#scrim').addEventListener('click', closeMenu);

$('#themeBtn').addEventListener('click', () => {
  const root = document.documentElement;
  const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  root.dataset.theme = dark ? 'light' : 'dark';
  try { localStorage.setItem('klassiki-theme', root.dataset.theme); } catch (e) { /* ничего */ }
});

const toTop = $('#toTop');
window.addEventListener('scroll', () => toTop.classList.toggle('show', window.scrollY > 500), { passive: true });
toTop.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));

window.addEventListener('hashchange', route);
if (!GROUPS.length) {
  view.innerHTML = '<p class="empty">Не удалось загрузить data.js. Проверьте, что файл лежит рядом с index.html.</p>';
} else {
  setNotes(NOTES_URL ? store.get('notes-cache', []) : []);
  if (NOTES_URL) {
    $('#notesBtn').hidden = false;
    document.addEventListener('visibilitychange', () => { if (!document.hidden) loadNotes(false); });
  }
  route();
  refreshNotesUI();
  loadNotes(true);
}
