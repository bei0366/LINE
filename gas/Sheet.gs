/**
 * スプレッドシートの読み書き。
 * 列は見出し（1行目）の名前で探すため、管理用の列を追加したり並べ替えたりしても動作します。
 * 見出しの文字は変更しないでください。
 */

var REG_SHEET = 'スタッフ登録';
var ONB_SHEET = '労務情報';

var STATUS = {
  PRE: '仮登録',             // フォーム送信済み。面談・選考待ち
  HIRED: '採用',             // 管理者が設定 → 書類提出の案内を自動送信
  DOC_REQUESTED: '書類依頼済', // 案内を送信済み
  DOC_SUBMITTED: '書類提出済', // 書類フォーム送信済み。管理者が内容を確認
  ACTIVE: '稼働可',           // 確認完了。シフトに入れる状態
  REJECTED: '不採用',
  LEFT: '退会'
};

/** 書類提出フォームを使える状態 */
var ONBOARDING_ALLOWED = [STATUS.HIRED, STATUS.DOC_REQUESTED, STATUS.DOC_SUBMITTED];

var COLUMNS = {};

COLUMNS[REG_SHEET] = [
  ['userId', 'LINEユーザーID'],
  ['status', 'ステータス'],
  ['lineName', 'LINE表示名'],
  ['registeredAt', '初回登録日時'],
  ['updatedAt', '最終更新日時'],
  ['lastName', '姓'],
  ['firstName', '名'],
  ['lastNameKana', 'セイ'],
  ['firstNameKana', 'メイ'],
  ['birthDate', '生年月日'],
  ['age', '年齢（登録時）'],
  ['ageNote', '年齢による制限'],
  ['gender', '性別'],
  ['phone', '電話番号'],
  ['email', 'メールアドレス'],
  ['postalCode', '郵便番号'],
  ['prefecture', '都道府県'],
  ['city', '市区町村・番地'],
  ['building', '建物名・部屋番号'],
  ['nearestStation', '最寄り駅'],
  ['occupation', '職業区分'],
  ['weekdays', '勤務可能曜日'],
  ['timeSlots', '勤務可能時間帯'],
  ['areas', '希望エリア'],
  ['experiences', '経験業務'],
  ['licenses', '資格・免許'],
  ['languages', '語学'],
  ['height', '身長(cm)'],
  ['clothingSize', '服のサイズ'],
  ['shoeSize', '靴のサイズ(cm)'],
  ['hairColor', '髪色'],
  ['tattoo', '露出部位のタトゥー'],
  ['note', '自己PR・備考'],
  ['privacyConsentAt', '個人情報同意日時'],
  ['antisocialConsentAt', '反社会的勢力でない旨の表明日時'],
  ['blocked', 'LINEブロック'],
  ['adminMemo', '管理メモ']
];

COLUMNS[ONB_SHEET] = [
  ['userId', 'LINEユーザーID'],
  ['name', '氏名'],
  ['submittedAt', '初回提出日時'],
  ['updatedAt', '最終更新日時'],
  ['nationality', '国籍'],
  ['residenceStatus', '在留資格'],
  ['residenceExpiry', '在留期間の満了日'],
  ['workPermission', '資格外活動許可'],
  ['workCheck', '就労可否の確認事項'],
  ['residenceCardFront', '在留カード（表）'],
  ['residenceCardBack', '在留カード（裏）'],
  ['idType', '本人確認書類'],
  ['idFront', '本人確認書類（表）'],
  ['idBack', '本人確認書類（裏）'],
  ['facePhoto', '顔写真'],
  ['bankName', '銀行名'],
  ['branchName', '支店名'],
  ['accountType', '口座種別'],
  ['accountNumber', '口座番号'],
  ['accountHolder', '口座名義（カナ）'],
  ['emergencyName', '緊急連絡先 氏名'],
  ['emergencyRelation', '緊急連絡先 続柄'],
  ['emergencyPhone', '緊急連絡先 電話番号'],
  ['otherJob', '他社での勤務'],
  ['taxDeclarationElsewhere', '他社への扶養控除等申告書'],
  ['health', '健康上の配慮事項'],
  ['confidentialityConsentAt', '守秘義務同意日時'],
  ['verifiedBy', '書類確認者'],
  ['verifiedAt', '書類確認日']
];

