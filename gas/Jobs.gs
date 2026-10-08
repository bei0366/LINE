/**
 * 案件の取り込み（お客様から届いたテキスト → シート「案件一覧」）と、スタッフへの LINE 配信。
 *
 * このファイルの関数はシート・LINE・Claude に触れないので、tests/jobs.test.js で確認できる。
 * 実際の読み書きは JobsApp.gs、画面は JobImport.html / JobSend.html。
 *
 * 1行 = 1日（同じ日に時間帯が複数あるときは時間帯ごと）。売上などの計算列はこのファイルで計算する。
 */

var RECRUIT = { OPEN: '募集中', CLOSED: '募集終了' };
var APPLY_STATUS = { APPLIED: '応募', CONFIRMED: '確定', DECLINED: '見送り', CANCELLED: '辞退' };
var INVOICE_OPTIONS = ['未', '発行済', '入金済'];

var PAY_BASIS = ['拘束時間', '実働時間', '日給', '記載なし'];
var GENDER_REQ = ['男女可', '男性のみ', '女性のみ', '記載なし'];

/** 1つのバブルに並べる応募ボタンの数（多い日程は次のバブルに分ける） */
var SLOTS_PER_BUBBLE = 8;
var MAX_BUBBLES = 12;          // カルーセル1つあたり（LINE の上限）
var MAX_MESSAGES = 5;          // 1回の送信あたり（LINE の上限）
var MULTICAST_LIMIT = 500;     // 1回の一斉送信の宛先（LINE の上限）

// ---- Claude への指示 ----

function jobSystemPrompt_(today) {
  return 'あなたはイベントスタッフ派遣会社「セブンハーツ」の案件管理担当です。' +
    '取引先（お客様）からメールやLINEで届いた人員手配の依頼文を読み、案件表に入力する項目を取り出します。\n\n' +
    '今日は ' + ymd_(today) + '（' + WEEKDAYS_JA[today.getDay()] + '）です。年が書かれていない日付は、今日以降で最も近い年の日付にしてください。\n\n' +
    '守ること：\n' +
    '- 書かれていないことは推測で埋めず、空文字または null にする（休憩時間・人数・金額も同じ）\n' +
    '- 金額は円の数値だけにする（「¥1,600」→ 1600）\n' +
    '- 依頼文は複数のメッセージが混ざっていたり、案件の一覧と詳細が離れて書かれていたり、' +
    '服装などの続きが文の最後に書かれていたりします。対象の案件に関係する部分をすべて読んでまとめる\n' +
    '- 他の案件の情報を混ぜない';
}

/** 1回目：依頼文に含まれる案件を数える */
function jobListPrompt_() {
  return '上の依頼文に含まれる案件（イベント・現場ごと）を、書かれている順にすべて挙げてください。' +
    'label には、その案件だとわかる番号・名称・会場を依頼文の書き方のまま入れてください（例：「②パン祭り＠ららぽーとエキスポシティ」）。' +
    '同じイベントで日程が複数あっても1つの案件です。';
}

/** 2回目：案件ごとに詳しく読む */
function jobDetailPrompt_(label, all) {
  return '上の依頼文に含まれる案件は次のとおりです：\n' + all.map(function (l) { return '・' + l; }).join('\n') + '\n\n' +
    'このうち「' + label + '」の案件だけについて、項目を取り出してください。\n\n' + JOB_FIELD_RULES_;
}

/** Gemini 用：1回の問い合わせですべての案件を読む（無料枠は1日の回数が少ないため） */
function jobAllPrompt_() {
  return '上の依頼文に含まれる案件（イベント・現場ごと）を、書かれている順にすべて取り出して cases に入れてください。' +
    '同じイベントで日程が複数あっても1つの案件です。案件ごとに、次のとおり項目を入れてください。\n\n' + JOB_FIELD_RULES_;
}

