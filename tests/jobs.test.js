// 案件の取り込み・配信（gas/Jobs.gs）の計算と判定を Node で検証する: npm test
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ctx = vm.createContext({});
for (const f of ['Options.gs', 'Validation.gs', 'Line.gs', 'Sheet.gs', 'Interview.gs', 'Jobs.gs']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'gas', f), 'utf8'), ctx, { filename: f });
}
const plain = (x) => JSON.parse(JSON.stringify(x));

// Claude が返す形（JOB_DETAIL_SCHEMA）の例：依頼文の「①神戸港フォークリフト…」
const kobe = {
  client_name: '', title: '神戸港フォークリフト荷役技能向上大会', venue: 'メリケンパーク', prefecture: '兵庫県',
  address_access: '〒650-0042 兵庫県神戸市中央区波止場町２ 阪神本線元町駅から徒歩10分',
  position: 'イベント運営（受付・誘導・準備片付け）', conditions: '男女不問、40代前半まで', gender: '男女可',
  dress: '上：白カッターシャツ／下：黒パンツ、華美でないスニーカー', belongings: '筆記用具、メモ、腕時計',
  meeting_time: '', meeting_place: '', contact: '',
  pay_basis: '拘束時間', unit_price: 1600, min_hours: null,
  transport_fee: 660, transport_note: '阪神大阪梅田〜阪神元町 往復', meal_fee: null, meal_note: '支給あり予定',
  notes: '時間が前後する可能性あり',
  shifts: [{ date: '2026-10-08', holiday: false, start: '8:30', end: '15:30', break_minutes: null, headcount: 3, note: '' }]
};

// ⑥：4時間の勤務で5時間保証、食費なし
const kusatsu = Object.assign({}, kobe, {
  title: '子供向けイベント', venue: 'ABCハウジング草津住宅公園', prefecture: '滋賀県',
  min_hours: 5, transport_fee: 2240, meal_fee: null, meal_note: 'なし',
  shifts: [{ date: '2026-10-11', holiday: false, start: '08:30', end: '12:30', break_minutes: null, headcount: 2, note: '' }]
});

// ものづくりワールド：単価の記載なし、3日間 各日8名、休憩あり（例として60分）
const monozukuri = Object.assign({}, kobe, {
  title: 'ものづくりワールド', venue: 'インテックス大阪', prefecture: '大阪府', pay_basis: '記載なし', unit_price: null,
  transport_fee: null, meal_fee: null, meal_note: '昼食支給', meeting_time: '7:45', meeting_place: '西ゲート ロータリー側チケット売り場前',
  shifts: ['2026-10-09', '2026-10-07', '2026-10-08'].map((d) => ({ date: d, holiday: false, start: '8:00', end: '17:00', break_minutes: 60, headcount: 8, note: '' }))
});

const rowsOf = (cases, client) => plain(ctx.jobRows_(cases.map(ctx.normalizeCase_), { client: client || '〇〇企画', importId: '261006120000', paymentMonthsAfter: 1 }));

test('1日1行にして、曜日・時間・金額・計上月を計算する', () => {
  const [r] = rowsOf([kobe]);
  assert.strictEqual(r.client, '〇〇企画');
  assert.strictEqual(r.date, '2026/10/08');
  assert.strictEqual(r.weekday, '木');
  assert.strictEqual(r.start, '08:30');
  assert.strictEqual(r.end, '15:30');
  assert.strictEqual(r.payBasis, '拘束時間');
  assert.strictEqual(r.unit, '時給');
  assert.strictEqual(r.unitPrice, 1600);
  assert.strictEqual(r.sales, 1600 * 7 * 3);          // 拘束7時間 × 3名
  assert.strictEqual(r.transport, 660);
  assert.strictEqual(r.meal, '支給あり予定');
  assert.strictEqual(r.total, 1600 * 7 * 3 + 660 * 3);
  assert.strictEqual(r.workHours, '');                 // 休憩がわからないので空欄
  assert.strictEqual(r.salesMonth, '2026/10');
  assert.strictEqual(r.paymentMonth, '2026/11');
  assert.strictEqual(r.invoice, '未');
  assert.strictEqual(r.dress, '服装：上：白カッターシャツ／下：黒パンツ、華美でないスニーカー\n持ち物：筆記用具、メモ、腕時計');
  assert.strictEqual(r.staffTransport, '¥660（阪神大阪梅田〜阪神元町 往復）');
  assert.strictEqual(r.recruit, '募集中');
  assert.strictEqual(r.caseId, '261006120000-1');
  assert.strictEqual(r.slotId, '261006120000-1-1');
});

