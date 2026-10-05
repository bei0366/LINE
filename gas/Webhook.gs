/**
 * LINE 公式アカウントの Webhook。
 * - 友だち追加 → トークでスタッフ登録の質問を開始（Chat.gs）
 * - 質問に回答中の人のメッセージ → 回答として処理
 * - それ以外はキーワードにだけ反応する。キーワード以外には返信しないので、
 *   LINE Official Account Manager のチャット機能で担当者が手動で返信できる。
 * ボットの返信はすべて「応答メッセージ」なので、月の無料メッセージ数を消費しない。
 */

function handleWebhook_(body) {
  (body.events || []).forEach(function (ev) {
    try {
      handleEvent_(ev);
    } catch (err) {
      console.error('webhook event failed', err && err.stack || err);
    }
  });
}

function handleEvent_(ev) {
  if (!ev.source || ev.source.type !== 'user' || !ev.source.userId) return;
  var userId = ev.source.userId;

  switch (ev.type) {
    case 'follow':
      return onFollow_(ev, userId);
    case 'unfollow':
      return onUnfollow_(userId);
    case 'postback':
      return onPostback_(ev, userId);
    case 'message':
      if (ev.message.type === 'text') return onText_(ev, userId, ev.message.text.trim());
      return onOtherMessage_(ev, userId);
  }
}

function onFollow_(ev, userId) {
  var rec = readRecord_(REG_SHEET, userId);
  if (rec) {
    if (rec.blocked) writeRecord_(REG_SHEET, userId, { blocked: '', updatedAt: now_() });
    replyMessage_(ev.replyToken, [textMessage_('おかえりなさい！\n' + statusText_(rec))]);
    return;
  }
  var chat = loadChat_(userId);
  if (chat) {
    replyMessage_(ev.replyToken, [textMessage_('おかえりなさい！スタッフ登録の続きから再開します。')].concat(chatPrompt_(chat)));
    return;
  }
  startChat_(ev.replyToken, userId, '友だち追加ありがとうございます！\nイベント運営スタッフのセブンハーツです。\n\n');
}

function onUnfollow_(userId) {
  if (readRecord_(REG_SHEET, userId)) {
    writeRecord_(REG_SHEET, userId, { blocked: 'ブロック中', updatedAt: now_() });
  }
}

function onText_(ev, userId, text) {
  var chat = loadChat_(userId);
  if (chat) return continueChat_(ev, userId, chat, { text: text });

  var rec = readRecord_(REG_SHEET, userId);

  if (/登録状況|ステータス/.test(text)) {
    if (rec) replyMessage_(ev.replyToken, [textMessage_(statusText_(rec))]);
    else startChat_(ev.replyToken, userId, 'まだスタッフ登録がお済みでないようです。\n\n');
    return;
  }
  if (/書類/.test(text)) {
    if (rec && ONBOARDING_ALLOWED.indexOf(rec.status) >= 0) {
      replyMessage_(ev.replyToken, [onboardingButton_()]);
    } else {
      replyMessage_(ev.replyToken, [textMessage_('書類のご提出は、採用のご連絡後にご案内します。')]);
    }
    return;
  }
  if (/登録|応募|変更/.test(text)) {
    if (rec) replyMessage_(ev.replyToken, [registerButton_('登録内容の確認・変更はこちらから行えます')]);
    else startChat_(ev.replyToken, userId, '');
  }
}

/** 日時選択ボタン（生年月日・面接日時）の結果 */
function onPostback_(ev, userId) {
  var m = /^chat=(\w+)$/.exec(ev.postback.data || '');
  if (!m) return;
  var chat = loadChat_(userId);
  if (!chat) return;
  var p = ev.postback.params || {};
  continueChat_(ev, userId, chat, { postbackStep: m[1], date: p.date, datetime: p.datetime });
}

/** スタンプや画像など */
function onOtherMessage_(ev, userId) {
  var chat = loadChat_(userId);
  if (!chat) return;
  replyMessage_(ev.replyToken, [textMessage_('文字かボタンで回答してください。')].concat(chatPrompt_(chat)));
}

function startChat_(replyToken, userId, greeting) {
  var state = chatNewState_(new Date());
  saveChat_(userId, state);
  replyMessage_(replyToken, [textMessage_(greeting +
    'スタッフ登録のため、いくつか質問させてください（約3分）。\n' +
    '途中でやめるときは「' + CHAT_CANCEL + '」、やり直すときは「' + CHAT_RESTART + '」と送ってください。')]
    .concat(chatPrompt_(state)));
}

function continueChat_(ev, userId, state, input) {
  var res = chatAnswer_(state, input, new Date());
  if (res.cancelled) {
    deleteRecord_(CHAT_SHEET, userId);
    replyMessage_(ev.replyToken, res.messages);
    return;
  }
  if (res.complete) {
    completeChat_(ev, userId, res.state);
    return;
  }
  saveChat_(userId, res.state);
  replyMessage_(ev.replyToken, res.messages);
}

function completeChat_(ev, userId, state) {
  var result;
  try {
    result = saveRegistration_(userId, chatToRegistration_(state.data), 'チャット');
  } catch (err) {
    if (!(err instanceof ValidationError)) throw err;
    // 確認中に面接日時が過ぎた場合など
    var key = Object.keys(err.errors)[0];
    state.step = 'edit';
    saveChat_(userId, state);
    replyMessage_(ev.replyToken, [textMessage_('確認が必要な項目があります：' + err.errors[key])].concat(chatPrompt_(state)));
    return;
  }
  replyMessage_(ev.replyToken, [textMessage_(result.name + ' さん\n\nスタッフ登録ありがとうございます！\n' +
    '面接日時を調整のうえ、担当者からこのトークでご連絡します。\n\n' +
    '登録内容の変更は「変更」、登録状況の確認は「登録状況」と送ってください。')]);
}

function statusText_(rec) {
  var name = rec.lastName + ' ' + rec.firstName + ' さんの登録状況：' + rec.status + '\n\n';
  switch (rec.status) {
    case STATUS.PRE:
      return name + '面接日時を調整中です。担当者からご連絡しますので、しばらくお待ちください。';
    case STATUS.HIRED:
    case STATUS.DOC_REQUESTED:
      return name + '書類のご提出をお待ちしています。「書類」と送信すると提出フォームを開けます。';
    case STATUS.DOC_SUBMITTED:
      return name + '提出書類を確認中です。確認が終わり次第ご連絡します。';
    case STATUS.ACTIVE:
      return name + 'お仕事のご案内をお待ちください。登録内容の変更は「変更」と送信してください。';
    default:
      return name + 'ご不明な点はこのトークでお問い合わせください。';
  }
}
