/**
 * 書類選考〜面接（LINEコール）の自動化。
 *
 * - 「書類通過」→ 応募者の希望日時から面接候補をボタンで送る（onStatusEdit から）
 * - 応募者がボタンで日時を選ぶ → 「面接確定」＋ LINEコールの使い方を返信（Webhook の postback）
 * - 面接当日の朝9時にリマインド、面接の時刻に「通話する」ボタンを送る（runScheduler：1分ごと）
 * - 「書類落選」→ すぐに不採用通知を送る（onStatusEdit から。送れなかった場合は runScheduler が送り直す）
 * - 「不採用」（面接後）→ 翌日の午前10時に不採用通知を送る（runScheduler）
 *
 * scheduledActions_ と文面をつくる関数はシートや LINE に触れないので、tests/interview.test.js で確認できる。
 */

var REMINDER_HOUR = 9;          // 面接当日のリマインド
var REJECT_NOTICE_HOUR = 10;    // 面接後の不採用通知（翌日のこの時刻）
var CALL_WINDOW_MINUTES = 60;   // 面接時刻を過ぎてもこの時間内なら通話ボタンを送る（停止などで遅れた場合）
var BRAND_BROWN = '#381E19';

var OFFER_NONE = 'none';

// ---- 文面 ----

function fullName_(rec) {
  return rec.lastName + ' ' + rec.firstName;
}

/** 「2026/10/12(月) 14:00」→「10/12(月) 14:00」 */
function shortDateTime_(s) {
  return String(s).replace(/^\d{4}\//, '');
}

function docRejectText_(rec) {
  return fullName_(rec) + ' 様\n\n' +
    'このたびは、セブンハーツのスタッフにご応募いただき、ありがとうございました。\n\n' +
    '書類選考の結果、誠に残念ながら、今回は不採用となりました。\n\n' +
    'ご応募いただきましたことに、心より感謝申し上げます。\n\n' +
    'セブンハーツ 採用担当';
}

function interviewRejectText_(rec) {
  return fullName_(rec) + ' 様\n\n' +
    'このたびは、セブンハーツのイベントスタッフにご応募いただき、誠にありがとうございました。\n\n' +
    '慎重に選考を重ねました結果、誠に残念ながら、今回はご期待に沿えない結果となりました。\n\n' +
    '多数のご応募をいただいた中で、限られた募集枠での選考となりましたこと、何卒ご理解いただけますと幸いです。\n\n' +
    'ご応募いただいた個人情報は、当社の規定に従い適切に管理・処分いたします。\n\n' +
    fullName_(rec) + '様の今後一層のご活躍を、心よりお祈り申し上げます。\n\n' +
    'セブンハーツ 採用担当';
}

function callGuideText_() {
  return '面接は、LINEの無料通話「LINEコール」で行います。\n\n' +
    '【当日の流れ】\n' +
    '① 面接の時間になると、このトークに「📞 通話する」ボタンが届きます\n' +
    '② ボタンをタップし、「発信」を押してください\n' +
    '③ 担当者が応答し、面接が始まります（10〜15分程度）\n\n' +
    '【事前にご準備ください】\n' +
    '・静かで、電波（Wi-Fi）の安定した場所\n' +
    '・スマホの充電\n' +
    '・イヤホンがあると聞き取りやすくなります\n\n' +
    '※ 通話料はかかりません（データ通信を使います）\n' +
    '※ 時間を過ぎてもボタンが届かない場合や、つながらない場合は、このトークでお知らせください';
}

function fixedText_(rec, at) {
  return fullName_(rec) + ' 様\n\n面接の日時が決まりました。\n\n' +
    '📅 ' + at + '\n' +
    '📞 LINEコール（音声通話・10〜15分程度）\n\n' +
    '当日の朝' + REMINDER_HOUR + '時にリマインドをお送りします。\n' +
    'ご都合が悪くなった場合は、このトークでお知らせください。';
}

function reminderText_(rec) {
  return fullName_(rec) + ' 様\n\n本日は面接の日です。よろしくお願いいたします。\n\n' +
    '📅 ' + rec.interviewAt + '\n' +
    '📞 LINEコール（音声通話）\n\n' +
    'お時間になりましたら、このトークに「通話する」ボタンをお送りします。' +
    '静かで電波の良い場所でお待ちください。\n\n' +
    'ご都合が悪くなった場合は、このトークでお知らせください。';
}

/** 面接の時刻に送るメッセージ。通話用URLがなければトーク画面の通話ボタンを案内する */
function callMessages_(rec, callUrl) {
  if (callUrl) {
    return [buttonMessage_(
      fullName_(rec) + ' 様\n面接のお時間になりました。\n下の「通話する」ボタンを押して、発信してください。',
      '📞 通話する',
      callUrl
    )];
  }
  return [textMessage_(fullName_(rec) + ' 様\n\n面接のお時間になりました。\n' +
    'このトーク画面の上にある📞（通話）ボタンを押し、「音声通話」で発信してください。')];
}

/** 面接候補のメッセージ（日時ボタン＋「どれも都合が合わない」） */
function offerMessage_(rec, slots) {
  var buttons = slots.map(function (s) {
    return {
      type: 'button', style: 'primary', color: BRAND_BROWN, height: 'sm',
      action: { type: 'postback', label: shortDateTime_(s), data: 'iv=pick&t=' + encodeURIComponent(s), displayText: shortDateTime_(s) + ' を希望します' }
    };
  });
  buttons.push({
    type: 'button', style: 'secondary', height: 'sm',
    action: { type: 'postback', label: 'どれも都合が合わない', data: 'iv=' + OFFER_NONE, displayText: 'どれも都合が合いません' }
  });
  return {
    type: 'flex',
    altText: '書類選考通過のお知らせ（面接日時のご案内）',
    contents: {
      type: 'bubble',
      body: {
        type: 'box', layout: 'vertical', spacing: 'md',
        contents: [
          { type: 'text', text: '書類選考通過のお知らせ', weight: 'bold', size: 'md', color: BRAND_BROWN },
          {
            type: 'text', wrap: true, size: 'sm',
            text: fullName_(rec) + ' 様\n\nこのたびはセブンハーツにご応募いただき、ありがとうございます。\n' +
              '書類選考の結果、ぜひ面接をさせていただきたく、ご連絡いたしました。\n\n' +
              '面接はLINEの無料通話（10〜15分程度）で行います。ご都合のよい日時を下からお選びください。'
          }
        ]
      },
      footer: { type: 'box', layout: 'vertical', spacing: 'sm', contents: buttons }
    }
  };
}

// ---- 判定 ----

function isChecked_(v) {
  return v === true || String(v).toUpperCase() === 'TRUE';
}

/**
 * 候補として送る日時。「候補に送る」にチェックがあればその希望だけ、なければすべての希望。
 * 過ぎた日時は除く。
 */
function offerSlots_(rec, now) {
  var anyChecked = INTERVIEW_KEYS.some(function (k, i) { return isChecked_(rec['offer' + (i + 1)]); });
  return INTERVIEW_KEYS.filter(function (k, i) {
    if (!rec[k]) return false;
    if (anyChecked && !isChecked_(rec['offer' + (i + 1)])) return false;
    var d = parseDateTime_(rec[k], now);
    return d && d > now;
  }).map(function (k) { return rec[k]; });
}

/** 「yyyy/MM/dd HH:mm:ss」（now_ の形式）を Date に */
function parseTimestamp_(s) {
  // セルの書式が日付に変わっていると Date で届くため、そのまま使う
  if (Object.prototype.toString.call(s) === '[object Date]') return isNaN(s.getTime()) ? null : s;
  var m = /^(\d{4})\/(\d{1,2})\/(\d{1,2}) (\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(s || '').trim());
  return m ? new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)) : null;
}

