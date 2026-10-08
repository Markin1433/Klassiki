#!/usr/bin/env python3
"""Собирает data.js для сайта из PDF «Свод документации по Классификатору».

Сам PDF в репозиторий не кладётся (*.pdf в .gitignore). Запуск:

    python3 -m pip install pymupdf
    python3 tools/build_data.py "/путь/к/Свод_документации.pdf"

Страницы 1–4 (обложка, оглавление, регламент и формат внесения изменений)
пропускаются. Скриншоты с примерами не извлекаются.
"""
import hashlib
import json
import re
import sys
from pathlib import Path

import pymupdf

FIRST_PAGE = 5          # 1-based; страницы 3–4 (регламент) на сайт не идут
COL_X = 200             # граница между левой и правой колонкой, pt (строки начинаются до ~110 или после ~250)
OUT = Path(__file__).resolve().parent.parent / 'data.js'

RE_FOOTER = re.compile(r'\s*\((см\. далее|продолжение)\)\s*')
RE_MUST = re.compile(r'^Тема должна содержать', re.I)
RE_CONF = re.compile(r'^Не путать с', re.I)
RE_EX = re.compile(r'^ПРИМЕР', re.I)
BULLET_CHARS = '•–‒−—✓\uf0fc\uf0a7\uf0d8'
WHITE = 0xFFFFFF


def rgb_int(c):
    if isinstance(c, int):
        return c
    r, g, b = (round(v * 255) for v in (list(c) + [0, 0, 0])[:3])
    return (r << 16) | (g << 8) | b


def near(a, b, tol=40):
    return all(abs(((a >> s) & 255) - ((b >> s) & 255)) <= tol for s in (0, 8, 16))


def is_bold(font):
    return any(w in font for w in ('Bold', 'SemiBold', 'Black'))


def span_kind(s):
    if s['size'] >= 25:
        return 'GROUP'
    if s['color'] == WHITE:
        return 'TOPIC'
    if 'ExtraBold' in s['font'] and s['size'] >= 11.5 and s['color'] != 0:
        return 'SUB'
    return 'BODY'


def page_spans(page, log):
    """Видимые текстовые фрагменты страницы.

    В PDF есть «забытые» надписи: белый текст на белом фоне и текст, перекрытый
    плашкой заголовка. Видимость определяем по порядку отрисовки (seqno).
    """
    fills = [(d['seqno'], d['rect'], rgb_int(d['fill']))
             for d in page.get_drawings() if d.get('fill') and (d.get('fill_opacity') or 1) > 0.9]
    out = []
    for s in page.get_texttrace():
        if s['type'] == 3 or s.get('opacity', 1) == 0:
            continue
        text = ''.join(chr(c[0]) for c in s['chars'])
        if not text.strip() or s['font'].startswith('Calibri') or RE_FOOTER.fullmatch(text):
            continue
        x0, y0, x1, y1 = s['bbox']
        pt = pymupdf.Point(x0 + min(6, (x1 - x0) / 2), (y0 + y1) / 2)
        color = rgb_int(s['color'])
        under = [f for f in fills if f[1].contains(pt)]
        covered = any(seq > s['seqno'] for seq, _, _ in under)
        below = [f for f in under if f[0] < s['seqno']]
        bg = max(below, key=lambda f: f[0])[2] if below else WHITE
        if covered or near(color, bg):
            log.append(f'стр. {page.number + 1}: пропущен невидимый текст «{text.strip()}»')
            continue
        # PowerPoint имитирует жирный шрифт, печатая тот же текст дважды со сдвигом
        dup = next((o for o in out if o['text'] == text and abs(o['x'] - x0) < 1.5 and abs(o['y'] - y0) < 1.5),
                   None)
        if dup:
            dup['bold'] = True
            continue
        out.append(dict(x=x0, x1=x1, y=y0, size=s['size'], font=s['font'], color=color, text=text))
    return out


def norm_ws(t):
    return re.sub(r'\s+', ' ', t).strip()


