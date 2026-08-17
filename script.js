// ============================================================
//  ПОДБОР ГРУППЫ ТЕМ И ТЕМЫ — логика сайта
// ============================================================

// ---------- Элементы страницы ----------
const groupsList      = document.getElementById('groupsList');
const topicsList      = document.getElementById('topicsList');
const topicsSection   = document.getElementById('topicsSection');
const resultSection   = document.getElementById('resultSection');
const searchInput     = document.getElementById('searchInput');
const selectedGroupEl = document.getElementById('selectedGroup');
const selectedTopicEl = document.getElementById('selectedTopic');
const selectedDescEl  = document.getElementById('selectedDescription');
const statsEl         = document.getElementById('stats');
const notification    = document.getElementById('copyNotification');

// ---------- Состояние ----------
let allItems      = [];   // [{group, topic, description}, ...]
let selectedGroup = null; // название выбранной группы
let selectedTopic = null; // объект {topic, description}

// ============================================================
// 1. ЗАГРУЗКА ДАННЫХ ИЗ themes.json
// ============================================================
fetch('themes.json')
  .then(response => {
    if (!response.ok) throw new Error('HTTP ' + response.status);
    return response.text();
  })
  .then(text => {
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      // В файле встречаются кавычки внутри текста (например, "ДЕТИ ВОЙНЫ").
      // Аккуратно экранируем их и пробуем распарсить снова.
      data = JSON.parse(repairJSON(text));
    }
    allItems = normalize(data);
    init();
  })
  .catch(error => {
    groupsList.innerHTML =
      '<div class="empty">⚠️ Не удалось загрузить themes.json.<br><br>' +
      'Если вы открыли index.html двойным кликом — браузер блокирует загрузку данных. ' +
      'Запустите локальный сервер (см. Этап 4).<br><br>' +
      'Техническая ошибка: ' + error.message + '</div>';
  });

// Приводим данные к удобному виду: в вашем файле ключи и значения
// содержат лишние пробелы ("group ", "БЕЗОПАСНОСТЬ... ") — убираем их
function normalize(raw){
  return raw.map(item => {
    const get = name => {
      const key = Object.keys(item).find(k => k.trim().toLowerCase() === name);
      return key ? String(item[key]).trim() : '';
    };
    return {
      group:       get('group'),
      topic:       get('topic'),
      description: get('description')
    };
  }).filter(item => item.group && item.topic);
}

// Чинит JSON, если внутри строк встречаются «лишние» кавычки
function repairJSON(text){
  let result = '';
  let inString = false;
  for (let i = 0; i < text.length; i++){
    const ch = text[i];
    if (!inString){
      if (ch === '"') inString = true;
      result += ch;
    } else {
      if (ch === '\\'){                     // уже экранированный символ
        result += ch + (text[i + 1] || '');
        i++;
      } else if (ch === '"'){
        // Смотрим, какой значимый символ идёт после кавычки
        let j = i + 1;
        while (j < text.length && /\s/.test(text[j])) j++;
        const next = text[j];
        if (next === ',' || next === ':' || next === '}' || next === ']' || next === undefined){
          inString = false;                 // настоящая закрывающая кавычка
          result += ch;
        } else {
          result += '\\"';                  // кавычка внутри текста — экранируем
        }
      } else {
        result += ch;
      }
    }
  }
  return result;
}

// ============================================================
// 2. ИНИЦИАЛИЗАЦИЯ
// ============================================================
function init(){
  const groups = getGroups();
  statsEl.innerHTML = 'В базе: <b>' + groups.length + '</b> ' +
                      plural(groups.length, 'группа', 'группы', 'групп') +
                      ' и <b>' + allItems.length + '</b> ' +
                      plural(allItems.length, 'тема', 'темы', 'тем');

  renderGroups('');

  // Живой поиск
  searchInput.addEventListener('input', () => {
    const q = searchInput.value.trim().toLowerCase();
    const visible = renderGroups(q);
    if (selectedGroup){
      if (visible.includes(selectedGroup)){
        renderTopics(selectedGroup, q);
      } else {
        topicsSection.style.display = 'none';
        resultSection.style.display = 'none';
      }
    }
  });

  // Кнопки копирования
  document.getElementById('copyGroupBtn').addEventListener('click', () => {
    if (selectedGroup) copyText(selectedGroup);
  });
  document.getElementById('copyTopicBtn').addEventListener('click', () => {
    if (selectedTopic) copyText(selectedTopic.topic);
  });
  document.getElementById('copyBothBtn').addEventListener('click', () => {
    if (selectedGroup && selectedTopic) copyText(selectedGroup + '\n' + selectedTopic.topic);
  });
}

