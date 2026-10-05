/**
 * 友だち追加後の最初のやりとり。
 * トークでお名前の姓と名を1問ずつ聞き、続きの項目は登録フォーム（LIFF）で入力してもらう。
 * フォームを開くと、ここで聞いたお名前が入力済みになる（Api.gs の apiMe_）。
 *
 * やりとりの状態はシート「登録途中」に保存する。フォームから登録すると削除されるので、
 * このシートに残っている人は「お名前だけ答えてフォームを送信していない人」になる。
 *
 * chatPrompt_ / chatAnswer_ はシートに触れないので、tests/chat.test.js で動作を確認できる。
 */

var CHAT_CANCEL = 'やめる';

/** 質問の順番。最後の 'form' はフォームの入力待ち */
var CHAT_STEPS = {
  lastName: { label: '姓', next: 'firstName', question: 'はじめに、お名前の「姓」（苗字）を漢字で送ってください。\n例：山田' },
  firstName: { label: '名', next: 'form', question: '続いて、お名前の「名」（下の名前）を漢字で送ってください。\n例：花子' },
  form: { label: 'フォーム入力待ち' }
};

function formButton_(d) {
  return buttonMessage_(
    d.lastName + ' ' + d.firstName + ' さん、ありがとうございます！\n' +
    '続き（連絡先・住所・面接の希望日時など）は、こちらのフォームからご入力ください（約2分）。',
    '続きを入力する',
    registerUrl_()
  );
}

/** トークでお名前を聞いている途中か（false ならフォームの入力待ち） */
function chatAsking_(state) {
  return state.step !== 'form';
}

function chatNewState_(today) {
  return { step: 'lastName', data: {}, startedAt: today ? today.getTime() : Date.now() };
}

function chatPrompt_(state) {
  if (chatAsking_(state)) return [textMessage_(CHAT_STEPS[state.step].question)];
  return [formButton_(state.data)];
}

/**
 * 回答を1つ処理する。
 * @return {{state, messages, cancelled}}
 */
function chatAnswer_(state, input) {
  var text = String(input.text || '').trim();

  if (text === CHAT_CANCEL) {
    return { cancelled: true, messages: [textMessage_('登録を中断しました。\nもう一度始めるときは「登録」と送ってください。')] };
  }
  if (!chatAsking_(state)) {
    // お名前は回答済み：フォームのボタンを送り直す
    return { state: state, messages: chatPrompt_(state) };
  }

  // 姓の質問に「山田 花子」とフルネームが送られた場合は、姓と名に分けて受け取る
  var parts = text.split(/[\s　]+/);
  var answers = {};
  if (state.step === 'lastName' && parts.length === 2) {
    answers.lastName = parts[0];
    answers.firstName = parts[1];
  } else {
    answers[state.step] = parts.join('');
  }

  var v = new Validator_(answers);
  var keys = Object.keys(answers);
  for (var i = 0; i < keys.length; i++) {
    var value = v.text(keys[i], { max: 20 });
    if (v.errors[keys[i]]) {
      return { state: state, messages: [textMessage_(CHAT_STEPS[keys[i]].label + 'を' + v.errors[keys[i]])].concat(chatPrompt_(state)) };
    }
    state.data[keys[i]] = value;
    state.step = CHAT_STEPS[keys[i]].next;
  }
  return { state: state, messages: chatPrompt_(state) };
}

// ---- シートへの保存 ----

function loadChat_(userId) {
  var rec = readRecord_(CHAT_SHEET, userId);
  if (!rec || !rec.state) return null;
  try {
    var state = JSON.parse(rec.state);
    // 以前の形式のデータなどは使わない（最初からやり直してもらう）
    return CHAT_STEPS[state.step] ? state : null;
  } catch (err) {
    return null;
  }
}

function saveChat_(userId, state) {
  writeRecord_(CHAT_SHEET, userId, {
    question: CHAT_STEPS[state.step].label,
    state: JSON.stringify(state),
    startedAt: Utilities.formatDate(new Date(state.startedAt), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm:ss'),
    updatedAt: now_()
  });
}