def group_lines(spans, key=None):
    """Склеивает фрагменты в строки по y.

    С key — строки делятся по ключу (вид заголовка). Без key — в строку попадают только
    фрагменты, идущие подряд по x; колонка определяется по началу строки, поэтому текст
    на всю ширину страницы не разрезается пополам.
    """
    lines = []
    for s in sorted(spans, key=lambda s: (s['y'], s['x'])):
        for ln in lines:
            if abs(ln['y'] - s['y']) >= 4:
                continue
            if key:
                if ln['key'] == key(s):
                    break
            else:
                gap = s['x'] - ln['x1']
                crosses = ln['spans'][0]['x'] < COL_X <= s['x']
                if -1 <= gap < (4 if crosses else 14):    # через межколонный зазор — только вплотную
                    break
        else:
            ln = dict(key=key(s) if key else None, y=s['y'], x1=s['x'], spans=[])
            lines.append(ln)
        ln['spans'].append(s)
        ln['x1'] = max(ln['x1'], s['x1'])
    for ln in lines:
        ln['spans'].sort(key=lambda s: s['x'])
        # между фрагментами с видимым зазором нужен пробел («ОБОРУДОВАНИЯ» + «В УЧРЕЖДЕНИЯХ»)
        for a, b in zip(ln['spans'], ln['spans'][1:]):
            if b['x'] - a['x1'] > 1.5 and not a['text'].endswith(' ') and not b['text'].startswith(' '):
                b['text'] = ' ' + b['text']
        ln['x'] = ln['spans'][0]['x']
        ln['text'] = norm_ws(''.join(s['text'] for s in ln['spans']))
        if not key:
            ln['key'] = 'R' if ln['x'] >= COL_X else 'L'
    return lines


B_ON, B_OFF = '\u0002', '\u0003'   # маркеры жирного текста («*» в PDF занята под сноски)


def rich_text(spans):
    """Текст строки; жирные фрагменты оборачиваются в B_ON…B_OFF."""
    out = ''
    bold = False
    for s in spans:
        t = s['text']
        b = (s.get('bold') or is_bold(s['font'])) and bool(t.strip())
        if b and not bold:
            lead = len(t) - len(t.lstrip())
            out += t[:lead] + B_ON
            t = t[lead:]
        elif not b and bold:
            trail = len(out) - len(out.rstrip())
            out = out.rstrip() + B_OFF + ' ' * trail
        bold = b
        out += t
    if bold:
        out = out.rstrip() + B_OFF
    out = re.sub(B_OFF + r'(\s*)' + B_ON, r'\1', out)      # склеиваем соседние жирные куски
    out = re.sub(B_ON + r'([\s*:;,.]*)' + B_OFF, r'\1', out)  # «жирные» пробелы и знаки не выделяем
    return norm_ws(out)


# Слова, которые PowerPoint разорвал между строками без дефиса, и явные опечатки в описаниях.
# Названия тем не исправляются: они должны совпадать с классификатором в системе.
TEXT_FIXES = {
    'Специал изированная': 'Специализированная',
    'оказыва ется': 'оказывается',
    'рентгенологичекое': 'рентгенологическое',
    'График работа': 'График работы',
    'Действующее акции': 'Действующие акции',
    'о ветеринарные справках': 'о ветеринарных справках',
}


def fix_text(t):
    for a, b in TEXT_FIXES.items():
        t = t.replace(a, b)
    return t


def join_text(a, b):
    if re.search(r'[а-яёa-z]-$', a, re.I):        # перенос «из-» + «за»
        return a + b
    return a + ' ' + b


