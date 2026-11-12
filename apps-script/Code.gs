/**
 * OnCue Transport — VTO vehicle check.
 *
 * This is the web app the phone posts to. Paste it into the Apps Script
 * editor attached to the fleet Google Sheet, set the two script properties
 * named in README.md, then deploy it as a web app (execute as you, access
 * "Anyone"). The phone only shows success when this script returns
 * {"ok":true,"received":true}.
 *
 * Script properties (Project settings → Script properties), not in this file
 * so the token is not stored in the public GitHub repo:
 *   SUBMIT_TOKEN      required. Same long random text as SUBMIT_TOKEN in index.html.
 *   DRIVE_FOLDER_ID   required. The Drive folder that stores photos and signatures.
 *   SHEET_NAME        optional. Tab that receives rows. If empty, the first tab is
 *                     used, unless that tab is named Registrations.
 *   SPREADSHEET_ID    optional. Only if this project was not opened from the sheet.
 */

var SERVICE = 'oncue-vto';
var VERSION = 2;
var PLACEHOLDER_TOKEN = 'REPLACE_WITH_SHARED_TOKEN';

var COLUMN_DEFS = [
  { key: 'checkId', title: 'Check ID', aliases: ['check id', 'checkid'] },
  { key: 'date', title: 'Date', aliases: ['date'] },
  { key: 'time', title: 'Time', aliases: ['time'] },
  { key: 'vtoName', title: 'VTO Name', aliases: ['vto name', 'vtoname', 'vto'] },
  { key: 'vrn', title: 'VRN', aliases: ['vrn', 'registration', 'vehicle registration'] },
  { key: 'vehicleType', title: 'Vehicle Type', aliases: ['vehicle type', 'vehicletype'] },
  { key: 'odometer', title: 'Odometer', aliases: ['odometer', 'mileage'] },
  { key: 'fuelLevel', title: 'Fuel Level', aliases: ['fuel level', 'fuellevel'] },
  { key: 'handoverNotes', title: 'Handover Notes', aliases: ['handover notes', 'handovernotes'] },
  { key: 'finalNotes', title: 'Final Notes', aliases: ['final notes', 'finalnotes'] },
  { key: 'vehicleReady', title: 'Vehicle Ready', aliases: ['vehicle ready', 'vehicleready'] },
  { key: 'photoCount', title: 'Photo Count', aliases: ['photo count', 'photocount'] },
  { key: 'checks', title: 'Checks', aliases: ['checks', 'checklist'] },
  { key: 'defects', title: 'Defects', aliases: ['defects'] },
  { key: 'signatureUrl', title: 'Signature', aliases: ['signature', 'signature url', 'signature link'] },
  { key: 'photoLinks', title: 'Photo Links', aliases: ['photo links', 'photolinks', 'photo urls'] },
  { key: 'submittedAt', title: 'Submitted At', aliases: ['submitted at', 'submittedat', 'server time'] }
];

var PHOTO_SECTIONS = ['handover', 'visual', 'clean', 'equip', 'mech'];

/**
 * Run this once from the editor (Run → testSetup) after setting the
 * properties. The execution log should say the token and folder are ready.
 */
function testSetup() {
  var lines = [];
  var token = expectedToken_();
  if (!token) lines.push('NOT READY: add a script property named SUBMIT_TOKEN.');
  else if (token === PLACEHOLDER_TOKEN) lines.push('NOT READY: SUBMIT_TOKEN is still the sample value. Choose a long random token and put the same text in index.html.');
  else lines.push('SUBMIT_TOKEN is set.');
  try {
    lines.push('Drive folder: ' + driveFolder_().getName());
  } catch (err) {
    lines.push('NOT READY: ' + err.message);
  }
  try {
    var ss = spreadsheet_();
    lines.push('Google Sheet: ' + ss.getName());
    var sheet = checksSheet_(ss, false);
    lines.push(sheet ? ('Checks will be added to tab: ' + sheet.getName()) : 'A checks tab will be created on the first submission.');
  } catch (err) {
    lines.push('NOT READY: ' + err.message);
  }
  var book = loadRegistry_();
  lines.push(book.length
    ? ('Registrations tab: ' + book.length + ' vehicle(s). Unknown registrations will be rejected.')
    : 'Registrations tab is empty or missing. Any registration will be accepted until you add rows.');
  Logger.log(lines.join('\n'));
}