var JOB_FIELD_RULES_ =
    '- shifts：勤務する日ごとに1つ。同じ日に時間帯が複数あれば時間帯ごとに分け、それぞれの人数を入れる。' +
    '「10/7〜9 各日8名」なら3日分それぞれ8名。日によって時間が違えばその日の時間を使う\n' +
    '- start / end：勤務時間（集合時間ではない）。「HH:MM」の24時間表記\n' +
    '- holiday：日付に「祝」と書かれていれば true\n' +
    '- position：仕事内容を短く（例：「案内業務」「イベント運営（受付・誘導・準備片付け）」）\n' +
    '- pay_basis：「拘束時間×¥1,600」なら「拘束時間」と unit_price 1600。日当なら「日給」\n' +
    '- min_hours：「5h保証」など最低保証時間があれば時間数\n' +
    '- transport_fee：1人あたりの交通費（往復の金額）。transport_note に区間など\n' +
    '- meal_fee：食費の金額。金額がなく「支給あり」「なし」などなら meal_note に入れる\n' +
    '- gender：性別の指定（「男女不問」「男女可能」は 男女可）。conditions には性別・年齢などの条件をそのまま\n' +
    '- notes：時間が前後する可能性など、上の項目に入らない注意事項（短く）\n' +
    '- client_name：依頼文に依頼元の会社名がはっきり書かれていれば。なければ空文字';

var NULLABLE_INT_ = { anyOf: [{ type: 'integer' }, { type: 'null' }] };
var NULLABLE_NUM_ = { anyOf: [{ type: 'number' }, { type: 'null' }] };

function objectSchema_(props) {
  return { type: 'object', properties: props, required: Object.keys(props), additionalProperties: false };
}

var JOB_LIST_SCHEMA = objectSchema_({
  cases: { type: 'array', items: objectSchema_({ label: { type: 'string' } }) }
});

var JOB_DETAIL_SCHEMA = objectSchema_({
  client_name: { type: 'string' },
  title: { type: 'string' },
  venue: { type: 'string' },
  prefecture: { type: 'string', description: '会場の都道府県（例：大阪府）。わからなければ空文字' },
  address_access: { type: 'string', description: '住所と最寄り駅からのアクセス' },
  position: { type: 'string' },
  conditions: { type: 'string' },
  gender: { type: 'string', enum: GENDER_REQ },
  dress: { type: 'string' },
  belongings: { type: 'string' },
  meeting_time: { type: 'string' },
  meeting_place: { type: 'string' },
  contact: { type: 'string', description: '現場の集合担当者・連絡先' },
  pay_basis: { type: 'string', enum: PAY_BASIS },
  unit_price: NULLABLE_INT_,
  min_hours: NULLABLE_NUM_,
  transport_fee: NULLABLE_INT_,
  transport_note: { type: 'string' },
  meal_fee: NULLABLE_INT_,
  meal_note: { type: 'string' },
  notes: { type: 'string' },
  shifts: {
    type: 'array',
    items: objectSchema_({
      date: { type: 'string', description: 'YYYY-MM-DD' },
      holiday: { type: 'boolean' },
      start: { type: 'string', description: 'HH:MM。不明なら空文字' },
      end: { type: 'string', description: 'HH:MM。不明なら空文字' },
      break_minutes: NULLABLE_INT_,
      headcount: NULLABLE_INT_,
      note: { type: 'string' }
    })
  }
});

var JOB_ALL_SCHEMA = objectSchema_({ cases: { type: 'array', items: JOB_DETAIL_SCHEMA } });

// ---- 日付と時間 ----

// WEEKDAYS_JA・pad2_ は Validation.gs のものを使う

function ymd_(d) {
  return d.getFullYear() + '/' + pad2_(d.getMonth() + 1) + '/' + pad2_(d.getDate());
}

/** 「2026-10-08」「2026/10/8」→ Date（不正なら null） */
function parseYmd_(s) {
  if (Object.prototype.toString.call(s) === '[object Date]') return isNaN(s.getTime()) ? null : s;
  var m = /^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/.exec(String(s || '').trim());
  if (!m) return null;
  var d = new Date(+m[1], m[2] - 1, +m[3]);
  return d.getMonth() === m[2] - 1 ? d : null;
}