test('保証時間があれば、短い勤務でも保証時間で売上を計算する', () => {
  const [r] = rowsOf([kusatsu]);
  assert.strictEqual(r.sales, 1600 * 5 * 2);
  assert.strictEqual(r.total, 1600 * 5 * 2 + 2240 * 2);
  assert.match(r.notes, /5時間保証/);
  assert.strictEqual(r.meal, 'なし');
});

test('日程は日付順に並べ、単価がなければ売上は空欄', () => {
  const rows = rowsOf([monozukuri]);
  assert.deepStrictEqual(rows.map((r) => r.date + r.weekday), ['2026/10/07水', '2026/10/08木', '2026/10/09金']);
  assert.ok(rows.every((r) => r.breakHours === 1 && r.workHours === 8 && r.headcount === 8));
  assert.ok(rows.every((r) => r.sales === '' && r.total === '' && r.payBasis === '' && r.unit === ''));
  assert.strictEqual(rows[0].meetingTime, '7:45');
  assert.deepStrictEqual(rows.map((r) => r.slotId), ['261006120000-1-1', '261006120000-1-2', '261006120000-1-3']);
});

test('実働時間払い・食費の金額・祝日・日をまたぐ勤務', () => {
  const night = Object.assign({}, kobe, {
    pay_basis: '実働時間', meal_fee: 700, meal_note: '',
    shifts: [{ date: '2026-10-12', holiday: true, start: '22:00', end: '6:00', break_minutes: 60, headcount: 2, note: '' }]
  });
  const [r] = rowsOf([night]);
  assert.strictEqual(r.weekday, '月祝');
  assert.strictEqual(r.workHours, 7);
  assert.strictEqual(r.sales, 1600 * 7 * 2);
  assert.strictEqual(r.meal, 700);
  assert.strictEqual(r.total, 1600 * 7 * 2 + (660 + 700) * 2);
});

test('取引先名は依頼文から読めたものを優先、不正な日付は捨てる', () => {
  const c = Object.assign({}, kobe, { client_name: '株式会社サンプル', shifts: kobe.shifts.concat([{ date: '10月8日', holiday: false, start: '', end: '', break_minutes: null, headcount: null, note: '' }]) });
  const rows = rowsOf([c], '');
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].client, '株式会社サンプル');
});

test('確認画面で直した値（文字の数値・「2026/10/08」形式）も計算できる', () => {
  const c = ctx.normalizeCase_(kobe);
  c.unitPrice = '1,700';
  c.shifts[0].headcount = '4';
  c.shifts[0].breakHours = '0.5';
  const [r] = plain(ctx.jobRows_([c], { client: 'A', importId: 'X', paymentMonthsAfter: 2 }));
  assert.strictEqual(r.unitPrice, 1700);
  assert.strictEqual(r.sales, 1700 * 7 * 4);
  assert.strictEqual(r.workHours, 6.5);
  assert.strictEqual(r.paymentMonth, '2026/12');
});

test('年をまたぐ入金予定月', () => {
  assert.strictEqual(ctx.addMonths_('2026/12', 1), '2027/01');
  assert.strictEqual(ctx.addMonths_('2026/11', 3), '2027/02');
  assert.strictEqual(ctx.addMonths_('', 1), '');
});