function doGet(e) {
  try {
    var action = e && e.parameter && e.parameter.action ? String(e.parameter.action) : '';
    if (action === 'vehicles') return jsonOut_(vehiclesPayload_());
    if (action === 'status') return jsonOut_(statusPayload_(e && e.parameter ? e.parameter.checkId : ''));
    return jsonOut_({ ok: true, service: SERVICE, version: VERSION });
  } catch (err) {
    return jsonOut_(fail_(err.message, true));
  }
}

function doPost(e) {
  try {
    return jsonOut_(handlePost_(e));
  } catch (err) {
    var message = String(err && err.message ? err.message : err);
    var readable = message.indexOf('not readable') !== -1;
    return jsonOut_(fail_(readable ? message : ('Server error: ' + message), !readable));
  }
}

function handlePost_(e) {
  var incoming = readIncoming_(e);
  var tokenProblem = tokenProblem_(incoming.token);
  if (tokenProblem) return tokenProblem;
  if (!incoming.data || typeof incoming.data !== 'object' || Array.isArray(incoming.data)) {
    return fail_('Check data was not readable', false);
  }
  var data = incoming.data;
  delete data.token;

  var problem = validate_(data);
  if (problem) return fail_(problem, false);

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) {
    return fail_('The server is busy. This check is saved on the phone and will be sent again.', true);
  }
  try {
    var ss = spreadsheet_();
    var regProblem = registrationProblem_(ss, data);
    if (regProblem) return fail_(regProblem, false);

    var sheet = checksSheet_(ss, true);
    var cols = ensureColumns_(sheet);
    if (cols.error) return fail_(cols.error, true);

    var existing = findCheckRow_(sheet, cols, data.checkId);
    if (existing) {
      return {
        ok: true,
        received: true,
        duplicate: true,
        checkId: data.checkId,
        service: SERVICE,
        version: VERSION
      };
    }

    var saved = saveMedia_(driveFolder_(), data);
    appendRow_(sheet, cols, data, saved.signatureUrl, saved.photoLinks);
    return {
      ok: true,
      received: true,
      checkId: data.checkId,
      service: SERVICE,
      version: VERSION
    };
  } finally {
    lock.releaseLock();
  }
}

function fail_(message, retryable) {
  return {
    ok: false,
    error: String(message || 'The server rejected this check.'),
    retryable: !!retryable,
    service: SERVICE,
    version: VERSION
  };
}

/** text/plain, not JSON. A JSON content type makes some mobile browsers drop the body after Apps Script's redirect. */
function jsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.TEXT);
}

function expectedToken_() {
  var token = PropertiesService.getScriptProperties().getProperty('SUBMIT_TOKEN');
  return token ? String(token).trim() : '';
}

function tokenProblem_(provided) {
  var expected = expectedToken_();
  if (!expected) {
    return fail_('The Google script has no SUBMIT_TOKEN yet, so the check was not filed. It is saved on this phone.', true);
  }
  if (expected === PLACEHOLDER_TOKEN) {
    return fail_('The shared token is still the sample value. Choose a real token in the script properties and in index.html.', true);
  }
  if (!safeEqual_(String(provided || ''), expected)) {
    return fail_('This phone and the Google script do not have the same token, so the check was not filed. It is saved on this phone.', false);
  }
  return null;
}

function safeEqual_(a, b) {
  var n = Math.max(a.length, b.length);
  var diff = a.length === b.length ? 0 : 1;
  for (var i = 0; i < n; i++) {
    var ca = i < a.length ? a.charCodeAt(i) : 0;
    var cb = i < b.length ? b.charCodeAt(i) : 0;
    diff = diff | (ca ^ cb);
  }
  return diff === 0;
}

function readIncoming_(e) {
  var token = '';
  var data = null;
  try {
    if (e && e.parameter && e.parameter.payload) {
      token = e.parameter.token ? String(e.parameter.token) : '';
      data = JSON.parse(e.parameter.payload);
    } else if (e && e.postData && e.postData.contents) {
      var type = String(e.postData.type || '').toLowerCase();
      if (type.indexOf('application/x-www-form-urlencoded') === 0) {
        var params = parseForm_(e.postData.contents);
        token = params.token || '';
        if (!params.payload) throw new Error('Check data was not readable');
        data = JSON.parse(params.payload);
      } else {
        data = JSON.parse(e.postData.contents);
        if (data && data.token) token = String(data.token);
      }
    }
  } catch (err) {
    throw new Error('Check data was not readable');
  }
  if (!data) throw new Error('Check data was not readable');
  return { token: token, data: data };
}