/** 「8:30」「08:30」「8時30分」→ 「08:30」（不正なら ''） */
function normalizeTime_(s) {
  if (Object.prototype.toString.call(s) === '[object Date]') return pad2_(s.getHours()) + ':' + pad2_(s.getMinutes());
  var m = /^(\d{1,2})\s*[:：時]\s*(\d{0,2})/.exec(String(s || '').trim().replace(/[０-９]/g, function (c) {
    return String.fromCharCode(c.charCodeAt(0) - 0xFEE0);
  }));
  if (!m || +m[1] > 30 || +(m[2] || 0) > 59) return '';
  return pad2_(+m[1]) + ':' + pad2_(+(m[2] || 0));
}

function minutesOf_(hhmm) {
  var t = normalizeTime_(hhmm);
  if (!t) return null;
  return +t.slice(0, 2) * 60 + +t.slice(3);
}

/** 開始〜終了の時間数（日をまたぐ場合も）。不明なら null */
function spanHours_(start, end) {
  var s = minutesOf_(start), e = minutesOf_(end);
  if (s === null || e === null) return null;
  if (e <= s) e += 24 * 60;
  return round2_((e - s) / 60);
}

function round2_(n) {
  return Math.round(n * 100) / 100;
}

/** 「2026/10」に months か月足す */
function addMonths_(ym, months) {
  var m = /^(\d{4})\/(\d{2})$/.exec(ym || '');
  if (!m) return '';
  var d = new Date(+m[1], +m[2] - 1 + months, 1);
  return d.getFullYear() + '/' + pad2_(d.getMonth() + 1);
}

function isNum_(v) {
  return typeof v === 'number' && isFinite(v);
}

/** シートの値（文字の「1,600」なども）→ 数値。空なら null */
function toNum_(v) {
  if (isNum_(v)) return v;
  var s = String(v === null || v === undefined ? '' : v).replace(/[¥￥,，円\s]/g, '').replace(/[０-９．]/g, function (c) {
    return String.fromCharCode(c.charCodeAt(0) - 0xFEE0);
  });
  if (!s || !/^-?\d+(\.\d+)?$/.test(s)) return null;
  return +s;
}

// ---- Claude の結果 → 画面で確認する案件 ----

function str_(v) {
  return v === null || v === undefined ? '' : String(v).trim();
}

/**
 * Claude が返した1案件を、確認画面とシートで使う形にそろえる。
 * 不正な日付は捨て、時間は「HH:MM」にそろえる。
 */
function normalizeCase_(c) {
  var shifts = (c.shifts || []).map(function (s) {
    var d = parseYmd_(s.date);
    if (!d) return null;
    return {
      date: ymd_(d),
      holiday: !!s.holiday,
      start: normalizeTime_(s.start),
      end: normalizeTime_(s.end),
      breakHours: isNum_(s.break_minutes) ? round2_(s.break_minutes / 60) : null,
      headcount: isNum_(s.headcount) && s.headcount > 0 ? s.headcount : null,
      note: str_(s.note)
    };
  }).filter(Boolean);
  shifts.sort(function (a, b) {
    return a.date < b.date ? -1 : a.date > b.date ? 1 : (a.start < b.start ? -1 : a.start > b.start ? 1 : 0);
  });
  return {
    client: str_(c.client_name),
    title: str_(c.title),
    place: str_(c.venue),
    prefecture: str_(c.prefecture),
    address: str_(c.address_access),
    position: str_(c.position),
    conditions: str_(c.conditions),
    genderReq: GENDER_REQ.indexOf(c.gender) >= 0 ? c.gender : '記載なし',
    dress: str_(c.dress),
    belongings: str_(c.belongings),
    meetingTime: str_(c.meeting_time),
    meetingPlace: str_(c.meeting_place),
    contact: str_(c.contact),
    payBasis: PAY_BASIS.indexOf(c.pay_basis) >= 0 ? c.pay_basis : '記載なし',
    unitPrice: isNum_(c.unit_price) ? c.unit_price : null,
    minHours: isNum_(c.min_hours) ? c.min_hours : null,
    transport: isNum_(c.transport_fee) ? c.transport_fee : null,
    transportNote: str_(c.transport_note),
    mealFee: isNum_(c.meal_fee) ? c.meal_fee : null,
    mealNote: str_(c.meal_note),
    notes: str_(c.notes),
    shifts: shifts
  };
}