test('時刻の正規化', () => {
  assert.strictEqual(ctx.normalizeTime_('8:00'), '08:00');
  assert.strictEqual(ctx.normalizeTime_('１３：３０'), '13:30');
  assert.strictEqual(ctx.normalizeTime_('9時'), '09:00');
  assert.strictEqual(ctx.normalizeTime_('未定'), '');
});

// ---- 配信 ----

const staff = [
  { userId: 'U1', status: '稼働可', areas: '大阪、兵庫', gender: '女性', weekdays: '土、日', lastName: '山田', firstName: '花子' },
  { userId: 'U2', status: '稼働可', areas: '京都', gender: '男性', weekdays: '月、祝', lastName: '佐藤', firstName: '太郎' },
  { userId: 'U3', status: '稼働可', areas: '大阪', gender: '男性', weekdays: '木', lastName: '鈴木', firstName: '一郎' },
  { userId: 'U4', status: '書類提出済', areas: '大阪', gender: '女性', weekdays: '木', lastName: '高橋', firstName: '恵' },
  { userId: 'U5', status: '稼働可', areas: '大阪', gender: '女性', weekdays: '木', blocked: 'ブロック中', lastName: '田中', firstName: '愛' }
];

const osakaFemale = rowsOf([Object.assign({}, kobe, { prefecture: '大阪府', gender: '女性のみ' })]);
const kyoto = rowsOf([Object.assign({}, kobe, { prefecture: '京都府', shifts: [Object.assign({}, kobe.shifts[0], { date: '2026-10-12', holiday: true })] })]);
kyoto.forEach((r) => { r.caseId = 'K'; r.slotId = 'K-1'; });

test('送信先：ステータス・ブロック・エリア・性別で絞る', () => {
  const req = { statuses: ['稼働可'], matchArea: true, matchGender: true, matchWeekday: false };
  const ids = (rows, r) => ctx.jobTargets_(staff, ctx.jobFilter_(rows, r || req)).map((s) => s.userId);
  assert.deepStrictEqual(ids(osakaFemale), ['U1']);
  assert.deepStrictEqual(ids(osakaFemale, Object.assign({}, req, { matchGender: false })), ['U1', 'U3']);
  assert.deepStrictEqual(ids(osakaFemale, Object.assign({}, req, { statuses: ['稼働可', '書類提出済'] })), ['U1', 'U4']);
  assert.deepStrictEqual(ids(kyoto), ['U2']);
  assert.deepStrictEqual(ids(kyoto, Object.assign({}, req, { matchArea: false, matchWeekday: true })), ['U2']); // 「月祝」→ 祝に〇
});

test('送信先は、受け取る案件の組み合わせごとにまとめる', () => {
  const req = { statuses: ['稼働可'], matchArea: false, matchGender: true, matchWeekday: false };
  const buckets = ctx.jobBuckets_(staff, [osakaFemale, kyoto], req);
  const view = buckets.map((b) => ({ titles: b.groups.map((g) => g[0].prefecture), ids: Array.from(b.userIds) }));
  assert.deepStrictEqual(plain(view), [
    { titles: ['大阪府', '京都府'], ids: ['U1'] },
    { titles: ['京都府'], ids: ['U2', 'U3'] }
  ]);
});