class Section:
    """Абзацы одной колонки: описание темы, вводная группы и т.п."""

    def __init__(self):
        self.blocks = []        # dict(t='p'|'li'|'note', text=…)
        self.last = None

    def add(self, ln, page, note=False):
        text = rich_text(ln['spans'])
        first = ln['spans'][0]['text'].strip()
        bullet = first[:1] in BULLET_CHARS and (len(first) == 1 or first[1] == ' ')
        if bullet:
            text = norm_ws(re.sub('^[' + BULLET_CHARS + r']\s*', '', text))
        kind = 'note' if note else ('li' if bullet else 'p')
        if kind == 'p' and text.startswith('*'):
            kind = 'fn'     # сноска
        textx = ln['spans'][1]['x'] if bullet and len(ln['spans']) > 1 else ln['x']
        prev = self.blocks[-1] if self.blocks else None
        cont = False
        if prev and not bullet and kind != 'fn' and self.last and (prev['t'] == 'note') == note:
            if page == self.last['page']:
                gap = ln['y'] - self.last['y']
                cont = 0 < gap < 15.5 and ln['x'] >= self.last['textx'] - 4
            else:   # абзац продолжается на следующей странице
                cont = not re.search('[.;:!?][' + B_OFF + ']?$', prev['text'])
        if cont:
            prev['text'] = fix_text(join_text(prev['text'], text))
            textx = self.last['textx']
        else:
            self.blocks.append(dict(t=kind, text=fix_text(text)))
        self.last = dict(y=ln['y'], page=page, textx=textx)


def split_footnotes(blocks):
    """«*Пояснение 1. ** Пояснение 2» → две сноски."""
    out = []
    for b in blocks:
        if b['t'] == 'fn':
            for part in re.split(r'(?<=[.;])\s+(?=\*{1,3}\s?\*?\s?[А-ЯЁA-Z])', b['text']):
                out.append(dict(t='fn', text=part.strip()))
        else:
            out.append(b)
    return out


def confuse_items(blocks):
    """«Не путать с темами»: пункты списка + пояснения без тире."""
    has_li = any(b['t'] == 'li' for b in blocks)
    items, notes = [], []
    for b in blocks:
        if has_li and b['t'] != 'li':
            notes.append(b['text'])
            continue
        # в одном пункте иногда перечислено несколько тем через «;»
        for part in re.split(r';\s+(?=[А-ЯЁA-Z«"])', b['text']):
            part = re.sub(r'^[-–‒−—]\s*', '', part)
            part = re.sub(r'[;.,]+$', '', part).strip()
            if part:
                items.append(part)
    return items, notes


def parse(pdf_path, log):
    doc = pymupdf.open(pdf_path)
    groups = []
    group = sub = topic = None
    intro = None
    modes = {'L': None, 'R': None}

    for pno in range(FIRST_PAGE - 1, len(doc)):
        page = pno + 1
        spans = page_spans(doc[pno], log)
        heads = [s for s in spans if span_kind(s) != 'BODY']
        body = [s for s in spans if span_kind(s) == 'BODY']

        merged = []
        for ln in sorted(group_lines(heads, key=span_kind), key=lambda l: l['y']):
            gap = 40 if ln['key'] == 'GROUP' else 24
            if merged and merged[-1]['key'] == ln['key'] and ln['y'] - merged[-1]['y_end'] < gap:
                m = merged[-1]
                m['text'] = norm_ws(m['text'] + ' ' + ln['text'])
                m['y_end'] = ln['y']
                m['spans'] += ln['spans']
            else:
                merged.append(dict(ln, y_end=ln['y']))

        # Порядок чтения: полосы между заголовками; в полосе — сначала левая колонка, потом правая.
        bounds = [h['y'] for h in merged]
        def band(y):
            return sum(1 for b in bounds if b <= y + 0.5)
        events = [(band(h['y']) - 0.5, 0, h['y'], 'H', h) for h in merged]
        for ln in group_lines(body):
            events.append((band(ln['y']), 1 if ln['key'] == 'L' else 2, ln['y'], 'B', ln))
        events.sort(key=lambda e: e[:3])

        for _, _, _, kind, ln in events:
            if kind == 'H':
                k = ln['key']
                if k == 'GROUP':
                    color = max(ln['spans'], key=lambda s: len(s['text']))['color']
                    group = dict(name=ln['text'], color='#%06x' % color, page=page,
                                 intro=Section(), subs=[], topics=[])
                    groups.append(group)
                    sub = topic = None
                    intro = group['intro']
                elif k == 'SUB':
                    sub = dict(name=ln['text'], page=page, intro=Section())
                    group['subs'].append(sub)
                    topic = None
                    intro = sub['intro']
                else:
                    topic = dict(name=ln['text'], sub=sub['name'] if sub else None, page=page,
                                 must=Section(), conf=Section())
                    group['topics'].append(topic)
                    modes['L'] = modes['R'] = None
                continue

            col, text = ln['key'], ln['text']
            grey = near(ln['spans'][0]['color'], 0x7F7F7F, 8)
            if RE_EX.match(text) and grey:
                modes[col] = 'ex'
                continue
            if topic is None:
                intro.add(ln, page)
                continue
            if RE_MUST.match(text):
                modes[col] = 'must'
                continue
            if RE_CONF.match(text):
                modes[col] = 'conf'
                if col == 'L':          # заголовок на всю ширину, список в две колонки
                    modes['R'] = 'conf'
                continue
            mode = modes[col]
            if mode == 'must':
                topic['must'].add(ln, page, note=grey)
            elif mode == 'conf':
                topic['conf'].add(ln, page)
            elif mode is None:
                log.append(f'! стр. {page} ({col}): текст вне разделов: {text[:70]}')
            # mode == 'ex': подписи к скриншотам примеров не берём
    return groups


