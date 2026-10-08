'use strict';

/* Данные: window.CLASSIFIER из data.js (генерируется tools/build_data.py). */
const DATA = window.CLASSIFIER || { groups: [] };
const GROUPS = DATA.groups;
const TOPICS = [];
const BY_ID = new Map();
const BACKLINKS = new Map();      // id темы → темы, где она указана в «Не путать»

for (const g of GROUPS) {
  BY_ID.set(g.id, g);
  g.topics.forEach((t, i) => {
    t.group = g;
    t.idx = i;
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
  };
  t.ixWords = {};
  for (const f in t.ix) t.ixWords[f] = t.ix[f].split(' ');
}

const WEIGHTS = { title: 12, ctx: 4, must: 3, conf: 1 };

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
      '<span class="dot"></span><span class="side-title">' + esc(g.title) + '</span>' +
      '<span class="side-n">' + g.topics.length + '</span></a>';
    if (open) {
      html += '<ul class="side-topics">';
      for (const t of g.topics) {
        html += '<li><a href="#/t/' + t.id + '"' + (active === t ? ' class="current" aria-current="page"' : '') + '>' +
          esc(t.title) + '</a></li>';
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

/* ---------- экраны ---------- */

function renderHome() {
  const fav = store.get('fav', []).map(id => BY_ID.get(id)).filter(Boolean);
  const recent = store.get('recent', []).map(id => BY_ID.get(id)).filter(Boolean);
  let html = '<section class="hero">' +
    '<h1>Подбор группы тем и темы</h1>' +
    '<p class="lead">Начните вводить слова из обращения в поиске — он ищет по названиям тем, описаниям ' +
    '«Тема должна содержать» и спискам «Не путать с темами». <span class="hint">Клавиша <kbd>/</kbd> — сразу к поиску, ' +
    '<kbd>↑</kbd><kbd>↓</kbd> и <kbd>Enter</kbd> — выбор результата.</span></p>' +
    '<div class="stats"><span><b>' + GROUPS.length + '</b> групп тем</span><span><b>' + TOPICS.length + '</b> тем</span></div>' +
    '</section>';

  if (fav.length || recent.length) {
    html += '<section class="quick">';
    if (fav.length) {
      html += '<div class="quick-col"><h2 class="h-small">Избранное</h2><div class="tlinks">' +
        fav.map(t => topicLink(t, { showGroup: true })).join('') + '</div></div>';
    }
    if (recent.length) {
      html += '<div class="quick-col"><h2 class="h-small">Недавние <button class="link-btn" data-clear-recent>очистить</button></h2>' +
        '<div class="tlinks">' + recent.map(t => topicLink(t, { showGroup: true })).join('') + '</div></div>';
    }
    html += '</section>';
  }

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
      html += '<a class="trow" href="#/t/' + t.id + '"><span class="trow-title">' + esc(t.title) + '</span>' +
        '<span class="trow-desc">' + esc(s.text) + (s.cut ? '…' : '') + '</span></a>';
    }
    html += '</div></section>';
  }
  html += footer();
  view.innerHTML = html;
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
  const prev = g.topics[t.idx - 1], next = g.topics[t.idx + 1];

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

  if (back.length) {
    html += '<section class="related"><h2 class="h-small">Эту тему упоминают в «Не путать»</h2>' +
      '<div class="tlinks">' + back.map(x => topicLink(x, { from: t })).join('') + '</div></section>';
  }
  if (siblings.length) {
    html += '<section class="related"><h2 class="h-small">' + (sub ? 'Другие темы блока «' + esc(sub.name) + '»' : 'Другие темы группы') +
      '</h2><div class="tlinks">' + siblings.map(x => topicLink(x)).join('') + '</div></section>';
  }
  html += '<nav class="pager">' +
    (prev ? '<a class="pager-link" href="#/t/' + prev.id + '"><span>← Предыдущая</span>' + esc(prev.title) + '</a>' : '<span></span>') +
    (next ? '<a class="pager-link next" href="#/t/' + next.id + '"><span>Следующая →</span>' + esc(next.title) + '</a>' : '<span></span>') +
    '</nav>';
  html += '<p class="meta">Страница ' + t.page + ' в своде документации · официальное название: ' + esc(t.name) + '</p>';
  html += '</article>' + footer();

  view.innerHTML = html;
  renderSidebar(t);
  document.title = t.title + ' — Классификатор инцидентов';

  const recent = store.get('recent', []).filter(id => id !== t.id);
  recent.unshift(t.id);
  store.set('recent', recent.slice(0, 8));
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
    html += '<li><a class="result' + (i === 0 ? ' sel' : '') + '" href="#/t/' + t.id + '" style="--gc:' + t.group.color + '">' +
      '<span class="result-ctx"><span class="dot"></span>' + esc(t.group.title) + (t.sub ? ' · ' + esc(t.sub) : '') + '</span>' +
      '<span class="result-title">' + highlight(esc(t.title), terms) + '</span>' +
      '<span class="result-desc">' + (s.lead ? '…' : '') + highlight(esc(s.text), terms) + (s.cut ? '…' : '') + '</span>' +
      '</a></li>';
  });
  html += '</ol>';
  if (results.length > 80) html += '<p class="muted">Показаны первые 80 — уточните запрос.</p>';
  view.innerHTML = html;
  renderSidebar(null);
  document.title = 'Поиск: ' + q + ' — Классификатор инцидентов';
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
  if ((m = h.match(/^\/t\/([\w-]+)/)) && BY_ID.has(m[1])) {
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
  if (e.key === '/' && document.activeElement !== input && !e.ctrlKey && !e.metaKey && !e.altKey) {
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
  const btn = e.target.closest('[data-copy], [data-copy-all], [data-star], [data-clear-recent]');
  if (!btn) return;
  if (btn.hasAttribute('data-copy')) copyText(btn.getAttribute('data-copy'));
  else if (btn.hasAttribute('data-copy-all')) copyText(copyString(BY_ID.get(btn.getAttribute('data-copy-all'))));
  else if (btn.hasAttribute('data-clear-recent')) { store.set('recent', []); renderHome(); }
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
  route();
}