test('LINE のメッセージは上限（ボタンの文字数・postback・カルーセル）に収まる', () => {
  const many = rowsOf([Object.assign({}, monozukuri, {
    shifts: Array.from({ length: 10 }, (_, i) => ({ date: '2026-11-' + String(i + 1).padStart(2, '0'), holiday: false, start: '13:30', end: '18:45', break_minutes: null, headcount: 1, note: '' }))
  })]);
  many.forEach((r) => { r.staffPay = '時給1,200円'; });
  const msgs = plain(ctx.jobMessages_([osakaFemale, many]));
  assert.strictEqual(msgs.length, 1);
  assert.strictEqual(msgs[0].contents.type, 'carousel');
  assert.strictEqual(msgs[0].contents.contents.length, 3); // 1 + (8 + 2)
  assert.ok(msgs[0].altText.length <= 400);
  const buttons = msgs[0].contents.contents.flatMap((b) => b.footer.contents);
  assert.strictEqual(buttons.length, 11);
  buttons.forEach((b) => {
    assert.ok(b.action.label.length <= 40, b.action.label);
    assert.ok(b.action.data.length <= 300);
    assert.match(b.action.data, /^job=apply&s=/);
  });
  assert.strictEqual(buttons[1].action.label, '11/1(日) 13:30〜18:45');
  const text = JSON.stringify(msgs);
  assert.match(text, /時給1,200円/);
  assert.doesNotMatch(text, /1600|1,600/); // 請求単価はスタッフに見せない
  assert.doesNotMatch(text, /40代/);      // 年齢の条件も載せない
  assert.match(text, /女性スタッフ/);
  assert.ok(Buffer.byteLength(JSON.stringify(msgs[0].contents)) < 50000);
});

test('空の項目は LINE のメッセージに入れない（空の text は送信エラーになる）', () => {
  const bare = rowsOf([{ shifts: [{ date: '2026-10-20', start: '', end: '' }] }]);
  const msgs = plain(ctx.jobMessages_([bare]));
  const texts = [];
  const walk = (o) => { if (o && typeof o === 'object') { if (o.type === 'text') texts.push(o.text); if (o.type === 'box') assert.ok(o.contents.length); Object.values(o).forEach(walk); } };
  walk(msgs);
  assert.ok(texts.every((t) => typeof t === 'string' && t.length > 0), JSON.stringify(texts));
  assert.strictEqual(msgs[0].contents.footer.contents[0].action.label, '10/20(火)');
});

test('応募を受け付けるかの判定', () => {
  const slot = osakaFemale[0];
  const before = new Date(2026, 9, 8, 8, 29);
  assert.strictEqual(ctx.applyRejectReason_(slot, { userId: 'U1' }, false, before), '');
  assert.match(ctx.applyRejectReason_(slot, null, false, before), /スタッフ登録が済んだ方/);
  assert.match(ctx.applyRejectReason_(null, { userId: 'U1' }, false, before), /見つかりません/);
  assert.match(ctx.applyRejectReason_(slot, { userId: 'U1' }, true, before), /すでに応募/);
  assert.match(ctx.applyRejectReason_(slot, { userId: 'U1' }, false, new Date(2026, 9, 8, 8, 30)), /締め切りました/);
  assert.match(ctx.applyRejectReason_(Object.assign({}, slot, { recruit: '募集終了' }), { userId: 'U1' }, false, before), /締め切りました/);
});

test('応募・確定・見送りの文面', () => {
  const slot = Object.assign({}, osakaFemale[0], { staffPay: '時給1,200円', meetingTime: '8:15', meetingPlace: '正面入口' });
  assert.match(ctx.applyAcceptedText_(slot), /^応募を受け付けました。/);
  const app = { name: '山田 花子', title: slot.title, date: '2026/10/08', time: '08:30〜15:30' };
  const ok = ctx.applyConfirmedText_(app, slot);
  assert.match(ok, /確定しました/);
  assert.match(ok, /集合：8:15 正面入口/);
  assert.match(ok, /時給1,200円/);
  assert.doesNotMatch(ok, /1600/);
  assert.match(ctx.applyDeclinedText_(app), /定員に達したため/);
});