# ---------- названия и ссылки «Не путать с темами» ----------

ABBR = {'ЖКХ', 'ЖКУ', 'МКД', 'ТКО', 'ЖБО', 'СВО', 'ЧС', 'УК', 'ТСЖ', 'РСО', 'ФАП', 'ФЗ', 'МАФ', 'ЦУР', 'ПДД',
        'ДТП', 'МФЦ', 'ДОУ', 'ИЖС', 'СНТ', 'ЛЭП', 'СМИ', 'ОМС', 'КМНС', 'ОВЗ', 'ВОВ', 'ГТО', 'ЕГЭ', 'ОГЭ',
        'ГИА', 'СПО', 'СОШ', 'ВПР', 'БОМЖ', 'QR', 'ДНР', 'ЛНР', 'РФ', 'ЧАЭС', 'МСЭ', 'ФОК', 'ГИБДД', 'ОКН', 'ТЦ', 'ТВ', 'ВКС',
        'ДЭГ', 'АЗС', 'ГСМ', 'ЖД', 'СИМ', 'ЕДВ', 'МЧС', 'МВД', 'ПФР', 'СФР', 'ФСС', 'ЦЗН', 'КДН', 'НКО',
        'ИП', 'ООПТ', 'ГО', 'ЛПХ', 'КФХ', 'ВВК', 'IT', 'ИТ', 'ПВЗ', 'ГАС', 'ГЭС', 'АЭС', 'ТЭЦ', 'ЗАГС'}
PROPER = {'россии': 'России', 'москвы': 'Москвы', 'сосновского': 'Сосновского', 'пушкинская': 'Пушкинская',
          'красная': 'Красная', 'севера': 'Севера', 'юнармия': 'Юнармия', 'госуслуги': 'Госуслуги',
          'covid-19': 'COVID-19'}
# Точечные правки отображаемых названий (официальное название для копирования не меняется)
TITLE_FIXES = {'"детей войны"': '«Детей войны»', '"маяк"': '«Маяк»', 'МФЦ мои документы': 'МФЦ «Мои документы»'}


def key(name):
    t = name.lower().replace('ё', 'е')
    t = re.sub(r'[«»"“”()\[\],.;:!?–—\-/\\*]', ' ', t)
    t = re.sub(r'\bв т ?ч\b', 'в т ч', t)
    return ' '.join(t.split())


def sentence_case(name):
    """«ЖАЛОБЫ НА МИГРАНТОВ» → «Жалобы на мигрантов» (аббревиатуры сохраняются)."""
    parts = re.split(r'([\s(),/\\\-«»"*.;:]+)', name)
    out = []
    for w in parts:
        if w.upper() in ABBR:
            out.append(w.upper())
        else:
            lw = w.lower()
            out.append(PROPER.get(lw, lw))
    s = ''.join(out)
    for a, b in TITLE_FIXES.items():
        s = s.replace(a, b)
    for i, ch in enumerate(s):
        if ch.isalpha():
            return s[:i] + ch.upper() + s[i + 1:]
    return s