function spreadsheet_() {
  return SpreadsheetApp.openById(getConfig_().spreadsheetId);
}

function sheet_(name) {
  var sh = spreadsheet_().getSheetByName(name);
  if (!sh) throw new Error('シート「' + name + '」がありません。setup を実行してください');
  return sh;
}

function now_() {
  return Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm:ss');
}

function labelOf_(sheetName, key) {
  var cols = COLUMNS[sheetName];
  for (var i = 0; i < cols.length; i++) if (cols[i][0] === key) return cols[i][1];
  throw new Error('未定義の項目です: ' + key);
}

/** 見出し名 → 列番号(0始まり) */
function headerMap_(sh) {
  var map = {};
  var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  headers.forEach(function (h, i) { if (h) map[h] = i; });
  return map;
}

function findRow_(sh, header, userId) {
  var last = sh.getLastRow();
  if (last < 2) return -1;
  var ids = sh.getRange(2, header['LINEユーザーID'] + 1, last - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) if (ids[i][0] === userId) return i + 2;
  return -1;
}

function rowToRecord_(sheetName, header, values) {
  var rec = {};
  COLUMNS[sheetName].forEach(function (c) {
    var i = header[c[1]];
    if (i !== undefined) rec[c[0]] = values[i];
  });
  return rec;
}

/** userId の行を読み込む。なければ null */
function readRecord_(sheetName, userId) {
  var sh = sheet_(sheetName);
  var header = headerMap_(sh);
  var row = findRow_(sh, header, userId);
  if (row < 0) return null;
  return rowToRecord_(sheetName, header, sh.getRange(row, 1, 1, sh.getLastColumn()).getValues()[0]);
}

/** 数式として解釈されないように（CSV/数式インジェクション対策） */
function cellValue_(v) {
  if (typeof v === 'string' && /^[=+\-@]/.test(v)) return "'" + v;
  return v;
}

/**
 * userId の行に fields を書き込む（なければ追加）。fields に含まれない列はそのまま残る。
 */
function writeRecord_(sheetName, userId, fields) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sh = sheet_(sheetName);
    var header = headerMap_(sh);
    var width = sh.getLastColumn();
    var row = findRow_(sh, header, userId);
    var values = row > 0 ? sh.getRange(row, 1, 1, width).getValues()[0] : new Array(width).fill('');
    fields.userId = userId;
    Object.keys(fields).forEach(function (key) {
      var label = labelOf_(sheetName, key);
      var i = header[label];
      if (i === undefined) throw new Error('シート「' + sheetName + '」に列「' + label + '」がありません');
      values[i] = cellValue_(fields[key]);
    });
    if (row < 0) row = sh.getLastRow() + 1;
    sh.getRange(row, 1, 1, width).setValues([values]);
  } finally {
    lock.releaseLock();
  }
}

function setStatus_(userId, status) {
  writeRecord_(REG_SHEET, userId, { status: status, updatedAt: now_() });
}

/** シートの作成・見出し・書式を整える（何度実行しても安全） */
function ensureSheet_(ss, name) {
  var sh = ss.getSheetByName(name) || ss.insertSheet(name);
  var cols = COLUMNS[name];
  var existing = sh.getLastColumn() ? sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0] : [];
  var missing = cols.map(function (c) { return c[1]; }).filter(function (l) { return existing.indexOf(l) < 0; });
  if (missing.length) {
    var start = existing.filter(String).length + 1;
    if (sh.getMaxColumns() < start + missing.length - 1) {
      sh.insertColumnsAfter(sh.getMaxColumns(), start + missing.length - 1 - sh.getMaxColumns());
    }
    sh.getRange(1, start, 1, missing.length).setValues([missing]);
  }
  sh.setFrozenRows(1);
  sh.setFrozenColumns(2);
  sh.getRange(1, 1, 1, sh.getLastColumn()).setFontWeight('bold').setBackground('#f3e5f5');
  // 電話番号・口座番号の先頭の0が消えないよう、すべて書式なしテキストにする
  sh.getRange(2, 1, sh.getMaxRows() - 1, sh.getLastColumn()).setNumberFormat('@');
  return sh;
}
