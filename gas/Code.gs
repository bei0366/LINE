/**
 * セブンハーツ スタッフ登録ツール（Google Apps Script）
 *
 * - LINE公式アカウントの Webhook（友だち追加後、トークで質問してスタッフ登録・キーワード応答）
 * - LIFF フォームからの登録内容の変更・書類提出 API
 * - スプレッドシートでステータスを「採用」にすると書類提出の案内を自動送信
 *
 * 設定値はすべて「プロジェクトの設定 > スクリプト プロパティ」に保存します（README参照）。
 */

/** 個人情報の取り扱いページ（liff/privacy.html）。別のページを使う場合はスクリプト プロパティ PRIVACY_POLICY_URL で上書き */
var DEFAULT_PRIVACY_POLICY_URL = 'https://bei0366.github.io/LINE/liff/privacy.html';

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
    privacyPolicyUrl: p.PRIVACY_POLICY_URL || DEFAULT_PRIVACY_POLICY_URL,
    callUrl: (p.CALL_URL || '').trim()
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

/**
 * コードの版。コードを変えるたびに更新する。
 * checkSettings がウェブアプリ（デプロイ済み）の版と比べて、デプロイし忘れを見つける。
 */
var APP_VERSION = '2026-10-05.2';

function doGet() {
  return json_({ ok: true, service: 'sevenhearts-staff-registration', version: APP_VERSION });
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
  ensureSheet_(ss, CHAT_SHEET);

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

  // 「候補に送る（第1〜第4希望）」はチェックボックス
  var regHeader = headerMap_(reg);
  INTERVIEW_KEYS.forEach(function (k, i) {
    var col = regHeader[labelOf_(REG_SHEET, 'offer' + (i + 1))] + 1;
    reg.getRange(2, col, reg.getMaxRows() - 1, 1).insertCheckboxes();
  });

  var handlers = ScriptApp.getProjectTriggers().map(function (t) { return t.getHandlerFunction(); });
  if (handlers.indexOf('onStatusEdit') < 0) ScriptApp.newTrigger('onStatusEdit').forSpreadsheet(ss).onEdit().create();
  // リマインド・通話ボタン・不採用通知を時刻どおりに送るため、1分ごとに確認する
  if (handlers.indexOf('runScheduler') < 0) ScriptApp.newTrigger('runScheduler').timeBased().everyMinutes(1).create();

  console.log('セットアップ完了');
  console.log('Webhook URL: <ウェブアプリのURL>?token=' + props.getProperty('WEBHOOK_TOKEN'));
}

/**
 * インストール型トリガー（setup で登録）。「スタッフ登録」シートでステータスを変えたときの処理。
 * - 書類通過 → 面接候補を送って「面接日程調整中」に
 * - 面接確定（管理者が手入力した場合）→ 確定の連絡と LINEコールの使い方を送る
 * - 書類落選・不採用 → 変更時刻を記録（通知は runScheduler が次の午前10時に送る）
 * - 採用 → 書類提出の案内を送って「書類依頼済」に
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
    if (!rec.userId) return;
    try {
      writeRecord_(REG_SHEET, rec.userId, { statusChangedAt: now_(), rejectNotifiedAt: '', updatedAt: now_() });
      switch (rec.status) {
        case STATUS.DOC_PASSED:
          sendInterviewOffer_(rec);
          break;
        case STATUS.INTERVIEW_FIXED:
          sendInterviewFixedByAdmin_(rec);
          break;
        case STATUS.HIRED:
          var sent = pushMessage_(rec.userId, [
            textMessage_(fullName_(rec) + ' さん\n\n選考の結果、セブンハーツのスタッフとして採用となりました！\n\n' +
              'お仕事を始めていただくために、下のボタンから書類をご提出ください。'),
            onboardingButton_()
          ]);
          if (sent) setStatus_(rec.userId, STATUS.DOC_REQUESTED);
          break;
      }
    } catch (err) {
      console.error('onStatusEdit failed', rec.userId, err && err.stack || err);
    }
  });
}