function parseForm_(raw) {
  var out = {};
  String(raw || '').split('&').forEach(function (part) {
    if (!part) return;
    var eq = part.indexOf('=');
    var key = decodeURIComponent((eq === -1 ? part : part.substring(0, eq)).replace(/\+/g, ' '));
    var value = decodeURIComponent((eq === -1 ? '' : part.substring(eq + 1)).replace(/\+/g, ' '));
    out[key] = value;
  });
  return out;
}

function validate_(data) {
  if (!clip_(data.vtoName, 80)) return 'The VTO name is missing, so the check was not filed.';
  if (!clip_(data.vrn, 16)) return 'The registration is missing, so the check was not filed.';
  var vrn = normaliseVrn_(data.vrn);
  if (vrn.length < 2 || vrn.length > 8) return 'That registration does not look valid, so the check was not filed.';
  if (!vehicleTypeKey_(data.vehicleType)) return 'The vehicle type is not recognised, so the check was not filed.';
  if (typeof data.vehicleReady !== 'boolean') return 'Ready or not ready was missing, so the check was not filed.';
  if (!validCheckId_(data.checkId)) return 'This check is missing its reference, so it was not filed.';
  if (!data.checks || typeof data.checks !== 'object' || Array.isArray(data.checks)) {
    return 'The checklist was missing, so the check was not filed.';
  }
  if (Object.keys(data.checks).length > 250) return 'The checklist is too large, so the check was not filed.';
  if (!validImage_(data.signature, 200000)) return 'The signature did not come through as an image, so the check was not filed. It is saved on this phone.';
  var photos = data.photos || {};
  var total = 0;
  for (var s = 0; s < PHOTO_SECTIONS.length; s++) {
    var list = photos[PHOTO_SECTIONS[s]];
    if (list == null) continue;
    if (!Array.isArray(list)) return 'The photos were not in the right format, so the check was not filed.';
    if (list.length > 8) return 'There are too many photos in one section, so the check was not filed.';
    for (var i = 0; i < list.length; i++) {
      if (!validImage_(list[i], 400000)) return 'One photo could not be used, so the check was not filed. It is saved on this phone.';
      total++;
    }
  }
  if (total > 12) return 'There are too many photos on this check, so it was not filed.';
  ['odometer', 'fuelLevel', 'date', 'time'].forEach(function (key) {
    if (data[key] != null && String(data[key]).length > 80) data[key] = clip_(data[key], 80);
  });
  data.handoverNotes = clip_(data.handoverNotes, 8000);
  data.finalNotes = clip_(data.finalNotes, 8000);
  data.vtoName = clip_(data.vtoName, 80);
  data.vrn = String(data.vrn).toUpperCase().replace(/\s+/g, ' ').trim();
  data.checks = cleanChecks_(data.checks);
  return '';
}

function validCheckId_(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{8,80}$/.test(id);
}

function validImage_(value, maxLen) {
  if (typeof value !== 'string') return false;
  if (value.length < 32 || value.length > maxLen) return false;
  var mime = imageMime_(value);
  if (!mime) return false;
  var comma = value.indexOf(',');
  var b64 = value.substring(comma + 1).replace(/\s/g, '');
  if (!b64 || b64.length < 16) return false;
  return /^[A-Za-z0-9+/]+={0,2}$/.test(b64);
}

function imageMime_(value) {
  if (value.indexOf('data:image/jpeg;base64,') === 0) return 'image/jpeg';
  if (value.indexOf('data:image/jpg;base64,') === 0) return 'image/jpeg';
  if (value.indexOf('data:image/png;base64,') === 0) return 'image/png';
  if (value.indexOf('data:image/webp;base64,') === 0) return 'image/webp';
  return '';
}