function unitOf_(payBasis) {
  if (payBasis === '拘束時間' || payBasis === '実働時間') return '時給';
  if (payBasis === '日給') return '日給';
  return '';
}

function dressText_(c) {
  var parts = [];
  if (c.dress) parts.push('服装：' + c.dress);
  if (c.belongings) parts.push('持ち物：' + c.belongings);
  return parts.join('\n');
}

function yen_(n) {
  return '¥' + String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * 1日（1時間帯）分の金額。
 * 売上 = 単価 ×（時給なら請求する時間）× 人数、総支払額 = 売上 ＋（交通費＋食費）× 人数。
 * 人数や単価がわからないときは空欄にする（推測しない）。
 */
function jobAmounts_(row, minHours) {
  var span = spanHours_(row.start, row.end);
  var brk = isNum_(row.breakHours) ? row.breakHours : null;
  var work = span !== null && brk !== null ? round2_(Math.max(0, span - brk)) : null;
  var hours = null;
  if (row.payBasis === '拘束時間') hours = span;
  else if (row.payBasis === '実働時間') hours = work;
  else if (row.payBasis === '日給') hours = 1;
  if (hours !== null && isNum_(minHours) && row.payBasis !== '日給') hours = Math.max(hours, minHours);

  var n = isNum_(row.headcount) ? row.headcount : null;
  var sales = isNum_(row.unitPrice) && hours !== null && n !== null ? Math.round(row.unitPrice * hours * n) : null;
  var extras = (isNum_(row.transport) ? row.transport : 0) + (isNum_(row.meal) ? row.meal : 0);
  var total = sales !== null ? sales + extras * n : null;
  return { workHours: work, sales: sales, total: total };
}

/**
 * 確認画面で直した案件 → シートの行（1日・1時間帯ごと）。
 * @param {Array} cases normalizeCase_ の形（画面で直したもの）
 * @param {{client: string, importId: string, paymentMonthsAfter: number}} opts
 */
function jobRows_(cases, opts) {
  var rows = [];
  cases.forEach(function (c, ci) {
    var caseId = opts.importId + '-' + (ci + 1);
    (c.shifts || []).forEach(function (s, si) {
      var d = parseYmd_(s.date);
      var row = {
        client: str_(c.client) || str_(opts.client),
        title: c.title,
        place: c.place,
        position: c.position,
        date: d ? ymd_(d) : str_(s.date),
        start: normalizeTime_(s.start),
        end: normalizeTime_(s.end),
        weekday: d ? WEEKDAYS_JA[d.getDay()] + (s.holiday ? '祝' : '') : '',
        breakHours: toNum_(s.breakHours),
        dress: dressText_(c),
        payBasis: c.payBasis === '記載なし' ? '' : c.payBasis,
        unit: unitOf_(c.payBasis),
        unitPrice: toNum_(c.unitPrice),
        transport: toNum_(c.transport),
        meal: toNum_(c.mealFee) !== null ? toNum_(c.mealFee) : str_(c.mealNote),
        invoice: INVOICE_OPTIONS[0],
        salesMonth: d ? d.getFullYear() + '/' + pad2_(d.getMonth() + 1) : '',
        headcount: toNum_(s.headcount),
        conditions: c.conditions,
        meetingTime: c.meetingTime,
        meetingPlace: c.meetingPlace,
        address: c.address,
        contact: c.contact,
        notes: [c.notes, s.note, isNum_(toNum_(c.minHours)) ? toNum_(c.minHours) + '時間保証' : '',
          c.transportNote ? '交通費：' + c.transportNote : ''].filter(Boolean).join('／'),
        staffPay: '',
        staffTransport: toNum_(c.transport) !== null ? yen_(toNum_(c.transport)) + (c.transportNote ? '（' + c.transportNote + '）' : '') : '',
        recruit: RECRUIT.OPEN,
        applied: 0,
        prefecture: c.prefecture,
        genderReq: c.genderReq,
        caseId: caseId,
        slotId: caseId + '-' + (si + 1),
        importId: opts.importId
      };
      var a = jobAmounts_(row, toNum_(c.minHours));
      row.workHours = a.workHours;
      row.sales = a.sales;
      row.total = a.total;
      row.paymentMonth = addMonths_(row.salesMonth, opts.paymentMonthsAfter);
      Object.keys(row).forEach(function (k) { if (row[k] === null) row[k] = ''; });
      rows.push(row);
    });
  });
  return rows;
}

// ---- LINE 配信 ----

/** 「10/8(木) 8:30〜15:30」 */
function slotLabel_(row) {
  var d = parseYmd_(row.date);
  var date = d ? (d.getMonth() + 1) + '/' + d.getDate() + '(' + (row.weekday || WEEKDAYS_JA[d.getDay()]) + ')' : str_(row.date);
  var t = function (x) { return normalizeTime_(x).replace(/^0/, ''); };
  var time = row.start ? t(row.start) + '〜' + (row.end ? t(row.end) : '') : '';
  return (date + ' ' + time).trim();
}

/** 都道府県 → 登録フォームの希望エリア（大阪府 → 大阪） */
function areaOf_(prefecture) {
  return str_(prefecture).replace(/[都府県]$/, '');
}

/**
 * 案件を受け取るスタッフを選ぶ。
 * @param {Array} staff シート「スタッフ登録」の行（rowToRecord_ の形）
 * @param {{statuses: string[], areas: string[], gender: string, weekdays: string[]}} f
 *   areas：案件のエリア（空なら絞らない）／gender：'女性のみ' などの指定（なければ絞らない）／
 *   weekdays：案件の曜日（空なら絞らない）
 */
function jobTargets_(staff, f) {
  return staff.filter(function (r) {
    if (!r.userId || r.blocked) return false;
    if (f.statuses.indexOf(r.status) < 0) return false;
    if (f.areas && f.areas.length) {
      var mine = str_(r.areas).split(LIST_SEPARATOR);
      if (!f.areas.some(function (a) { return mine.indexOf(a) >= 0; })) return false;
    }
    if (f.gender === '女性のみ' && r.gender !== '女性') return false;
    if (f.gender === '男性のみ' && r.gender !== '男性') return false;
    if (f.weekdays && f.weekdays.length) {
      var days = str_(r.weekdays).split(LIST_SEPARATOR);
      if (!f.weekdays.some(function (w) { return days.indexOf(w) >= 0; })) return false;
    }
    return true;
  });
}

/**
 * 1案件の送信先の条件。
 * @param {Array} rows 同じ案件IDの行
 * @param {{statuses: string[], matchArea: boolean, matchGender: boolean, matchWeekday: boolean}} req 画面で選んだ条件
 */
function jobFilter_(rows, req) {
  var weekdays = [];
  rows.forEach(function (r) {
    // 「月祝」は「月」と「祝」のどちらかが勤務できる曜日に入っていれば対象
    String(r.weekday || '').split('').forEach(function (c) { if (weekdays.indexOf(c) < 0) weekdays.push(c); });
  });
  var area = areaOf_(rows[0].prefecture);
  return {
    statuses: req.statuses && req.statuses.length ? req.statuses : [STATUS.ACTIVE],
    areas: req.matchArea && area ? [area] : [],
    gender: req.matchGender ? rows[0].genderReq : '',
    weekdays: req.matchWeekday ? weekdays : []
  };
}

/**
 * 送信先を「受け取る案件の組み合わせ」ごとにまとめる。
 * 例：大阪の案件と京都の案件を選んだら、大阪だけ希望の人・京都だけ・両方の人で別々に送る。
 * @param {Array} groups 案件IDごとの行の配列
 * @return {Array<{groups: Array, userIds: string[]}>}
 */
function jobBuckets_(staff, groups, req) {
  var matched = {}; // userId → この人が受け取る案件（groups の番号）
  var order = [];
  groups.forEach(function (rows, gi) {
    jobTargets_(staff, jobFilter_(rows, req)).forEach(function (r) {
      if (!matched[r.userId]) { matched[r.userId] = []; order.push(r.userId); }
      matched[r.userId].push(gi);
    });
  });
  var buckets = {};
  var keys = [];
  order.forEach(function (id) {
    var key = matched[id].join(',');
    if (!buckets[key]) {
      buckets[key] = { groups: matched[id].map(function (gi) { return groups[gi]; }), userIds: [] };
      keys.push(key);
    }
    buckets[key].userIds.push(id);
  });
  return keys.map(function (k) { return buckets[k]; });
}

function infoLine_(label, text) {
  return {
    type: 'box', layout: 'baseline', spacing: 'sm',
    contents: [
      { type: 'text', text: label, size: 'xs', color: '#888888', flex: 2 },
      { type: 'text', text: text, size: 'xs', wrap: true, flex: 7 }
    ]
  };
}

/**
 * 1案件ぶんのバブル（応募ボタンは日程・時間帯ごと）。日程が多いときは複数のバブルに分ける。
 * @param {Array} rows 同じ案件IDの行（募集中のものだけ）
 */
function jobBubbles_(rows) {
  var first = rows[0];
  var meal = isNum_(toNum_(first.meal)) ? (toNum_(first.meal) > 0 ? yen_(toNum_(first.meal)) + ' 支給' : '') : str_(first.meal);
  var info = [];
  var where = [first.place, first.address].filter(Boolean).join('\n');
  if (where) info.push(infoLine_('場所', where));
  if (first.position) info.push(infoLine_('仕事', first.position));
  if (first.genderReq === '女性のみ') info.push(infoLine_('募集', '女性スタッフ'));
  if (first.genderReq === '男性のみ') info.push(infoLine_('募集', '男性スタッフ'));
  if (first.meetingTime || first.meetingPlace) info.push(infoLine_('集合', [first.meetingTime, first.meetingPlace].filter(Boolean).join('\n')));
  if (first.dress) info.push(infoLine_('服装', first.dress));
  if (first.staffPay) info.push(infoLine_('給与', first.staffPay));
  if (first.staffTransport) info.push(infoLine_('交通費', first.staffTransport));
  if (meal && meal !== 'なし') info.push(infoLine_('食事', meal));

  var bubbles = [];
  for (var i = 0; i < rows.length; i += SLOTS_PER_BUBBLE) {
    var chunk = rows.slice(i, i + SLOTS_PER_BUBBLE);
    var buttons = chunk.map(function (r) {
      return {
        type: 'button', style: 'primary', color: BRAND_BROWN, height: 'sm',
        action: { type: 'postback', label: slotLabel_(r).slice(0, 40), data: 'job=apply&s=' + encodeURIComponent(r.slotId), displayText: slotLabel_(r) + ' に応募します' }
      };
    });
    bubbles.push({
      type: 'bubble',
      body: {
        type: 'box', layout: 'vertical', spacing: 'md',
        contents: [
          { type: 'text', text: 'お仕事のご案内', size: 'xs', color: BRAND_BROWN, weight: 'bold' },
          { type: 'text', text: (first.title || 'お仕事') + (i > 0 ? '（つづき）' : ''), weight: 'bold', size: 'md', wrap: true },
          // LINE は中身が空の box や text を受け付けないので、項目がなければ入れない
          info.length ? { type: 'box', layout: 'vertical', spacing: 'xs', contents: info } : null,
          { type: 'text', text: '働ける日時のボタンを押すと応募できます（複数可）。', size: 'xxs', color: '#888888', wrap: true }
        ].filter(Boolean)
      },
      footer: { type: 'box', layout: 'vertical', spacing: 'sm', contents: buttons }
    });
  }
  return bubbles;
}

/** 選んだ案件（案件IDごとの行）→ 送信するメッセージ（カルーセル。最大5通） */
function jobMessages_(groups) {
  var bubbles = [];
  groups.forEach(function (rows) { bubbles = bubbles.concat(jobBubbles_(rows)); });
  if (!bubbles.length) return [];
  if (bubbles.length > MAX_BUBBLES * MAX_MESSAGES) throw new Error('一度に送れる案件が多すぎます。案件を分けて配信してください');
  var messages = [];
  for (var i = 0; i < bubbles.length; i += MAX_BUBBLES) {
    var part = bubbles.slice(i, i + MAX_BUBBLES);
    messages.push({
      type: 'flex',
      altText: 'お仕事のご案内：' + groups.map(function (g) { return g[0].title; }).join('、').slice(0, 300),
      contents: part.length === 1 ? part[0] : { type: 'carousel', contents: part }
    });
  }
  return messages;
}

/**
 * 応募ボタンが押されたときに、応募を受け付けてよいか。受け付けられない理由（なければ ''）。
 * @param {Object|null} slot 「案件一覧」の行
 * @param {Object|null} staff 「スタッフ登録」の行
 * @param {boolean} already すでに同じ枠に応募しているか
 */
function applyRejectReason_(slot, staff, already, now) {
  if (!staff) return 'お仕事への応募は、スタッフ登録が済んだ方のみ受け付けています。';
  if (!slot) return 'この募集は見つかりませんでした。募集が終了した可能性があります。';
  if (slot.recruit !== RECRUIT.OPEN) return slotLabel_(slot) + ' の「' + slot.title + '」は、募集を締め切りました。';
  var d = parseYmd_(slot.date);
  if (d) {
    var startMin = minutesOf_(slot.start);
    var begins = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, startMin === null ? 0 : startMin);
    if (now >= begins) return slotLabel_(slot) + ' の「' + slot.title + '」は、募集を締め切りました。';
  }
  if (already) return slotLabel_(slot) + ' の「' + slot.title + '」には、すでに応募いただいています。結果をお待ちください。';
  return '';
}

