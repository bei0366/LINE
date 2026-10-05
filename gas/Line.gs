/**
 * LINE Messaging API / LINEログインの呼び出し。
 */

var LINE_BOT_API = 'https://api.line.me/v2/bot';

function lineRequest_(method, path, payload) {
  var options = {
    method: method,
    headers: { Authorization: 'Bearer ' + getConfig_().channelAccessToken },
    muteHttpExceptions: true
  };
  if (payload) {
    options.contentType = 'application/json';
    options.payload = JSON.stringify(payload);
  }
  var res = UrlFetchApp.fetch(LINE_BOT_API + path, options);
  if (res.getResponseCode() >= 300) {
    console.error('LINE API error', path, res.getResponseCode(), res.getContentText());
    return null;
  }
  return res.getContentText() ? JSON.parse(res.getContentText()) : {};
}

function replyMessage_(replyToken, messages) {
  return lineRequest_('post', '/message/reply', { replyToken: replyToken, messages: messages });
}

/** プッシュメッセージは月の無料通数にカウントされます */
function pushMessage_(userId, messages) {
  return lineRequest_('post', '/message/push', { to: userId, messages: messages });
}

function getLineProfile_(userId) {
  return lineRequest_('get', '/profile/' + encodeURIComponent(userId));
}

function UserError(message) {
  this.name = 'UserError';
  this.message = message;
}
UserError.prototype = Object.create(Error.prototype);

/**
 * LIFF から受け取った IDトークンを LINE で検証し、ユーザーIDを返す。
 * フォームから送られてくる userId は信用せず、必ずこの結果を使う。
 */
function verifyIdToken_(idToken) {
  if (!idToken) throw new UserError('LINEのログイン情報を取得できませんでした。LINEアプリから開き直してください。');
  var res = UrlFetchApp.fetch('https://api.line.me/oauth2/v2.1/verify', {
    method: 'post',
    payload: { id_token: idToken, client_id: getConfig_().loginChannelId },
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) {
    throw new UserError('ログインの有効期限が切れました。画面を閉じて、もう一度開き直してください。');
  }
  return JSON.parse(res.getContentText()).sub;
}

function registerUrl_() {
  return 'https://liff.line.me/' + getConfig_().liffId;
}

function onboardingUrl_() {
  return registerUrl_() + '/onboarding.html';
}

function textMessage_(text) {
  return { type: 'text', text: text };
}

/** ボタン付きメッセージ（本文は160文字以内） */
function buttonMessage_(text, label, uri) {
  return {
    type: 'template',
    altText: text,
    template: { type: 'buttons', text: text, actions: [{ type: 'uri', label: label, uri: uri }] }
  };
}

function registerButton_(text) {
  return buttonMessage_(text || 'こちらからスタッフ登録ができます（約3分）', 'スタッフ登録をする', registerUrl_());
}

function onboardingButton_() {
  return buttonMessage_(
    '書類提出フォームから、本人確認書類・給与振込口座・緊急連絡先をご提出ください。',
    '書類を提出する',
    onboardingUrl_()
  );
}