function cleanChecks_(checks) {
  var out = {};
  var keys = Object.keys(checks);
  for (var i = 0; i < keys.length; i++) {
    var id = keys[i];
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(id)) continue;
    var item = checks[id] || {};
    var result = String(item.result || '');
    if (['', 'pass', 'fail', 'na'].indexOf(result) === -1) result = '';
    var severity = String(item.severity || '');
    if (['', 'minor', 'major', 'unsafe'].indexOf(severity) === -1) severity = '';
    out[id] = { result: result, severity: severity, note: clip_(item.note, 500) };
  }
  return out;
}

function registrationProblem_(ss, data) {
  var book = loadRegistry_(ss);
  if (!book.length) return '';
  var want = normaliseVrn_(data.vrn);
  var match = null;
  for (var i = 0; i < book.length; i++) {
    if (book[i].vrn === want) {
      match = book[i];
      break;
    }
  }
  if (!match) {
    return "This registration is not on the fleet list, so the check was not filed. It is saved on this phone.";
  }
  var chosen = vehicleTypeKey_(data.vehicleType);
  if (match.type && chosen && match.type !== chosen) {
    return 'This registration is listed as ' + typeLabel_(match.type) + ', not ' + data.vehicleType + '. The check is saved on this phone. Change the vehicle type and try again.';
  }
  return '';
}

function vehicleTypeKey_(value) {
  var s = String(value || '').toLowerCase().trim();
  if (s === '2-crew ambulance' || s === '2crew' || s === '2-crew') return '2crew';
  if (s === 'wav') return 'wav';
  if (s === 'estate / green car' || s === 'estate') return 'estate';
  return '';
}

function typeLabel_(key) {
  if (key === '2crew') return 'a 2-crew ambulance';
  if (key === 'estate') return 'an estate / green car';
  return 'a WAV';
}

function vehiclesPayload_() {
  var book = loadRegistry_();
  if (!book.length) return { ok: true, service: SERVICE, version: VERSION, vehicles: null };
  var out = { '2crew': [], wav: [], estate: [] };
  var seen = {};
  book.forEach(function (row) {
    var keys = row.type ? [row.type] : ['2crew', 'wav', 'estate'];
    keys.forEach(function (key) {
      var id = key + ':' + row.vrn;
      if (seen[id]) return;
      seen[id] = true;
      out[key].push(row.display);
    });
  });
  return { ok: true, service: SERVICE, version: VERSION, vehicles: out };
}

function statusPayload_(checkId) {
  if (!validCheckId_(String(checkId || ''))) return fail_('Missing check id', false);
  var ss = spreadsheet_();
  var sheet = checksSheet_(ss, false);
  if (!sheet) return { ok: true, found: false, checkId: String(checkId), service: SERVICE, version: VERSION };
  var cols = headerColumns_(sheet);
  var row = 0;
  if (cols && cols.checkId) row = findCheckRow_(sheet, cols, String(checkId));
  else {
    var found = sheet.createTextFinder(String(checkId)).matchEntireCell(true).findNext();
    row = found ? found.getRow() : 0;
  }
  return { ok: true, found: row > 1, checkId: String(checkId), service: SERVICE, version: VERSION };
}

function spreadsheet_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('SPREADSHEET_ID');
  if (id && String(id).trim()) return SpreadsheetApp.openById(String(id).trim());
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) {
    throw new Error('This script is not attached to a Google Sheet. Open the sheet, choose Extensions, then Apps Script. Or set the SPREADSHEET_ID property.');
  }
  return ss;
}

function checksSheet_(ss, create) {
  var props = PropertiesService.getScriptProperties();
  var wanted = props.getProperty('SHEET_NAME');
  if (wanted && String(wanted).trim()) {
    var named = ss.getSheetByName(String(wanted).trim());
    if (named) return named;
    return create ? ss.insertSheet(String(wanted).trim()) : null;
  }
  var preferred = ss.getSheetByName('Vehicle Checks');
  if (preferred) return preferred;
  var sheets = ss.getSheets();
  if (sheets.length && sheets[0].getName() !== 'Registrations') return sheets[0];
  return create ? ss.insertSheet('Vehicle Checks') : null;
}

function driveFolder_() {
  var id = PropertiesService.getScriptProperties().getProperty('DRIVE_FOLDER_ID');
  if (!id || !String(id).trim()) {
    throw new Error('DRIVE_FOLDER_ID is not set. Create a Google Drive folder, copy the folder id from its web address, and add it as a script property.');
  }
  try {
    return DriveApp.getFolderById(String(id).trim());
  } catch (err) {
    throw new Error('The Drive folder could not be opened. Check DRIVE_FOLDER_ID and that this account can use the folder.');
  }
}

