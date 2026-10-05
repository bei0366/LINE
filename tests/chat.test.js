// トークでのスタッフ登録（gas/Chat.gs）の流れを Node で検証する: npm test
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ctx = vm.createContext({});
for (const f of ['Options.gs', 'Validation.gs', 'Line.gs', 'Chat.gs']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'gas', f), 'utf8'), ctx, { filename: f });
}
vm.runInContext(`
  getConfig_ = function () { return { privacyPolicyUrl: 'https://example.com/privacy.html', liffId: 'x' }; };
  lookupZip_ = function (zip) {
    return zip === '5300001' ? { prefecture: '大阪府', city: '大阪市北区梅田' } : null;
  };
`, ctx);

const TODAY = new Date(2026, 9, 5, 10, 0); // 2026-10-05 10:00

/** 回答を順に送り、最後の結果を返す */
function run(answers, state) {
  state = state || ctx.chatNewState_(TODAY);
  let res;
  for (const a of answers) {
    res = ctx.chatAnswer_(state, typeof a === 'string' ? { text: a } : a, TODAY);
    if (res.state) state = res.state;
    if (res.complete || res.cancelled) break;
  }
  return { res, state };
}

const lastText = (res) => res.messages[res.messages.length - 1].text;
const quickLabels = (res) => Array.from(res.messages[res.messages.length - 1].quickReply.items, (i) => i.action.label);

const FULL = [
  '山田　花子', 'やまだ はなこ', { postbackStep: 'birthDate', date: '2000-04-01' }, '女性',
  '090-1234-5678', '530-0001', '1-2-3 セブンマンション101', 'JR大阪駅', 'フリーター',
  '大阪', '京都', '決定',
  { postbackStep: 'interview1', datetime: '2026-10-12T14:00' }, 'なし', '同意する'
];

test('最後まで答えると確認画面になり、登録用のデータがそろう', () => {
  const { res, state } = run(FULL);
  assert.strictEqual(state.step, 'confirm');
  assert.match(lastText(res), /お名前：山田 花子（ヤマダ ハナコ）/);
  assert.match(lastText(res), /住所：〒5300001 大阪府大阪市北区梅田1-2-3 セブンマンション101/);
  assert.match(lastText(res), /希望エリア：大阪、京都/);
  assert.match(lastText(res), /第1希望：2026\/10\/12\(月\) 14:00/);
  assert.deepStrictEqual(quickLabels(res), ['登録する', '修正する']);

  const done = ctx.chatAnswer_(state, { text: '登録する' }, TODAY);
  assert.ok(done.complete);
  const record = ctx.validateRegistration(ctx.chatToRegistration_(state.data), TODAY);
  assert.strictEqual(record.lastNameKana, 'ヤマダ');
  assert.strictEqual(record.phone, '09012345678');
  assert.strictEqual(record.areas, '大阪、京都');
  assert.strictEqual(record.interview1, '2026/10/12(月) 14:00');
  assert.strictEqual(record.interview2, '');
});

test('名前にスペースがないと聞き直す', () => {
  const { res, state } = run(['山田花子']);
  assert.strictEqual(state.step, 'name');
  assert.match(res.messages[0].text, /スペース/);
});

test('不正な回答では次に進まず、エラーと同じ質問を返す', () => {
  const { res, state } = run(['山田 花子', 'やまだ はなこ', '2015/01/01']);
  assert.strictEqual(state.step, 'birthDate');
  assert.match(res.messages[0].text, /中学校卒業前/);
  assert.strictEqual(res.messages[1].quickReply.items[0].action.type, 'datetimepicker');
});

test('希望エリアはタップで選択・解除でき、未選択では決定できない', () => {
  const upTo = FULL.slice(0, 9);
  let { res, state } = run(upTo);
  assert.strictEqual(state.step, 'areas');
  ({ res, state } = run(['決定'], state));
  assert.match(res.messages[0].text, /1つ以上/);
  ({ res, state } = run(['兵庫', '奈良', '✓ 兵庫'], state));
  assert.deepStrictEqual(Array.from(state.data.areas), ['奈良']);
  assert.ok(quickLabels(res).includes('✓ 奈良'));
  assert.match(lastText(res), /選択中：奈良/);
});

test('郵便番号がわからない場合は住所を都道府県から入力できる', () => {
  const { state } = run([...FULL.slice(0, 5), '郵便番号がわからない', '大阪府堺市堺区1-1']);
  assert.strictEqual(state.step, 'station');
  assert.strictEqual(state.data.prefecture, '大阪府');
  assert.strictEqual(state.data.city, '堺市堺区1-1');
  assert.strictEqual(state.data.postalCode, '');
});

test('存在しない郵便番号は聞き直す', () => {
  const { res, state } = run([...FULL.slice(0, 5), '9999999']);
  assert.strictEqual(state.step, 'postal');
  assert.match(res.messages[0].text, /見つかりません/);
});

test('面接日時：過去・手入力・第1希望と同じ日時', () => {
  const upTo = FULL.slice(0, 12);
  let { res, state } = run([...upTo, '10/1 10:00']);
  assert.strictEqual(state.step, 'interview1');
  assert.match(res.messages[0].text, /今より後/);
  ({ res, state } = run(['10/12 14時'], state));
  assert.strictEqual(state.data.interview1, '2026/10/12(月) 14:00');
  ({ res, state } = run([{ postbackStep: 'interview2', datetime: '2026-10-12T14:00' }], state));
  assert.match(res.messages[0].text, /別の日時/);
});

test('確認画面から項目を修正すると、確認画面に戻る', () => {
  let { state } = run(FULL);
  let res;
  ({ res, state } = run(['修正する', '電話番号', '08011112222'], state));
  assert.strictEqual(state.step, 'confirm');
  assert.match(lastText(res), /電話番号：08011112222/);
  // 住所の修正は郵便番号→続きの住所の2問を経て戻る
  ({ res, state } = run(['修正する', '住所', '5300001', '4-5-6'], state));
  assert.strictEqual(state.step, 'confirm');
  assert.match(lastText(res), /梅田4-5-6/);
});

test('同意しない・やめる で中断できる', () => {
  assert.ok(run([...FULL.slice(0, 14), '同意しない']).res.cancelled);
  assert.ok(run(['山田 花子', 'やめる']).res.cancelled);
});

test('前の質問の日時ボタンを押しても今の質問を出し直すだけ', () => {
  const { res, state } = run(['山田 花子', 'やまだ はなこ', { postbackStep: 'birthDate', date: '2000-01-01' },
    { postbackStep: 'birthDate', date: '1999-01-01' }]);
  assert.strictEqual(state.step, 'gender');
  assert.strictEqual(state.data.birthDate, '2000-01-01');
  assert.match(lastText(res), /性別/);
});

test('同意画面に個人情報の取り扱いページのURLを表示する', () => {
  const { res } = run(FULL.slice(0, 14));
  assert.match(lastText(res), /https:\/\/example\.com\/privacy\.html/);
  assert.deepStrictEqual(quickLabels(res), ['同意する', '同意しない']);
});

test('ボタンの文字数と個数が LINE の上限内', () => {
  const all = [];
  for (const step of Object.keys(ctx.CHAT_STEPS)) {
    const state = run(FULL).state;
    state.step = step;
    for (const m of ctx.chatPrompt_(state, TODAY)) {
      const items = (m.quickReply && m.quickReply.items) || [];
      assert.ok(items.length <= 13, step);
      items.forEach((i) => all.push(i.action.label));
      assert.ok(m.text.length <= 5000, step);
    }
  }
  all.forEach((l) => assert.ok(l.length <= 20, l));
});
