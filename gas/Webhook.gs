/**
 * LINE 公式アカウントの Webhook。
 * キーワードに当てはまらないメッセージには返信しないので、LINE Official Account Manager の
 * チャット機能で担当者が手動で返信できます。
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
    case 'message':
      if (ev.message.type === 'text') return onText_(ev, userId, ev.message.text.trim());
  }
}

function onFollow_(ev, userId) {
  var rec = readRecord_(REG_SHEET, userId);
  if (!rec) {
    replyMessage_(ev.replyToken, [
      textMessage_('友だち追加ありがとうございます！\nイベント運営スタッフのセブンハーツです。\n\n' +
        'スタッフとして働いていただくために、まずは登録フォームへのご入力をお願いします。'),
      registerButton_()
    ]);
    return;
  }
  if (rec.blocked) writeRecord_(REG_SHEET, userId, { blocked: '', updatedAt: now_() });
  replyMessage_(ev.replyToken, [textMessage_('おかえりなさい！\n' + statusText_(rec))]);
}

function onUnfollow_(userId) {
  if (readRecord_(REG_SHEET, userId)) {
    writeRecord_(REG_SHEET, userId, { blocked: 'ブロック中', updatedAt: now_() });
  }
}

function onText_(ev, userId, text) {
  var rec = readRecord_(REG_SHEET, userId);

  if (/登録状況|ステータス/.test(text)) {
    replyMessage_(ev.replyToken, [rec ? textMessage_(statusText_(rec)) : registerButton_('まだ登録されていません。こちらから登録できます（約3分）')]);
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
    replyMessage_(ev.replyToken, [registerButton_(rec
      ? '登録内容の確認・変更はこちらから行えます'
      : 'こちらからスタッフ登録ができます（約3分）')]);
  }
}

function statusText_(rec) {
  var name = rec.lastName + ' ' + rec.firstName + ' さんの登録状況：' + rec.status + '\n\n';
  switch (rec.status) {
    case STATUS.PRE:
      return name + '登録内容を確認中です。担当者から面談などのご連絡をしますので、しばらくお待ちください。';
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
