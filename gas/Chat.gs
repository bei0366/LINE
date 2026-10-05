/**
 * LINE のトークで1問ずつ質問するスタッフ登録。
 * 回答途中の内容はシート「登録途中」に保存し、最後の確認で「スタッフ登録」シートへ登録する。
 *
 * chatPrompt_ / chatAnswer_ はシートや LINE に触れない（郵便番号検索の lookupZip_ を除く）ので、
 * tests/chat.test.js で流れを確認できる。
 */

var CHAT_CANCEL = 'やめる';
var CHAT_RESTART = '最初から';
var CHAT_DONE = '決定';
var CHAT_NO_SECOND = 'なし';
var CHAT_POSTAL_UNKNOWN = '郵便番号がわからない';
var CHAT_AGREE = '同意する';
var CHAT_DISAGREE = '同意しない';
var CHAT_SUBMIT = '登録する';
var CHAT_FIX = '修正する';
var CHAT_BACK = '戻る';
var CHECK_MARK = '✓ ';

/** 質問の順番（addressFull は「郵便番号がわからない」を選んだときだけ） */
var CHAT_ORDER = [
  'name', 'kana', 'birthDate', 'gender', 'phone', 'postal', 'address', 'station',
  'occupation', 'areas', 'interview1', 'interview2', 'consent', 'confirm'
];

/** 確認画面の「修正する」で選べる項目 → 質問 */
var CHAT_EDIT_ITEMS = [
  ['お名前', 'name'], ['フリガナ', 'kana'], ['生年月日', 'birthDate'], ['性別', 'gender'],
  ['電話番号', 'phone'], ['住所', 'postal'], ['最寄り駅', 'station'], ['職業', 'occupation'],
  ['希望エリア', 'areas'], ['面接日時', 'interview1'], [CHAT_BACK, 'confirm']
];

// ---- LINE メッセージの部品 ----

function quickText_(text, items) {
  var m = textMessage_(text);
  if (items && items.length) m.quickReply = { items: items };
  return m;
}

function messageItem_(label, text) {
  return { type: 'action', action: { type: 'message', label: label.slice(0, 20), text: text || label } };
}

function pickerItem_(label, step, mode, initial, min, max) {
  return {
    type: 'action',
    action: { type: 'datetimepicker', label: label, data: 'chat=' + step, mode: mode, initial: initial, min: min, max: max }
  };
}

/** LINE の日時選択の形式（2026-10-12t13:00） */
function pickerDateTime_(d, hhmm) { return formatDate_(d) + 't' + hhmm; }

function interviewPicker_(step, today) {
  return pickerItem_('📅 日時を選ぶ', step, 'datetime',
    pickerDateTime_(addDaysTo_(today, 1), '13:00'),
    pickerDateTime_(addDaysTo_(today, 1), '00:00'),
    pickerDateTime_(addDaysTo_(today, INTERVIEW_MAX_DAYS), '23:59'));
}

/** Validator_ で1項目だけ検証する。{error} か {value} を返す */
function chatCheck_(input, fn) {
  var v = new Validator_(input);
  var value = fn(v);
  var keys = Object.keys(v.errors);
  return keys.length ? { error: v.errors[keys[0]] } : { value: value };
}

/** 「山田 花子」→ ['山田', '花子']。スペースがなければ null */
function splitName_(text) {
  var parts = String(text || '').trim().split(/[\s　]+/);
  return parts.length === 2 && parts[0] && parts[1] ? parts : null;
}