// ============================================================
// 3. ОТРИСОВКА ГРУПП
// ============================================================
function renderGroups(query){
  groupsList.innerHTML = '';
  const visible = [];

  for (const group of getGroups()){
    const topics  = topicsOf(group);
    const matches = topics.filter(t => t.topic.toLowerCase().includes(query));

    // При поиске показываем группу, если совпало её название
    // или в ней есть подходящие темы
    if (query && !group.toLowerCase().includes(query) && matches.length === 0) continue;

    visible.push(group);

    const card = document.createElement('div');
    card.className = 'group-item' + (group === selectedGroup ? ' selected' : '');
    card.dataset.group = group;
    card.style.animationDelay = (visible.length * 0.025) + 's';
    card.innerHTML =
      '<span>' + escapeHtml(group) + '</span>' +
      '<span class="count">' + topics.length + ' ' +
      plural(topics.length, 'тема', 'темы', 'тем') + '</span>';
    card.addEventListener('click', () => selectGroup(group));
    groupsList.appendChild(card);
  }

  if (visible.length === 0){
    groupsList.innerHTML = '<div class="empty">Ничего не найдено 🤷</div>';
  }
  return visible;
}

function selectGroup(group){
  selectedGroup = group;
  selectedTopic = null;
  resultSection.style.display = 'none';

  // Подсвечиваем выбранную карточку
  groupsList.querySelectorAll('.group-item').forEach(el => {
    el.classList.toggle('selected', el.dataset.group === group);
  });

  topicsSection.style.display = 'block';
  renderTopics(group, searchInput.value.trim().toLowerCase());
  topicsSection.scrollIntoView({ behavior: 'smooth' });
}

// ============================================================
// 4. ОТРИСОВКА ТЕМ
// ============================================================
function renderTopics(group, query){
  topicsList.innerHTML = '';
  let topics = topicsOf(group);

  // Если поиск совпал с названием группы, но не с темами —
  // показываем все темы группы
  if (query){
    const matches = topics.filter(t => t.topic.toLowerCase().includes(query));
    if (matches.length > 0) topics = matches;
  }

  topics.forEach((t, i) => {
    const row = document.createElement('div');
    row.className = 'topic-item' +
      (selectedTopic && selectedTopic.topic === t.topic ? ' selected' : '');
    row.style.animationDelay = (i * 0.02) + 's';
    row.textContent = t.topic;
    row.addEventListener('click', () => selectTopic(row, t));
    topicsList.appendChild(row);
  });
}

function selectTopic(rowEl, topic){
  selectedTopic = topic;
  topicsList.querySelectorAll('.topic-item').forEach(el => el.classList.remove('selected'));
  rowEl.classList.add('selected');

  selectedGroupEl.textContent = selectedGroup;
  selectedTopicEl.textContent = topic.topic;
  selectedDescEl.textContent  = topic.description || '—';

  resultSection.style.display = 'block';
  resultSection.scrollIntoView({ behavior: 'smooth' });
}

// ============================================================
// 5. КОПИРОВАНИЕ В БУФЕР ОБМЕНА
// ============================================================
function copyText(text){
  if (!text) return;
  const onSuccess = () => {
    const short = text.length > 45 ? text.slice(0, 45) + '…' : text;
    showNotification('✅ Скопировано: ' + short.replace(/\n/g, ' / '));
  };

  if (navigator.clipboard && window.isSecureContext){
    navigator.clipboard.writeText(text)
      .then(onSuccess)
      .catch(() => fallbackCopy(text, onSuccess));
  } else {
    fallbackCopy(text, onSuccess);   // запасной вариант
  }
}

function fallbackCopy(text, onSuccess){
  const area = document.createElement('textarea');
  area.value = text;
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  try {
    document.execCommand('copy');
    onSuccess();
  } catch (e) {
    showNotification('❌ Не удалось скопировать');
  }
  document.body.removeChild(area);
}

let notifyTimer;
function showNotification(message){
  notification.textContent = message;
  notification.classList.add('show');
  clearTimeout(notifyTimer);
  notifyTimer = setTimeout(() => notification.classList.remove('show'), 2000);
}

// ============================================================
// 6. ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ============================================================
function getGroups(){
  const groups = [];
  const seen = new Set();
  for (const item of allItems){
    if (!seen.has(item.group)){
      seen.add(item.group);
      groups.push(item.group);
    }
  }
  return groups;
}

function topicsOf(group){
  return allItems.filter(item => item.group === group);
}

function plural(n, one, few, many){
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
  return many;
}

function escapeHtml(s){
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}