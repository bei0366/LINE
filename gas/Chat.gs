/**
 * 友だち追加後の最初のやりとり。
 * トークでお名前（姓・名）だけを聞き、続きの項目は登録フォーム（LIFF）で入力してもらう。
 * フォームを開くと、ここで聞いたお名前が入力済みになる（Api.gs の apiMe_）。
 *
 * やりとりの状態はシート「登録途中」に保存する。フォームから登録すると削除されるので、
 * このシートに残っている人は「お名前だけ答えてフォームを送信していない人」になる。
 *
 * chatPrompt_ / chatAnswer_ はシートに触れないので、tests/chat.test.js で動作を確認できる。
 */

var CHAT_CANCEL = 'やめる';

/** シート「登録途中」の「回答中の質問」列に表示する名前 */
var CHAT_LABELS = { name: 'お名前', form: 'フォーム入力待ち' };

/** 「山田 花子」→ ['山田', '花子']。スペースがなければ null */
function splitName_(text) {
  var parts = String(text || '').trim().split(/[\s　]+/);
  return parts.length === 2 && parts[0] && parts[1] ? parts : null;
}

function formButton_(d) {
  return buttonMessage_(
    d.lastName + ' ' + d.firstName + ' さん、ありがとうございます！\n' +
    '続き（連絡先・住所・面接の希望日時など）は、こちらのフォームからご入力ください（約2分）。',
    '続きを入力する',
    registerUrl_()
  );
}

function chatNewState_(today) {
  return { step: 'name', data: {}, startedAt: today ? today.getTime() : Date.now() };
}

function chatPrompt_(state) {
  if (state.step === 'name') {
    return [textMessage_('はじめに、お名前（漢字）を、姓と名の間にスペースを入れて送ってください。\n例：山田 花子')];
  }
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
  if (state.step !== 'name') {
    // お名前は回答済み：フォームのボタンを送り直す
    return { state: state, messages: chatPrompt_(state) };
  }

  var parts = splitName_(text);
  var error = parts ? '' : '姓と名の間にスペースを入れて送ってください。\n例：山田 花子';
  if (parts) {
    var v = new Validator_({ lastName: parts[0], firstName: parts[1] });
    var lastName = v.text('lastName', { max: 20 });
    var firstName = v.text('firstName', { max: 20 });
    var keys = Object.keys(v.errors);
    if (keys.length) error = 'お名前は' + v.errors[keys[0]];
  }
  if (error) return { state: state, messages: [textMessage_(error)].concat(chatPrompt_(state)) };

  state.data.lastName = lastName;
  state.data.firstName = firstName;
  state.step = 'form';
  return { state: state, messages: chatPrompt_(state) };
}

// ---- シートへの保存 ----

function loadChat_(userId) {
  var rec = readRecord_(CHAT_SHEET, userId);
  if (!rec || !rec.state) return null;
  try {
    return JSON.parse(rec.state);
  } catch (err) {
    return null;
  }
}

function saveChat_(userId, state) {
  writeRecord_(CHAT_SHEET, userId, {
    question: CHAT_LABELS[state.step],
    state: JSON.stringify(state),
    startedAt: Utilities.formatDate(new Date(state.startedAt), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm:ss'),
    updatedAt: now_()
  });
}
