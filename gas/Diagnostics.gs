/**
 * 設定の点検。Apps Script エディタで checkSettings を選んで「実行」すると、
 * 実行ログに各項目の結果（✅ / ❌ / ⚠️）と直し方を表示します。
 */
function checkSettings() {
  var props = PropertiesService.getScriptProperties().getProperties();
  var lines = [];
  function ok(msg) { lines.push('✅ ' + msg); }
  function ng(msg) { lines.push('❌ ' + msg); }
  function warn(msg) { lines.push('⚠️ ' + msg); }

  // 1. スクリプト プロパティ
  ['CHANNEL_ACCESS_TOKEN', 'LOGIN_CHANNEL_ID', 'LIFF_ID', 'WEBHOOK_TOKEN', 'SPREADSHEET_ID', 'DRIVE_FOLDER_ID'].forEach(function (k) {
    var v = props[k];
    if (!v) return ng(k + ' が未設定です（プロジェクトの設定 > スクリプト プロパティ）');
    if (v !== v.trim()) return ng(k + ' の前後に空白や改行が入っています。消してください');
    ok(k + ' は設定済み');
  });
  if (props.LOGIN_CHANNEL_ID && !/^\d{10}$/.test(props.LOGIN_CHANNEL_ID.trim())) {
    ng('LOGIN_CHANNEL_ID は10桁の数字です（LINEログインチャネルの「チャネルID」）。現在：' + props.LOGIN_CHANNEL_ID);
  }
  if (props.LIFF_ID && !/^\d{10}-\w{8}$/.test(props.LIFF_ID.trim())) {
    ng('LIFF_ID の形式が違います（例：1234567890-AbCdEfGh）。現在：' + props.LIFF_ID);
  }
  if (props.LIFF_ID && props.LOGIN_CHANNEL_ID && props.LIFF_ID.split('-')[0] !== props.LOGIN_CHANNEL_ID.trim()) {
    warn('LIFF ID の前半（' + props.LIFF_ID.split('-')[0] + '）と LOGIN_CHANNEL_ID（' + props.LOGIN_CHANNEL_ID +
      '）が一致しません。LIFF を作った LINEログインチャネルのチャネルIDを入れてください');
  }

  // 2. チャネルアクセストークン
  var token = (props.CHANNEL_ACCESS_TOKEN || '').trim();
  if (token) {
    var info = UrlFetchApp.fetch(LINE_BOT_API + '/info', {
      headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true
    });
    if (info.getResponseCode() === 200) {
      var bot = JSON.parse(info.getContentText());
      ok('チャネルアクセストークンは有効です（公式アカウント：' + bot.displayName + ' ' + bot.basicId + '）');
    } else {
      ng('チャネルアクセストークンが無効です（' + info.getResponseCode() + '）。Messaging APIチャネルの' +
        '「Messaging API設定」で長期のトークンを発行し直して、全体をコピーしてください');
    }

    // 3. Webhook URL の設定
    var ep = UrlFetchApp.fetch(LINE_BOT_API + '/channel/webhook/endpoint', {
      headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true
    });
    if (ep.getResponseCode() === 200) {
      var endpoint = JSON.parse(ep.getContentText());
      var url = endpoint.endpoint || '';
      var expected = '?token=' + (props.WEBHOOK_TOKEN || '').trim();
      if (!url) {
        ng('Webhook URL が未設定です（Messaging APIチャネル > Messaging API設定 > Webhook URL）');
      } else if (!/^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec\?token=/.test(url)) {
        ng('Webhook URL の形式が違います。「ウェブアプリのURL（/exec で終わる）」＋「' + expected + '」にしてください。現在：' + url);
      } else if (url.slice(-expected.length) !== expected) {
        ng('Webhook URL の token が WEBHOOK_TOKEN と一致しません。末尾を「' + expected + '」にしてください。現在：' + url);
      } else {
        ok('Webhook URL は正しい形式です：' + url);
      }
      if (endpoint.active) ok('「Webhookの利用」はオンです');
      else ng('「Webhookの利用」がオフです（Messaging API設定 > Webhookの利用）');
    }
  }

  // 4. シート・トリガー
  try {
    var ss = SpreadsheetApp.openById(props.SPREADSHEET_ID);
    [REG_SHEET, ONB_SHEET, CHAT_SHEET, SHIFT_SHEET].forEach(function (name) {
      var sh = ss.getSheetByName(name);
      if (!sh) return ng('シート「' + name + '」がありません。setup を実行してください');
      var header = headerMap_(sh);
      var missing = COLUMNS[name].map(function (c) { return c[1]; }).filter(function (l) { return header[l] === undefined; });
      if (missing.length) ng('シート「' + name + '」に列が足りません（' + missing.join('、') + '）。setup を実行してください');
      else ok('シート「' + name + '」の列はそろっています');
    });
  } catch (err) {
    ng('スプレッドシートを開けません（SPREADSHEET_ID を確認してください）：' + err.message);
  }
  var hasTrigger = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'onStatusEdit'; });
  if (hasTrigger) ok('ステータス変更時の自動送信トリガーがあります');
  else ng('ステータス変更時の自動送信トリガーがありません。setup を実行してください');
  var hasScheduler = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'runScheduler'; });
  if (hasScheduler) ok('リマインド・通話ボタン・不採用通知・シフト提出の案内の自動送信トリガー（1分ごと）があります');
  else ng('リマインド・通話ボタン・不採用通知・シフト提出の案内の自動送信トリガーがありません。setup を実行してください');
  var callUrl = (props.CALL_URL || '').trim();
  if (!callUrl) {
    warn('CALL_URL は未設定です（このままでも動きます）。面接の時刻には「トーク画面上の📞ボタンから発信してください」という案内を送ります。' +
      'LINEコールの通話用URLを入れると、案内が「📞 通話する」ボタンになります');
  } else if (!/^https:\/\/\S+$/.test(callUrl)) {
    ng('CALL_URL の形式が違います（https:// で始まるURLを、前後の空白なしで入れてください）。わからない場合は CALL_URL を削除しても動きます。現在：' + callUrl);
  } else {
    ok('CALL_URL（LINEコールの通話用URL）は設定済み：' + callUrl);
  }

  // 5. デプロイ済みのウェブアプリが最新のコードか
  // ScriptApp.getService().getUrl() は環境によって取得できないため、スクリプト プロパティ WEBAPP_URL を優先する
  var appUrl = (props.WEBAPP_URL || '').trim() || (ScriptApp.getService().getUrl() || '').replace(/\/dev$/, '/exec');
  if (!appUrl) {
    warn('ウェブアプリの版を自動で確認するには、スクリプト プロパティ WEBAPP_URL にウェブアプリのURL（/exec で終わるもの）を入れてください');
  } else {
    var deployed = null;
    var reason = '';
    try {
      var res = UrlFetchApp.fetch(appUrl, { muteHttpExceptions: true, followRedirects: true });
      if (res.getResponseCode() !== 200) reason = 'HTTP ' + res.getResponseCode();
      else deployed = JSON.parse(res.getContentText()).version || 'なし（古い版）';
    } catch (err) {
      reason = err.message;
    }
    if (deployed === APP_VERSION) {
      ok('ウェブアプリは最新の版でデプロイされています（' + APP_VERSION + '）');
    } else if (deployed) {
      ng('ウェブアプリが古い版のままです（デプロイ済み：' + deployed + '／最新：' + APP_VERSION + '）。' +
        '「デプロイ > デプロイを管理 > 鉛筆アイコン > バージョン：新バージョン > デプロイ」を行ってください');
    } else {
      warn('ウェブアプリの版を確認できませんでした（' + reason + '）。確認したURL：' + appUrl +
        '。WEBAPP_URL に正しいウェブアプリのURLを入れるか、そのURLをブラウザで開いて "version" を確認してください');
    }
  }

  // 6. 不採用通知の送信予定
  try {
    var pending = pendingNotices_(new Date());
    if (pending.length) {
      lines.push('');
      lines.push('【不採用通知の送信予定】');
      pending.forEach(function (l) { lines.push('・' + l); });
    }
  } catch (err) {
    warn('不採用通知の送信予定を確認できませんでした：' + err.message);
  }

  lines.push('');
  lines.push('※ ここで問題がないのに友だち追加で返信が来ない場合は、次を確認してください。');
  lines.push('・LINE Official Account Manager > 設定 > 応答設定 で「Webhook」がオンになっているか');
  lines.push('・コードを貼り付けたあとに「デプロイを管理 > 編集 > 新バージョン」でデプロイし直したか');
  lines.push('・Apps Script 左の「実行数」に doPost の記録とエラーがあるか');
  console.log(lines.join('\n'));
}