test('Claude に渡すスキーマは structured outputs の形（すべての項目が必須・追加の項目なし）', () => {
  const check = (s) => {
    if (s.type === 'object') {
      assert.strictEqual(s.additionalProperties, false);
      assert.deepStrictEqual(Array.from(s.required).sort(), Object.keys(s.properties).sort());
      Object.values(s.properties).forEach(check);
    }
    if (s.type === 'array') check(s.items);
  };
  check(plain(ctx.JOB_DETAIL_SCHEMA));
  check(plain(ctx.JOB_LIST_SCHEMA));
  assert.match(ctx.jobSystemPrompt_(new Date(2026, 9, 6)), /今日は 2026\/10\/06（火）/);
});

// ---- Claude の呼び出し（UrlFetchApp をまねて確認） ----

function claudeCtx(responder) {
  const calls = [];
  const c = vm.createContext({
    PropertiesService: { getScriptProperties: () => ({ getProperties: () => ({ ANTHROPIC_API_KEY: 'sk-test' }) }) },
    Utilities: { sleep: () => {} },
    UrlFetchApp: {
      fetchAll: (reqs) => reqs.map((r) => {
        const body = JSON.parse(r.payload);
        calls.push({ headers: r.headers, body });
        const [code, json] = responder(body, calls.length);
        return { getResponseCode: () => code, getContentText: () => JSON.stringify(json) };
      })
    }
  });
  for (const f of ['Options.gs', 'Validation.gs', 'Line.gs', 'Sheet.gs', 'Interview.gs', 'Code.gs', 'Jobs.gs', 'JobsApp.gs']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'gas', f), 'utf8'), c, { filename: f });
  }
  return { c, calls };
}

const okText = (obj) => [200, { stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: JSON.stringify(obj) }] }];

test('依頼文の読み取り：案件を数えてから、案件ごとに並列で読む', () => {
  const { c, calls } = claudeCtx((body) => {
    const ask = body.messages[0].content[1].text;
    if (/すべて挙げて/.test(ask)) return okText({ cases: [{ label: '①神戸港' }, { label: '⑥草津' }] });
    return okText(/「⑥草津」/.test(ask) ? kusatsu : kobe);
  });
  const r = plain(c.parseJobText('依頼文'));
  assert.deepStrictEqual(r.cases.map((x) => x.place), ['メリケンパーク', 'ABCハウジング草津住宅公園']);
  assert.strictEqual(calls.length, 3);
  const b = calls[0].body;
  assert.strictEqual(b.model, 'claude-opus-5-5');
  assert.strictEqual(b.output_config.effort, 'low');
  assert.strictEqual(b.output_config.format.type, 'json_schema');
  assert.strictEqual(b.fallbacks, 'default');
  assert.strictEqual(calls[0].headers['anthropic-beta'], 'server-side-fallback-2026-07-01');
  assert.strictEqual(b.thinking, undefined);
  assert.strictEqual(b.temperature, undefined);
});

test('読み取り：混雑（529）は待ってやり直し、fallbacks を受け付けないときは外してやり直す', () => {
  const { c, calls } = claudeCtx((body, n) => {
    if (n === 1) return [529, { error: { message: 'Overloaded' } }];
    if (n === 2) return [400, { error: { message: 'fallbacks: unsupported' } }];
    return okText({ cases: [] });
  });
  assert.throws(() => c.parseJobText('依頼文'), /案件を読み取れませんでした/);
  assert.strictEqual(calls.length, 3);
  assert.strictEqual(calls[2].body.fallbacks, undefined);
});

test('読み取り：APIキーの誤り・断られた・長すぎる', () => {
  assert.throws(() => claudeCtx(() => [401, { error: { message: 'invalid x-api-key' } }]).c.parseJobText('x'), /APIキー/);
  assert.throws(() => claudeCtx(() => [200, { stop_reason: 'refusal', content: [] }]).c.parseJobText('x'), /断りました/);
  assert.throws(() => claudeCtx(() => [200, { stop_reason: 'max_tokens', content: [] }]).c.parseJobText('x'), /分けて/);
  assert.throws(() => claudeCtx(() => okText({})).c.parseJobText('   '), /貼り付けてください/);
});