function applyAcceptedText_(slot) {
  return '応募を受け付けました。\n\n' + slot.title + '\n📅 ' + slotLabel_(slot) + '\n📍 ' + slot.place +
    '\n\n担当者が確認して、このトークで結果をお知らせします。';
}

function applyConfirmedText_(app, slot) {
  var lines = [app.name + ' さん\n\nお仕事が確定しました！よろしくお願いいたします。\n', '■ ' + app.title, '📅 ' + app.date + ' ' + app.time];
  if (slot) {
    lines.push('📍 ' + slot.place + (slot.address ? '\n　 ' + slot.address : ''));
    if (slot.meetingTime || slot.meetingPlace) lines.push('⏰ 集合：' + [slot.meetingTime, slot.meetingPlace].filter(Boolean).join(' '));
    if (slot.dress) lines.push('👔 ' + slot.dress.replace(/\n/g, '\n　 '));
    if (slot.staffPay) lines.push('💴 ' + slot.staffPay);
  }
  lines.push('\nご都合が悪くなった場合は、すぐにこのトークでお知らせください。');
  return lines.join('\n');
}

function applyDeclinedText_(app) {
  return app.name + ' さん\n\n「' + app.title + '」（' + app.date + ' ' + app.time + '）にご応募いただき、ありがとうございました。\n\n' +
    '今回は定員に達したため、ご案内できませんでした。またのご応募をお待ちしています。';
}