/**
 * 不採用通知を送る時刻。
 * 書類落選：ステータスを変えたらすぐ／不採用（面接後）：変えた日の翌日の午前10時
 */
function rejectDueAt_(changedAt, status) {
  if (status === STATUS.DOC_FAILED) return changedAt;
  return new Date(changedAt.getFullYear(), changedAt.getMonth(), changedAt.getDate() + 1, REJECT_NOTICE_HOUR, 0);
}

/**
 * 1人分の、今送るべきメッセージの種類。
 * @return {string[]} 'docReject' / 'interviewReject' / 'reminder' / 'call'
 */
function scheduledActions_(rec, now) {
  var actions = [];
  if ((rec.status === STATUS.DOC_FAILED || rec.status === STATUS.REJECTED) && !rec.rejectNotifiedAt) {
    var changed = parseTimestamp_(rec.statusChangedAt);
    if (changed && now >= rejectDueAt_(changed, rec.status)) {
      actions.push(rec.status === STATUS.DOC_FAILED ? 'docReject' : 'interviewReject');
    }
  }
  if (rec.status === STATUS.INTERVIEW_FIXED) {
    var at = parseDateTime_(rec.interviewAt, now);
    if (at) {
      if (!rec.reminderSentAt && now < at && now.getHours() >= REMINDER_HOUR &&
          startOfDay_(now).getTime() === startOfDay_(at).getTime()) {
        actions.push('reminder');
      }
      if (!rec.callSentAt && now >= at && now < new Date(at.getTime() + CALL_WINDOW_MINUTES * 60000)) {
        actions.push('call');
      }
    }
  }
  return actions;
}

// ---- シート・LINE とのやりとり ----