function loadRegistry_(ss) {
  var book = [];
  var sheet = (ss || spreadsheet_()).getSheetByName('Registrations');
  if (!sheet || sheet.getLastRow() < 1 || sheet.getLastColumn() < 1) return book;
  var rows = sheet.getRange(1, 1, sheet.getLastRow(), Math.min(sheet.getLastColumn(), 3)).getValues();
  var start = 0;
  if (rows.length && isRegistryHeader_(rows[0][0])) start = 1;
  var seen = {};
  for (var r = start; r < rows.length; r++) {
    var display = String(rows[r][0] || '').toUpperCase().replace(/\s+/g, ' ').trim();
    var vrn = normaliseVrn_(display);
    if (!vrn || seen[vrn]) continue;
    seen[vrn] = true;
    var type = rows[r].length > 1 ? registryType_(rows[r][1]) : '';
    book.push({ vrn: vrn, display: display, type: type });
  }
  return book;
}

function isRegistryHeader_(value) {
  var s = String(value || '').toLowerCase().trim();
  return s === 'vrn' || s === 'registration' || s === 'reg' || s === 'vehicle';
}

function registryType_(value) {
  var s = String(value || '').toLowerCase().trim();
  if (!s || s === 'type') return '';
  if (s === '2crew' || s === '2-crew' || s.indexOf('2-crew') !== -1 || s.indexOf('ambulance') !== -1) return '2crew';
  if (s === 'wav' || s.indexOf('wav') !== -1) return 'wav';
  if (s === 'estate' || s.indexOf('estate') !== -1 || s.indexOf('green') !== -1) return 'estate';
  return '';
}