def stable_id(prefix, text, used):
    """Короткий id из хеша названия: ссылки на темы не ломаются при пересборке."""
    h = 0x811C9DC5
    for ch in text.encode('utf-8'):
        h = ((h ^ ch) * 0x01000193) & 0xFFFFFFFF
    n = 0
    while True:
        v, out = h + n, ''
        for _ in range(5):
            v, r = divmod(v, 36)
            out += '0123456789abcdefghijklmnopqrstuvwxyz'[r]
        if prefix + out not in used:
            used.add(prefix + out)
            return prefix + out
        n += 1


def build(groups):
    by_key = {}
    data = []
    used = set()
    for g in groups:
        subs = []
        for s in g['subs']:
            subs.append(dict(name=sentence_case(s['name']), intro=s['intro'].blocks))
        gd = dict(id=stable_id('g', g['name'], used), name=g['name'], title=sentence_case(g['name']), color=g['color'],
                  page=g['page'], intro=g['intro'].blocks, subs=subs, topics=[])
        for t in g['topics']:
            items, notes = confuse_items(t['conf'].blocks)
            name = norm_ws(t['name'].replace('*', ''))
            td = dict(id=stable_id('t', g['name'] + '|' + name, used), name=name, title=sentence_case(name),
                      sub=sentence_case(t['sub']) if t['sub'] else None, page=t['page'],
                      must=split_footnotes(t['must'].blocks), conf=[dict(text=c) for c in items])
            if notes:
                td['confNote'] = ' '.join(notes)
            gd['topics'].append(td)
            by_key.setdefault(key(name), td)
        data.append(gd)

    # «Не путать» → ссылки на темы, группы и блоки
    topics = [t for g in data for t in g['topics']]
    groups_by_key = {key(g['name']): g for g in data}
    groups_by_key.update({key(a): groups_by_key[key(b)] for a, b in GROUP_ALIASES.items()})
    subs = [(g, s) for g in data for s in g['subs']]
    unresolved, fuzzy = [], []
    for g in data:
        for t in g['topics']:
            for c in t['conf']:
                text = c['text']
                m = re.search(r'групп[аеуы]? тем\s*[«"](.+?)[»"]', text, re.I)
                if m and key(m.group(1)) in groups_by_key:
                    c['group'] = groups_by_key[key(m.group(1))]['id']
                    continue
                m = re.search(r'блок[еау]?\s*[«"](.+?)[»"]\s*(:\s*(.+))?', text, re.I)
                if m and not m.group(3):
                    hit = best_match(m.group(1), subs, lambda gs: gs[1]['name'])
                    if hit:
                        c['group'], c['sub'] = hit[0]['id'], hit[1]['name']
                        continue
                hit, how = resolve(text, topics, by_key)
                if hit:
                    if hit['id'] != t['id']:
                        c['ref'] = hit['id']
                    if how != 'exact':
                        fuzzy.append((how, text, hit['name']))
                else:
                    unresolved.append((t['name'], text))
    return data, unresolved, fuzzy