/** 「書類通過」にしたとき：候補日を送って「面接日程調整中」にする */
function sendInterviewOffer_(rec) {
  var slots = offerSlots_(rec, new Date());
  if (!slots.length) {
    writeRecord_(REG_SHEET, rec.userId, {
      status: STATUS.RESCHEDULE, statusChangedAt: now_(), updatedAt: now_(),
      adminMemo: appendMemo_(rec.adminMemo, '送れる面接候補がありません（希望日時が過ぎているか、チェックした候補がありません）。日時を直して「書類通過」にし直すか、トークで調整してください。')
    });
    return;
  }
  if (!pushMessage_(rec.userId, [offerMessage_(rec, slots)])) return;
  writeRecord_(REG_SHEET, rec.userId, {
    status: STATUS.INTERVIEW_OFFERED, statusChangedAt: now_(), offerSentAt: now_(), updatedAt: now_()
  });
}

/** 管理者が「面接確定」にしたとき（トークで個別に調整した場合など）：確定の連絡と使い方を送る */
function sendInterviewFixedByAdmin_(rec) {
  var at = parseDateTime_(rec.interviewAt, new Date());
  if (!at) {
    writeRecord_(REG_SHEET, rec.userId, {
      adminMemo: appendMemo_(rec.adminMemo, '「面接日時（確定）」に日時を入れてから「面接確定」にしてください（例：2026/10/12 14:00）。'),
      updatedAt: now_()
    });
    return;
  }
  var formatted = formatDateTime_(at);
  pushMessage_(rec.userId, [textMessage_(fixedText_(rec, formatted)), textMessage_(callGuideText_())]);
  writeRecord_(REG_SHEET, rec.userId, {
    interviewAt: formatted, reminderSentAt: '', callSentAt: '', updatedAt: now_()
  });
}

function appendMemo_(memo, text) {
  var stamp = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'M/d HH:mm');
  return (memo ? memo + '\n' : '') + '[' + stamp + '] ' + text;
}

/** 応募者が候補日のボタンを押したとき（Webhook の postback） */
function onInterviewPostback_(ev, userId, params) {
  var rec = readRecord_(REG_SHEET, userId);
  if (!rec) return;
  if (rec.status !== STATUS.INTERVIEW_OFFERED) {
    var msg = rec.status === STATUS.INTERVIEW_FIXED
      ? '面接の日時は ' + rec.interviewAt + ' で決定しています。変更をご希望の場合は、このトークでお知らせください。'
      : 'こちらのご案内は受付を終了しました。ご不明な点は、このトークでお問い合わせください。';
    replyMessage_(ev.replyToken, [textMessage_(msg)]);
    return;
  }

  if (params.iv === OFFER_NONE) {
    writeRecord_(REG_SHEET, userId, { status: STATUS.RESCHEDULE, statusChangedAt: now_(), updatedAt: now_() });
    replyMessage_(ev.replyToken, [textMessage_('ご連絡ありがとうございます。\n担当者から改めて日程のご相談をさせていただきますので、少々お待ちください。')]);
    notifyAdmin_('面接日程の再調整希望', fullName_(rec));
    return;
  }

  var now = new Date();
  var chosen = params.t;
  var at = parseDateTime_(chosen, now);
  if (!at || offerSlots_(rec, now).indexOf(chosen) < 0) {
    replyMessage_(ev.replyToken, [textMessage_('申し訳ありません。この日時は選択できなくなりました。\n担当者から改めてご連絡しますので、少々お待ちください。')]);
    writeRecord_(REG_SHEET, userId, { status: STATUS.RESCHEDULE, statusChangedAt: now_(), updatedAt: now_() });
    notifyAdmin_('面接日程の再調整が必要', fullName_(rec));
    return;
  }

  writeRecord_(REG_SHEET, userId, {
    status: STATUS.INTERVIEW_FIXED, interviewAt: chosen, statusChangedAt: now_(),
    reminderSentAt: '', callSentAt: '', updatedAt: now_()
  });
  replyMessage_(ev.replyToken, [textMessage_(fixedText_(rec, chosen)), textMessage_(callGuideText_())]);
  notifyAdmin_('面接日時の確定（' + chosen + '）', fullName_(rec));
}

/**
 * 不採用通知の送信予定（checkSettings とメニューの「送信予定を確認」で表示）。
 * @return {string[]} 1人1行の説明
 */