function normaliseVrn_(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function ensureColumns_(sheet) {
  var lastRow = sheet.getLastRow();
  var width = Math.max(sheet.getLastColumn(), 1);
  var headers = [];
  if (lastRow >= 1 && sheet.getLastColumn() >= 1) {
    headers = sheet.getRange(1, 1, 1, width).getValues()[0];
  }
  var blank = !headers.length || headers.join('').trim() === '';
  if (lastRow === 0 || blank) {
    var titles = COLUMN_DEFS.map(function (col) { return col.title; });
    sheet.getRange(1, 1, 1, titles.length).setValues([titles]);
    sheet.getRange(1, 1, 1, titles.length).setFontWeight('bold');
    sheet.setFrozenRows(1);
    var created = {};
    COLUMN_DEFS.forEach(function (col, index) { created[col.key] = index + 1; });
    return created;
  }

  var cols = headerColumnsFrom_(headers);
  var recognised = 0;
  if (cols.vrn) recognised++;
  if (cols.vtoName) recognised++;
  if (cols.date) recognised++;
  if (cols.vehicleType) recognised++;
  if (!cols.vrn || recognised < 2) {
    return {
      error: 'The tab "' + sheet.getName() + '" already has rows, but row 1 is not a header this script understands. Add these headings along row 1 (or set the SHEET_NAME property to a new empty tab): ' +
        COLUMN_DEFS.map(function (col) { return col.title; }).join(', ') + '.'
    };
  }

  var used = 0;
  for (var i = 0; i < headers.length; i++) {
    if (String(headers[i] || '').trim()) used = i + 1;
  }
  COLUMN_DEFS.forEach(function (col) {
    if (cols[col.key]) return;
    used++;
    sheet.getRange(1, used).setValue(col.title);
    cols[col.key] = used;
  });
  return cols;
}

function headerColumns_(sheet) {
  if (!sheet || sheet.getLastRow() < 1 || sheet.getLastColumn() < 1) return null;
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var cols = headerColumnsFrom_(headers);
  return cols.checkId || cols.vrn ? cols : null;
}

function headerColumnsFrom_(headers) {
  var map = {};
  headers.forEach(function (header, index) {
    var norm = String(header || '').toLowerCase().replace(/\s+/g, ' ').trim();
    if (!norm) return;
    for (var i = 0; i < COLUMN_DEFS.length; i++) {
      var col = COLUMN_DEFS[i];
      if (map[col.key]) continue;
      var names = [col.title.toLowerCase()].concat(col.aliases);
      if (names.indexOf(norm) !== -1) map[col.key] = index + 1;
    }
  });
  return map;
}

function findCheckRow_(sheet, cols, checkId) {
  if (!checkId || !cols.checkId) return 0;
  var last = sheet.getLastRow();
  if (last < 2) return 0;
  var values = sheet.getRange(2, cols.checkId, last - 1, 1).getValues();
  for (var i = 0; i < values.length; i++) {
    if (String(values[i][0]) === String(checkId)) return i + 2;
  }
  return 0;
}

function saveMedia_(folder, data) {
  var base = normaliseVrn_(data.vrn).substring(0, 10) + '-' + String(data.checkId).replace(/[^A-Za-z0-9-]/g, '').substring(0, 18);
  var signatureUrl = saveDataUrl_(folder, data.signature, base + '-signature.' + extFor_(data.signature));
  var photoLinks = [];
  var photos = data.photos || {};
  PHOTO_SECTIONS.forEach(function (section) {
    var list = photos[section] || [];
    for (var i = 0; i < list.length; i++) {
      var url = saveDataUrl_(folder, list[i], base + '-' + section + '-' + (i + 1) + '.' + extFor_(list[i]));
      photoLinks.push(section + ': ' + url);
    }
  });
  return { signatureUrl: signatureUrl, photoLinks: photoLinks };
}

function extFor_(dataUrl) {
  var mime = imageMime_(dataUrl);
  if (mime === 'image/png') return 'png';
  if (mime === 'image/webp') return 'webp';
  return 'jpg';
}

function saveDataUrl_(folder, dataUrl, filename) {
  var mime = imageMime_(dataUrl);
  var comma = dataUrl.indexOf(',');
  var bytes = Utilities.base64Decode(dataUrl.substring(comma + 1).replace(/\s/g, ''));
  if (!bytes || bytes.length < 16) throw new Error('An image was empty, so the check was not filed.');
  if (bytes.length > 350000) throw new Error('An image was too large, so the check was not filed.');
  var blob = Utilities.newBlob(bytes, mime, filename);
  var file = folder.createFile(blob);
  try {
    file.setDescription('OnCue VTO vehicle check');
  } catch (ignore) {}
  return file.getUrl();
}

function appendRow_(sheet, cols, data, signatureUrl, photoLinks) {
  var checks = data.checks || {};
  var defects = [];
  Object.keys(checks).forEach(function (id) {
    var item = checks[id] || {};
    if (item.result === 'fail') {
      defects.push('[' + (item.severity || 'unrated') + '] ' + id + ': ' + (item.note || ''));
    }
  });
  var photoCount = data.photoCount;
  if (photoCount == null || photoCount === '' || isNaN(Number(photoCount))) photoCount = photoLinks.length;
  var values = {
    checkId: data.checkId,
    date: data.date,
    time: data.time,
    vtoName: data.vtoName,
    vrn: data.vrn,
    vehicleType: data.vehicleType,
    odometer: data.odometer,
    fuelLevel: data.fuelLevel,
    handoverNotes: data.handoverNotes,
    finalNotes: data.finalNotes,
    vehicleReady: data.vehicleReady ? 'READY TO GO' : 'NOT READY',
    photoCount: String(photoCount),
    checks: JSON.stringify(checks),
    defects: defects.join('\n'),
    signatureUrl: signatureUrl,
    photoLinks: photoLinks.join('\n'),
    submittedAt: Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'Europe/London', 'dd/MM/yyyy HH:mm:ss')
  };

  var width = 1;
  Object.keys(cols).forEach(function (key) {
    if (cols[key] > width) width = cols[key];
  });
  var row = [];
  for (var c = 0; c < width; c++) row.push('');
  Object.keys(values).forEach(function (key) {
    if (!cols[key]) return;
    row[cols[key] - 1] = cell_(values[key]);
  });
  sheet.getRange(sheet.getLastRow() + 1, 1, 1, width).setValues([row]);
}

function cell_(value) {
  if (value == null) return '';
  var text = String(value);
  if (text.length > 49000) text = text.substring(0, 49000);
  if (/^[=+\-@]/.test(text)) text = "'" + text;
  return text;
}

function clip_(value, max) {
  var text = String(value == null ? '' : value).trim();
  if (text.length > max) text = text.substring(0, max);
  return text;
}