# Ручные соответствия для ссылок, которые в PDF записаны иначе, чем называется тема.
# Ключ — текст ссылки без скобок; значение — точное название темы ('' — не ссылаться).
ALIASES = {
    'Уборка дорог': 'УБОРКА ДОРОГ ОТ ПЫЛИ, СМЁТА, ЛИСТВЫ',               # «(кроме снега и наледи)»
    'Уборка тротуаров': 'УБОРКА ТРОТУАРОВ ОТ МУСОРА, СМЁТА, ЛИСТВЫ',      # «(кроме снега и наледи)»
    'Выбросы вредных веществ в водоёмы': 'ЗАГРЯЗНЕНИЕ ВОДНЫХ ОБЪЕКТОВ И НАРУШЕНИЯ ВОДООХРАННЫХ ЗОН',
    'Выбросы вредных веществ в почву': 'ЗАГРЯЗНЕНИЕ ПОЧВ',
    'Поддержка молодых семей': '',
    'Опиловка и спил деревьев': 'ВЫРУБКА, ОПИЛОВКА И СПИЛ ДЕРЕВЬЕВ (В Т.Ч. КУСТАРНИКОВ)',
    'Поддержка лиц БОМЖ': 'ПОДДЕРЖКА ЛИЦ БОМЖ (ЗАПРОС ПОМОЩИ И Т.Д.)',
    'Создание доступной среды для инвалидов': 'СОЗДАНИЕ ДОСТУПНОЙ СРЕДЫ ДЛЯ МАЛОМОБИЛЬНЫХ ГРУПП ГРАЖДАН',
    'Жилье для детей-сирот': 'ПОДДЕРЖКА СИРОТ (ЗАПРОС ПОМОЩИ, ПРЕДОСТАВЛЕНИЕ ЖИЛЬЯ, ОТКАЗ И Т.Д.)',
    'Жалобы на поведение мигрантов': 'ЖАЛОБЫ НА МИГРАНТОВ, БЕЖЕНЦЕВ И ВЫНУЖДЕННЫХ ПЕРЕСЕЛЕНЦЕВ',
    'Жалобы на поведение беженцев': 'ЖАЛОБЫ НА МИГРАНТОВ, БЕЖЕНЦЕВ И ВЫНУЖДЕННЫХ ПЕРЕСЕЛЕНЦЕВ',
    'Неисправность или отсутствие освещения на автодорогах':
        'НЕИСПРАВНОСТЬ ИЛИ ОТСУТСТВИЕ ОСВЕЩЕНИЯ НА ДОРОГАХ И ТРОТУАРАХ',
    'Нарушение ПДД': 'НАРУШЕНИЕ ПРАВИЛ ДОРОЖНОГО ДВИЖЕНИЯ',
    'Несоблюдение экологических требований при обращении с отходами':
        'НАРУШЕНИЯ ПРИ ОБРАЩЕНИИ С ОТХОДАМИ (СЛИВ ЖБО, СБРОС МУСОРА И ДР.)',
    'Уборка, вывоз мусора вне населенных пунктов':
        'НАРУШЕНИЯ ПРИ ОБРАЩЕНИИ С ОТХОДАМИ (СЛИВ ЖБО, СБРОС МУСОРА И ДР.)',
    'Уборка, вывоз мусора в общественных пространствах': 'УБОРКА ОБЩЕСТВЕННЫХ ПРОСТРАНСТВ ОТ МУСОРА, СМЁТА, ЛИСТВЫ',
    'Федеральное, региональное, муниципальное имущество': 'ГОСУДАРСТВЕННОЕ И МУНИЦИПАЛЬНОЕ ИМУЩЕСТВО',
    'Отсутствие лекарств в учреждениях здравоохранения':
        'НЕХВАТКА ЛЕКАРСТВ И РАСХОДНЫХ МАТЕРИАЛОВ В УЧРЕЖДЕНИЯХ ЗДРАВООХРАНЕНИЯ',
    'Отсутствие, нехватка медицинских работников': 'НЕХВАТКА МЕДРАБОТНИКОВ (В Т.Ч. УЗКОПРОФИЛЬНЫХ)',
    'Оказание медицинской помощи не в полном объеме или отказ в оказании медицинской помощи':
        'НЕКАЧЕСТВЕННОЕ ОКАЗАНИЕ МЕДПОМОЩИ (В Т.Ч. ОТКАЗ)',
    'Работа детских оздоровительных лагерей': 'ДЕТСКИЙ ОТДЫХ',
    'Государственное и муниципальное управление прочее': '',
    'Предоставление жилищных субсидий, льгот': 'УЛУЧШЕНИЕ ЖИЛИЩНЫХ УСЛОВИЙ, СОЦИАЛЬНЫЙ НАЙМ ЖИЛЬЯ',
}
GROUP_ALIASES = {'Социальная защита': 'СОЦИАЛЬНОЕ ОБСЛУЖИВАНИЕ И ЗАЩИТА'}

STOP = {'и', 'в', 'во', 'на', 'с', 'со', 'по', 'от', 'для', 'т', 'ч', 'из', 'за', 'к', 'о', 'об', 'или', 'а',
        'при', 'до', 'их', 'том', 'числе', 'др', 'пр', 'тд', 'д', 'прочее'}


