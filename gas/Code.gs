/**
 * セブンハーツ スタッフ登録ツール（Google Apps Script）
 *
 * - LINE公式アカウントの Webhook（友だち追加・キーワード応答）
 * - LIFF フォームからの登録・書類提出 API
 * - スプレッドシートでステータスを「採用」にすると書類提出の案内を自動送信
 *
 * 設定値はすべて「プロジェクトの設定 > スクリプト プロパティ」に保存します（README参照）。
 */

function getConfig_() {
  var p = PropertiesService.getScriptProperties().getProperties();
  return {
    channelAccessToken: p.CHANNEL_ACCESS_TOKEN,
    loginChannelId: p.LOGIN_CHANNEL_ID,
    liffId: p.LIFF_ID,
    webhookToken: p.WEBHOOK_TOKEN,
    spreadsheetId: p.SPREADSHEET_ID,
    driveFolderId: p.DRIVE_FOLDER_ID,
    adminEmail: p.ADMIN_EMAIL || '',
    privacyPolicyUrl: p.PRIVACY_POLICY_URL || ''
  };
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/**
 * LINE の Webhook（URL に ?token=... 付き）と、LIFF フォームからの API の両方を受ける。
 * Apps Script ではリクエストヘッダー（署名）を読めないため、Webhook は URL のトークンで本人確認する。
 */
function doPost(e) {
  var body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ ok: false, error: '不正なリクエストです' });
  }

  if (e.parameter && e.parameter.token !== undefined) {
    if (!getConfig_().webhookToken || e.parameter.token !== getConfig_().webhookToken) {
      return json_({ ok: false });
    }
    handleWebhook_(body);
    return json_({ ok: true });
  }

  return json_(handleApi_(body));
}

function doGet() {
  return json_({ ok: true, service: 'sevenhearts-staff-registration' });
}

/** 新しい登録・書類提出を管理者にメールで知らせる（個人情報は本文に含めない） */
function notifyAdmin_(subject, name) {
  var to = getConfig_().adminEmail;
  if (!to) return;
  try {
    MailApp.sendEmail(to, '[セブンハーツ] ' + subject + '：' + name,
      name + ' さんの' + subject + 'がありました。\n内容はスプレッドシートで確認してください。\n' + spreadsheet_().getUrl());
  } catch (err) {
    console.error('notifyAdmin failed', err);
  }
}

/**
 * 初回セットアップ。Apps Script エディタで一度だけ実行してください（何度実行しても安全です）。
 * - シートの作成と見出しの設定
 * - 提出書類を保存する Google ドライブのフォルダの作成
 * - ステータス変更を検知するトリガーの登録
 */
function setup() {
  var props = PropertiesService.getScriptProperties();

  var ss = props.getProperty('SPREADSHEET_ID')
    ? SpreadsheetApp.openById(props.getProperty('SPREADSHEET_ID'))
    : SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('スプレッドシートから「拡張機能 > Apps Script」で開いたプロジェクトで実行するか、SPREADSHEET_ID を設定してください');
  props.setProperty('SPREADSHEET_ID', ss.getId());

  var reg = ensureSheet_(ss, REG_SHEET);
  ensureSheet_(ss, ONB_SHEET);

  var statusCol = headerMap_(reg)['ステータス'] + 1;
  var values = Object.keys(STATUS).map(function (k) { return STATUS[k]; });
  reg.getRange(2, statusCol, reg.getMaxRows() - 1, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(values, true).setAllowInvalid(false).build()
  );

  if (!props.getProperty('DRIVE_FOLDER_ID')) {
    var folder = DriveApp.createFolder('セブンハーツ_スタッフ提出書類');
    props.setProperty('DRIVE_FOLDER_ID', folder.getId());
  }

  if (!props.getProperty('WEBHOOK_TOKEN')) {
    props.setProperty('WEBHOOK_TOKEN', Utilities.getUuid().replace(/-/g, ''));
  }

  var hasTrigger = ScriptApp.getProjectTriggers().some(function (t) {
    return t.getHandlerFunction() === 'onStatusEdit';
  });
  if (!hasTrigger) ScriptApp.newTrigger('onStatusEdit').forSpreadsheet(ss).onEdit().create();

  console.log('セットアップ完了');
  console.log('Webhook URL: <ウェブアプリのURL>?token=' + props.getProperty('WEBHOOK_TOKEN'));
}

/**
 * インストール型トリガー（setup で登録）。
 * 「スタッフ登録」シートでステータスを「採用」にすると、本人に書類提出の案内を送り「書類依頼済」に変える。
 */
function onStatusEdit(e) {
  var sh = e.range.getSheet();
  if (sh.getName() !== REG_SHEET) return;
  var header = headerMap_(sh);
  var statusCol = header['ステータス'] + 1;
  if (e.range.getColumn() > statusCol || e.range.getLastColumn() < statusCol) return;

  var firstRow = Math.max(e.range.getRow(), 2);
  var lastRow = e.range.getLastRow();
  if (lastRow < firstRow) return;
  var rows = sh.getRange(firstRow, 1, lastRow - firstRow + 1, sh.getLastColumn()).getValues();

  rows.forEach(function (values) {
    var rec = rowToRecord_(REG_SHEET, header, values);
    if (rec.status !== STATUS.HIRED || !rec.userId) return;
    var sent = pushMessage_(rec.userId, [
      textMessage_(rec.lastName + ' ' + rec.firstName + ' さん\n\n選考の結果、セブンハーツのスタッフとして採用となりました！\n\n' +
        'お仕事を始めていただくために、下のボタンから書類をご提出ください。'),
      onboardingButton_()
    ]);
    if (sent) setStatus_(rec.userId, STATUS.DOC_REQUESTED);
  });
}