/** 郵便番号から住所を調べる（zipcloud）。見つからなければ null */
function lookupZip_(zip) {
  var res = UrlFetchApp.fetch('https://zipcloud.ibsnet.co.jp/api/search?zipcode=' + zip, { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) return null;
  var r = JSON.parse(res.getContentText()).results;
  return r && r.length ? { prefecture: r[0].address1, city: r[0].address2 + r[0].address3 } : null;
}

function privacyText_() {
  return '【個人情報の取り扱いについて】\n' +
    'ご回答いただいた情報は、次の目的で利用します。\n' +
    '・スタッフ登録の受付、面接のご連絡\n' +
    '・お仕事のご紹介、シフトのご連絡\n' +
    '・雇用契約、給与のお支払い、社会保険・税金の手続き\n' +
    '・勤務中の事故や体調不良などの緊急時のご連絡\n\n' +
    'お仕事先（イベント主催者など）へ、入館手続きなどに必要な範囲で氏名などをお伝えすることがあります。' +
    'それ以外に、法令に基づく場合を除き、ご本人の同意なく第三者に提供することはありません。\n\n' +
    '詳しくはこちら：\n' + getConfig_().privacyPolicyUrl;
}

function chatSummary_(d) {
  return '【ご登録内容】\n' +
    'お名前：' + d.lastName + ' ' + d.firstName + '（' + d.lastNameKana + ' ' + d.firstNameKana + '）\n' +
    '生年月日：' + d.birthDate.replace(/-/g, '/') + '\n' +
    '性別：' + d.gender + '\n' +
    '電話番号：' + d.phone + '\n' +
    '住所：' + (d.postalCode ? '〒' + d.postalCode + ' ' : '') + d.prefecture + d.city + '\n' +
    '最寄り駅：' + d.nearestStation + '\n' +
    '職業：' + d.occupation + '\n' +
    '希望エリア：' + d.areas.join(LIST_SEPARATOR) + '\n' +
    '面接の第1希望：' + d.interview1 + '\n' +
    '面接の第2希望：' + (d.interview2 || 'なし');
}

// ---- 質問の定義 ----
// ask(state, today)  → この質問のメッセージ（配列）
// answer(state, input, today) → エラー文字列 / { next, stay, cancel, complete } / なし（次の質問へ）

var CHAT_STEPS = {
  name: {
    label: 'お名前',
    ask: function () {
      return [textMessage_('お名前（漢字）をフルネームで送ってください。\n例：山田 花子')];
    },
    answer: function (s, input) {
      var p = splitName_(input.text);
      if (!p) return '姓と名の間にスペースを入れて送ってください。\n例：山田 花子';
      var r = chatCheck_({ lastName: p[0], firstName: p[1] }, function (v) {
        return { lastName: v.text('lastName', { max: 20 }), firstName: v.text('firstName', { max: 20 }) };
      });
      if (r.error) return 'お名前は' + r.error;
      s.data.lastName = r.value.lastName;
      s.data.firstName = r.value.firstName;
    }
  },

  kana: {
    label: 'フリガナ',
    ask: function () {
      return [textMessage_('フリガナを送ってください（ひらがなでもOKです）。\n例：ヤマダ ハナコ')];
    },
    answer: function (s, input) {
      var p = splitName_(input.text);
      if (!p) return '姓と名の間にスペースを入れて送ってください。\n例：ヤマダ ハナコ';
      var r = chatCheck_({ lastNameKana: p[0], firstNameKana: p[1] }, function (v) {
        return { last: v.kana('lastNameKana', { max: 30 }), first: v.kana('firstNameKana', { max: 30 }) };
      });
      if (r.error) return 'フリガナは' + r.error;
      s.data.lastNameKana = r.value.last;
      s.data.firstNameKana = r.value.first;
    }
  },

  birthDate: {
    label: '生年月日',
    ask: function (s, today) {
      return [quickText_('生年月日を、下の「生年月日を選ぶ」から選んでください。\n（「2000/01/01」のように送ることもできます）',
        [pickerItem_('📅 生年月日を選ぶ', 'birthDate', 'date', '2000-01-01', '1930-01-01', formatDate_(today))])];
    },
    answer: function (s, input, today) {
      var r = chatCheck_({ birthDate: input.date || input.text }, function (v) {
        return checkBirth_(v, 'birthDate', today);
      });
      if (r.error) return r.error;
      s.data.birthDate = r.value.birthDate;
    }
  },

  gender: {
    label: '性別',
    ask: function () {
      return [quickText_('性別を選んでください。\n（更衣室やユニフォームの手配に使います）',
        OPTIONS.gender.map(function (g) { return messageItem_(g); }))];
    },
    answer: function (s, input) {
      if (OPTIONS.gender.indexOf(input.text) < 0) return '下のボタンから選んでください。';
      s.data.gender = input.text;
    }
  },

  phone: {
    label: '電話番号',
    ask: function () {
      return [textMessage_('携帯電話番号を送ってください。\n（お仕事当日の緊急連絡に使います）\n例：09012345678')];
    },
    answer: function (s, input) {
      var r = chatCheck_({ phone: input.text }, function (v) { return v.phone('phone'); });
      if (r.error) return r.error;
      s.data.phone = r.value;
    }
  },

  postal: {
    label: '郵便番号',
    ask: function () {
      return [quickText_('ご住所の郵便番号（7桁）を送ってください。\n例：5300001',
        [messageItem_(CHAT_POSTAL_UNKNOWN)])];
    },
    answer: function (s, input) {
      if (input.text === CHAT_POSTAL_UNKNOWN) return { next: 'addressFull' };
      var r = chatCheck_({ postalCode: input.text }, function (v) { return v.postal('postalCode'); });
      if (r.error) return r.error;
      var addr = lookupZip_(r.value);
      if (!addr || OPTIONS.prefectures.indexOf(addr.prefecture) < 0) {
        return '郵便番号が見つかりませんでした。もう一度確認して送ってください。';
      }
      s.data.postalCode = r.value;
      s.data.prefecture = addr.prefecture;
      s.data.cityBase = addr.city;
      return { next: 'address' };
    }
  },

  address: {
    label: '住所',
    ask: function (s) {
      return [textMessage_('「' + s.data.prefecture + s.data.cityBase + '」の続き（番地・建物名・部屋番号）を送ってください。\n例：1-2-3 セブンマンション101')];
    },
    answer: function (s, input) {
      var r = chatCheck_({ city: s.data.cityBase + String(input.text || '').trim(), rest: input.text }, function (v) {
        v.text('rest', {});
        return v.text('city', { max: 100 });
      });
      if (r.error) return r.error;
      s.data.city = r.value;
    }
  },

  addressFull: {
    label: '住所',
    after: 'station',
    ask: function () {
      return [textMessage_('ご住所を都道府県から送ってください。\n例：大阪府大阪市北区梅田1-2-3 セブンマンション101')];
    },
    answer: function (s, input) {
      var t = String(input.text || '').trim();
      var pref = OPTIONS.prefectures.filter(function (p) { return t.indexOf(p) === 0; })[0];
      if (!pref) return '都道府県から入力してください。\n例：大阪府大阪市北区梅田1-2-3';
      var r = chatCheck_({ city: t.slice(pref.length).trim() }, function (v) { return v.text('city', { max: 100 }); });
      if (r.error) return '市区町村以降を' + r.error;
      s.data.postalCode = '';
      s.data.prefecture = pref;
      s.data.city = r.value;
    }
  },

  station: {
    label: '最寄り駅',
    ask: function () {
      return [textMessage_('最寄り駅を送ってください。\n（お仕事のご紹介と交通費の計算に使います）\n例：JR大阪駅')];
    },
    answer: function (s, input) {
      var r = chatCheck_({ nearestStation: input.text }, function (v) { return v.text('nearestStation', { max: 50 }); });
      if (r.error) return r.error;
      s.data.nearestStation = r.value;
    }
  },

  occupation: {
    label: '職業',
    ask: function () {
      return [quickText_('現在のご職業を選んでください。',
        OPTIONS.occupation.map(function (o) { return messageItem_(o); }))];
    },
    answer: function (s, input) {
      if (OPTIONS.occupation.indexOf(input.text) < 0) return '下のボタンから選んでください。';
      s.data.occupation = input.text;
    }
  },

  areas: {
    label: '希望エリア',
    ask: function (s) {
      var selected = s.data.areas || [];
      var text = '勤務を希望するエリアを、下のボタンからタップしてください（いくつでも選べます）。\n' +
        '選び終わったら「' + CHAT_DONE + '」を押してください。';
      if (selected.length) text += '\n\n選択中：' + selected.join(LIST_SEPARATOR);
      var items = OPTIONS.areas.map(function (a) {
        return messageItem_((selected.indexOf(a) >= 0 ? CHECK_MARK : '') + a, a);
      });
      items.push(messageItem_(CHAT_DONE));
      return [quickText_(text, items)];
    },
    answer: function (s, input) {
      var selected = s.data.areas || [];
      if (input.text === CHAT_DONE) {
        if (!selected.length) return '1つ以上選んでから「' + CHAT_DONE + '」を押してください。';
        s.data.areas = OPTIONS.areas.filter(function (a) { return selected.indexOf(a) >= 0; });
        return;
      }
      var area = String(input.text || '').replace(CHECK_MARK, '').trim();
      if (OPTIONS.areas.indexOf(area) < 0) return '下のボタンから選んでください。';
      var i = selected.indexOf(area);
      if (i >= 0) selected.splice(i, 1);
      else selected.push(area);
      s.data.areas = selected;
      return { stay: true };
    }
  },

  interview1: {
    label: '面接日時（第1希望）',
    ask: function (s, today) {
      return [quickText_('面接のご希望日時（第1希望）を、下の「日時を選ぶ」から選んでください。\n' +
        '担当者が調整のうえ、確定した日時をご連絡します。\n（「10/12 14:00」のように送ることもできます）',
        [interviewPicker_('interview1', today)])];
    },
    answer: function (s, input, today) {
      var r = chatCheck_({ interview1: input.datetime || input.text }, function (v) {
        return v.datetime('interview1', { today: today });
      });
      if (r.error) return r.error;
      s.data.interview1 = r.value;
      return { next: 'interview2' };
    }
  },

  interview2: {
    label: '面接日時（第2希望）',
    ask: function (s, today) {
      return [quickText_('第2希望の日時があれば選んでください。なければ「第2希望はなし」を押してください。',
        [interviewPicker_('interview2', today), messageItem_('第2希望はなし', CHAT_NO_SECOND)])];
    },
    answer: function (s, input, today) {
      if (input.text === CHAT_NO_SECOND) {
        s.data.interview2 = '';
        return;
      }
      var r = chatCheck_({ interview2: input.datetime || input.text }, function (v) {
        return v.datetime('interview2', { today: today });
      });
      if (r.error) return r.error;
      if (r.value === s.data.interview1) return '第1希望とは別の日時を選んでください。';
      s.data.interview2 = r.value;
    }
  },

  consent: {
    label: '個人情報の同意',
    ask: function () {
      return [quickText_(privacyText_() + '\n\n上記に同意し、反社会的勢力（暴力団など）に該当しないことを表明していただける場合は「' +
        CHAT_AGREE + '」を押してください。', [messageItem_(CHAT_AGREE), messageItem_(CHAT_DISAGREE)])];
    },
    answer: function (s, input) {
      if (input.text === CHAT_DISAGREE) {
        return { cancel: '同意いただけない場合は、ご登録いただくことができません。\nご不明な点があれば、このトークでお気軽にお問い合わせください。' };
      }
      if (input.text !== CHAT_AGREE) return '「' + CHAT_AGREE + '」か「' + CHAT_DISAGREE + '」を押してください。';
    }
  },

  confirm: {
    label: '最終確認',
    ask: function (s) {
      return [quickText_(chatSummary_(s.data) + '\n\nこの内容で登録してよろしいですか？',
        [messageItem_(CHAT_SUBMIT), messageItem_(CHAT_FIX)])];
    },
    answer: function (s, input) {
      if (input.text === CHAT_SUBMIT) return { complete: true };
      if (input.text === CHAT_FIX) return { next: 'edit' };
      return '「' + CHAT_SUBMIT + '」か「' + CHAT_FIX + '」を押してください。';
    }
  },

  edit: {
    label: '修正',
    ask: function () {
      return [quickText_('修正する項目を選んでください。',
        CHAT_EDIT_ITEMS.map(function (e) { return messageItem_(e[0]); }))];
    },
    answer: function (s, input) {
      var item = CHAT_EDIT_ITEMS.filter(function (e) { return e[0] === input.text; })[0];
      if (!item) return '下のボタンから選んでください。';
      s.editing = item[1] !== 'confirm';
      return { next: item[1] };
    }
  }
};

// ---- 進行 ----

function chatNewState_(today) {
  return { step: CHAT_ORDER[0], data: { areas: [] }, editing: false, startedAt: today ? today.getTime() : Date.now() };
}

function chatPrompt_(state, today) {
  return CHAT_STEPS[state.step].ask(state, today || new Date());
}

/**
 * 回答を1つ処理する。
 * input: { text } または日時選択の { postbackStep, date / datetime }
 * @return {{state, messages, complete, cancelled}}
 */
function chatAnswer_(state, input, today) {
  today = today || new Date();
  var text = String(input.text || '').trim();
  input = { text: text, date: input.date, datetime: input.datetime, postbackStep: input.postbackStep };

  if (text === CHAT_CANCEL) {
    return { cancelled: true, messages: [textMessage_('登録を中断しました。\nもう一度始めるときは「登録」と送ってください。')] };
  }
  if (text === CHAT_RESTART) {
    var fresh = chatNewState_(today);
    return { state: fresh, messages: [textMessage_('最初からやり直します。')].concat(chatPrompt_(fresh, today)) };
  }
  // 前の質問の日時選択ボタンを押した場合は、今の質問を出し直す
  if (input.postbackStep && input.postbackStep !== state.step) {
    return { state: state, messages: chatPrompt_(state, today) };
  }

  var step = CHAT_STEPS[state.step];
  var res = step.answer(state, input, today);
  if (typeof res === 'string') {
    return { state: state, messages: [textMessage_(res)].concat(chatPrompt_(state, today)) };
  }
  res = res || {};
  if (res.cancel) return { cancelled: true, messages: [textMessage_(res.cancel)] };
  if (res.complete) return { complete: true, state: state };

  if (!res.stay) {
    var next = res.next ||
      (state.editing ? 'confirm' : step.after || CHAT_ORDER[CHAT_ORDER.indexOf(state.step) + 1]);
    if (next === 'confirm') state.editing = false;
    state.step = next;
  }
  return { state: state, messages: chatPrompt_(state, today) };
}

/** チャットの回答 → validateRegistration に渡す形 */
function chatToRegistration_(d) {
  return {
    lastName: d.lastName, firstName: d.firstName, lastNameKana: d.lastNameKana, firstNameKana: d.firstNameKana,
    birthDate: d.birthDate, gender: d.gender, phone: d.phone,
    postalCode: d.postalCode, prefecture: d.prefecture, city: d.city, building: '',
    nearestStation: d.nearestStation, occupation: d.occupation, areas: d.areas,
    interview1: d.interview1, interview2: d.interview2,
    privacyConsent: true, antisocialConsent: true
  };
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
    question: CHAT_STEPS[state.step].label,
    state: JSON.stringify(state),
    startedAt: Utilities.formatDate(new Date(state.startedAt), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm:ss'),
    updatedAt: now_()
  });
}