def strip_parens(text):
    return norm_ws(re.sub(r'\([^()]*\)?', ' ', text))


def stems(text):
    return {w[:max(4, len(w) - 3)] if len(w) > 5 else w for w in key(text).split() if w not in STOP}


def best_match(text, items, name_of, threshold=0.66):
    """Нечёткое сравнение по основам слов (без скобок): лучший вариант с заметным отрывом."""
    a = stems(strip_parens(text))
    if not a:
        return None
    scored = []
    for it in items:
        b = stems(strip_parens(name_of(it)))
        inter = len(a & b)
        if inter:
            scored.append((2 * inter / (len(a) + len(b)), it))
    scored.sort(key=lambda x: -x[0])
    if scored and scored[0][0] >= threshold and (len(scored) == 1 or scored[0][0] - scored[1][0] >= 0.08):
        return scored[0][1]
    return None


def resolve(text, topics, by_key):
    """Ищет тему по тексту ссылки: точное имя → без скобок → после двоеточия → «к теме «…»» → нечётко."""
    alias_keys = {key(k): v for k, v in ALIASES.items()}
    variants = [text, strip_parens(text)]
    if ':' in text:
        tail = text.rsplit(':', 1)[1]
        variants += [tail, strip_parens(tail)]
    m = re.search(r'тем[еуы]\s*[«"](.+?)[»"]', text)
    if m:
        variants.append(m.group(1))
    for i, v in enumerate(variants):
        k = key(v)
        if k in alias_keys:
            name = alias_keys[k]
            return (by_key[key(name)], 'alias') if name else (None, '')
        if k in by_key:
            return by_key[k], 'exact' if i == 0 else 'variant'
    hit = best_match(variants[-1] if ':' in text else text, topics, lambda t: t['name'])
    return (hit, 'fuzzy') if hit else (None, '')


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    log = []
    groups = parse(sys.argv[1], log)
    data, unresolved, fuzzy = build(groups)

    payload = json.dumps(dict(groups=data), ensure_ascii=False, separators=(',', ':'))
    js = ('// Сгенерировано tools/build_data.py из PDF «Свод документации по Классификатору».\n'
          '// Не редактируйте вручную — пересоберите скриптом.\n'
          'window.CLASSIFIER = ' + payload + ';\n')
    OUT.write_text(js, encoding='utf-8')
    # метка версии в index.html, чтобы браузеры и GitHub Pages не держали старый data.js в кэше
    index = OUT.parent / 'index.html'
    if index.exists():
        ver = hashlib.sha1(js.encode('utf-8')).hexdigest()[:8]
        html = index.read_text(encoding='utf-8')
        index.write_text(re.sub(r'data\.js(\?v=[\w]*)?"', f'data.js?v={ver}"', html), encoding='utf-8')

    verbose = '-v' in sys.argv
    for line in log:
        if verbose or line.startswith('!'):
            print(line, file=sys.stderr)
    print(f'Групп: {len(data)}, тем: {sum(len(g["topics"]) for g in data)} → {OUT}')
    for g in data:
        m = re.search(r'содержит (\d+) тем', ' '.join(b['text'] for b in g['intro']))
        if m and int(m.group(1)) != len(g['topics']):
            print(f'  ⚠ {g["name"]}: в описании {m.group(1)} тем, найдено {len(g["topics"])}', file=sys.stderr)
    if verbose and fuzzy:
        print(f'Нечёткие совпадения «Не путать» ({len(fuzzy)}):', file=sys.stderr)
        for how, text, name in sorted(fuzzy):
            print(f'  {how:7} {text}  ⇒  {name}', file=sys.stderr)
    if unresolved:
        print(f'Ссылки «Не путать» без точного совпадения с темой: {len(unresolved)} (показываются текстом)',
              file=sys.stderr)
        if verbose:
            for t, c in unresolved:
                print(f'  {t[:50]} → {c}', file=sys.stderr)


if __name__ == '__main__':
    main()
