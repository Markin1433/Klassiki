/**
 * Хранилище примечаний к темам классификатора — Google Apps Script.
 *
 * Установка (один раз):
 *   1. Создайте Google Таблицу, откройте «Расширения → Apps Script».
 *   2. Замените весь код в редакторе этим файлом и сохраните.
 *   3. «Начать развертывание → Новое развертывание» → тип «Веб-приложение»;
 *      «Запуск от имени» — Я, «У кого есть доступ» — Все. Разрешите доступ к таблице.
 *   4. Скопируйте URL веб-приложения (…/exec) в config.js сайта.
 *
 * Примечания хранятся на листе «Примечания». Удалённые не стираются — у них
 * ставится отметка в колонке «deleted», и их можно вернуть, сняв её в таблице.
 */

var SHEET_NAME = 'Примечания';
var HEADERS = ['id', 'created', 'updated', 'topicId', 'group', 'topic', 'author', 'text', 'deleted'];
var MAX_TEXT = 3000;
var MAX_AUTHOR = 80;

function doGet() {
  return json_({ ok: true, notes: listNotes_() });
}

function doPost(e) {
  var req;
  try {
    req = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ ok: false, error: 'Некорректный запрос' });
  }
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var sheet = sheet_();
    var now = new Date();
    if (req.action === 'add') {
      var text = clean_(req.text, MAX_TEXT);
      if (!text.trim()) return json_({ ok: false, error: 'Пустое примечание' });
      if (!/^t[0-9a-z]{3,12}$/.test(String(req.topicId || ''))) return json_({ ok: false, error: 'Неизвестная тема' });
      sheet.appendRow([
        Utilities.getUuid(), now, now, String(req.topicId),
        clean_(req.group, 300), clean_(req.topic, 500), clean_(req.author, MAX_AUTHOR), text, false,
      ]);
    } else if (req.action === 'edit' || req.action === 'delete') {
      var row = findRow_(sheet, req.id);
      if (!row) return json_({ ok: false, error: 'Примечание не найдено — возможно, его уже удалили' });
      if (req.action === 'edit') {
        var newText = clean_(req.text, MAX_TEXT);
        if (!newText.trim()) return json_({ ok: false, error: 'Пустое примечание' });
        sheet.getRange(row, col_('text')).setValue(newText);
        if (req.author != null) sheet.getRange(row, col_('author')).setValue(clean_(req.author, MAX_AUTHOR));
      } else {
        sheet.getRange(row, col_('deleted')).setValue(true);
      }
      sheet.getRange(row, col_('updated')).setValue(now);
    } else {
      return json_({ ok: false, error: 'Неизвестное действие' });
    }
    SpreadsheetApp.flush();
    return json_({ ok: true, notes: listNotes_() });
  } finally {
    lock.releaseLock();
  }
}

function listNotes_() {
  var sheet = sheet_();
  var last = sheet.getLastRow();
  if (last < 2) return [];
  var rows = sheet.getRange(2, 1, last - 1, HEADERS.length).getValues();
  var notes = [];
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    var deleted = r[8] === true || String(r[8]).toLowerCase() === 'true';
    if (!r[0] || deleted) continue;
    notes.push({
      id: String(r[0]), created: iso_(r[1]), updated: iso_(r[2]), topicId: String(r[3]),
      group: String(r[4]), topic: String(r[5]), author: String(r[6]), text: String(r[7]),
    });
  }
  return notes;
}

function sheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]).setFontWeight('bold');
    sheet.setFrozenRows(1);
    sheet.getRange('B:C').setNumberFormat('dd.MM.yyyy HH:mm');
    sheet.getRange('H:H').setWrap(true);
    sheet.setColumnWidth(8, 420);
  }
  return sheet;
}

function findRow_(sheet, id) {
  var last = sheet.getLastRow();
  if (!id || last < 2) return 0;
  var ids = sheet.getRange(2, 1, last - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(id)) return i + 2;
  }
  return 0;
}

function col_(name) {
  return HEADERS.indexOf(name) + 1;
}

/* Обрезает длину; текст, начинающийся с = + - @, таблица приняла бы за формулу. */
function clean_(value, max) {
  var s = String(value == null ? '' : value).slice(0, max);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

function iso_(v) {
  return v instanceof Date ? v.toISOString() : String(v || '');
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
