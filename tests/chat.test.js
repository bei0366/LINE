// 友だち追加後のトークでのやりとり（gas/Chat.gs）を Node で検証する: npm test
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ctx = vm.createContext({});
for (const f of ['Options.gs', 'Validation.gs', 'Line.gs', 'Chat.gs']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'gas', f), 'utf8'), ctx, { filename: f });
}
vm.runInContext("getConfig_ = function () { return { liffId: '2011864173-MxilvLoL' }; };", ctx);

const answer = (state, text) => ctx.chatAnswer_(state, { text });

function run(texts) {
  let state = ctx.chatNewState_();
  let res;
  for (const t of texts) {
    res = answer(state, t);
    if (res.cancelled) break;
    state = res.state;
  }
  return { res, state };
}

test('最初の質問は姓', () => {
  const m = ctx.chatPrompt_(ctx.chatNewState_());
  assert.match(m[0].text, /「姓」/);
});

test('姓→名の順に聞き、答えるとフォームのボタンが届く', () => {
  let { res, state } = run(['山田']);
  assert.strictEqual(state.step, 'firstName');
  assert.match(res.messages[0].text, /「名」/);

  ({ res, state } = run(['山田', '花子']));
  assert.strictEqual(state.step, 'form');
  assert.strictEqual(state.data.lastName, '山田');
  assert.strictEqual(state.data.firstName, '花子');
  const m = res.messages[0];
  assert.strictEqual(m.type, 'template');
  assert.match(m.template.text, /山田 花子 さん/);
  assert.ok(m.template.text.length <= 160);
  assert.strictEqual(m.template.actions[0].uri, 'https://liff.line.me/2011864173-MxilvLoL');
  assert.ok(m.template.actions[0].label.length <= 20);
});

test('姓の質問にフルネームが送られたら姓と名に分ける', () => {
  const { state } = run(['山田　花子']);
  assert.strictEqual(state.step, 'form');
  assert.strictEqual(state.data.lastName, '山田');
  assert.strictEqual(state.data.firstName, '花子');
});

test('空・長すぎる回答は聞き直す', () => {
  let { res, state } = run(['山田', ' ']);
  assert.strictEqual(state.step, 'firstName');
  assert.match(res.messages[0].text, /名を入力してください/);
  ({ res, state } = run(['あ'.repeat(21)]));
  assert.strictEqual(state.step, 'lastName');
  assert.match(res.messages[0].text, /姓を20文字以内/);
});

test('フォーム入力待ちのときはボタンを送り直す', () => {
  const { res, state } = run(['山田', '花子', '登録']);
  assert.strictEqual(state.step, 'form');
  assert.strictEqual(res.messages[0].type, 'template');
});

test('「やめる」で中断できる', () => {
  assert.ok(run(['やめる']).res.cancelled);
  assert.ok(run(['山田', 'やめる']).res.cancelled);
});