function pendingNotices_(now) {
  var sh = sheet_(REG_SHEET);
  if (sh.getLastRow() < 2) return [];
  var header = headerMap_(sh);
  var rows = sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).getValues();
  var lines = [];
  rows.forEach(function (values) {
    var rec = rowToRecord_(REG_SHEET, header, values);
    if (!rec.userId || rec.rejectNotifiedAt) return;
    if (rec.status !== STATUS.DOC_FAILED && rec.status !== STATUS.REJECTED) return;
    var changed = parseTimestamp_(rec.statusChangedAt);
    var label = fullName_(rec) + '（' + rec.status + '）：';
    if (!changed) {
      lines.push(label + '「ステータス変更日時」が読み取れないため送れません。ステータスを選び直してください（現在の値：' + (rec.statusChangedAt || '空') + '）');
    } else {
      var due = rejectDueAt_(changed, rec.status);
      lines.push(label + (now >= due ? 'まもなく送信されます（1分以内）' :
        Utilities.formatDate(due, 'Asia/Tokyo', 'M/d HH:mm') + ' に送信予定'));
    }
  });
  return lines;
}

/** スプレッドシートを開いたときに「セブンハーツ」メニューを出す（シンプルトリガー） */
function onOpen() {
  SpreadsheetApp.getUi().createMenu('セブンハーツ')
    .addItem('案件を取り込む（依頼文から）', 'showJobImport')
    .addItem('案件をLINEで配信', 'showJobSend')
    .addSeparator()
    .addItem('不採用通知の送信予定を確認', 'showPendingNotices')
    .addItem('不採用通知を今すぐ送る', 'sendRejectionsNow')
    .addToUi();
}

function showPendingNotices() {
  var lines = pendingNotices_(new Date());
  SpreadsheetApp.getUi().alert('不採用通知の送信予定',
    lines.length ? lines.join('\n') : '送信待ちの不採用通知はありません。', SpreadsheetApp.getUi().ButtonSet.OK);
}

/** 「書類落選」「不採用」で未送信の人に、午前10時を待たずに今すぐ通知を送る */
function sendRejectionsNow() {
  var ui = SpreadsheetApp.getUi();
  var sh = sheet_(REG_SHEET);
  if (sh.getLastRow() < 2) return ui.alert('送信待ちの不採用通知はありません。');
  var header = headerMap_(sh);
  var rows = sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).getValues();
  var targets = rows.map(function (v) { return rowToRecord_(REG_SHEET, header, v); }).filter(function (rec) {
    return rec.userId && !rec.rejectNotifiedAt && (rec.status === STATUS.DOC_FAILED || rec.status === STATUS.REJECTED);
  });
  if (!targets.length) return ui.alert('送信待ちの不採用通知はありません。');
  var answer = ui.alert('不採用通知を今すぐ送る',
    targets.map(fullName_).join('、') + '\n\nの ' + targets.length + ' 人に、今すぐ不採用通知を送ります。よろしいですか？',
    ui.ButtonSet.OK_CANCEL);
  if (answer !== ui.Button.OK) return;
  targets.forEach(function (rec) {
    runAction_(rec, rec.status === STATUS.DOC_FAILED ? 'docReject' : 'interviewReject', '');
  });
  ui.alert('送信しました。「不採用通知の送信日時」列で確認できます。');
}

/**
 * 時間主導トリガー（setup で1分ごとに登録）。
 * リマインド・通話ボタン・不採用通知のうち、送る時刻になったものを送る。
 */
function runScheduler() {
  var sh = sheet_(REG_SHEET);
  if (sh.getLastRow() < 2) return;
  var header = headerMap_(sh);
  var rows = sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).getValues();
  var now = new Date();
  var callUrl = getConfig_().callUrl;

  rows.forEach(function (values) {
    var rec = rowToRecord_(REG_SHEET, header, values);
    if (!rec.userId) return;
    scheduledActions_(rec, now).forEach(function (action) {
      try {
        runAction_(rec, action, callUrl);
      } catch (err) {
        console.error('scheduler failed', action, rec.userId, err && err.stack || err);
        logError_('自動送信：' + action, rec.userId, err);
      }
    });
  });
}

function runAction_(rec, action, callUrl) {
  switch (action) {
    case 'docReject':
      if (pushMessage_(rec.userId, [textMessage_(docRejectText_(rec))])) {
        writeRecord_(REG_SHEET, rec.userId, { rejectNotifiedAt: now_() });
      }
      return;
    case 'interviewReject':
      if (pushMessage_(rec.userId, [textMessage_(interviewRejectText_(rec))])) {
        writeRecord_(REG_SHEET, rec.userId, { rejectNotifiedAt: now_() });
      }
      return;
    case 'reminder':
      if (pushMessage_(rec.userId, [textMessage_(reminderText_(rec))])) {
        writeRecord_(REG_SHEET, rec.userId, { reminderSentAt: now_() });
      }
      return;
    case 'call':
      if (pushMessage_(rec.userId, callMessages_(rec, callUrl))) {
        writeRecord_(REG_SHEET, rec.userId, { callSentAt: now_() });
      }
      return;
  }
}
