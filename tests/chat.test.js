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

test('お名前を答えるとフォームのボタンが届く', () => {
  const res = answer(ctx.chatNewState_(), '山田　花子');
  assert.strictEqual(res.state.step, 'form');
  assert.strictEqual(res.state.data.lastName, '山田');
  assert.strictEqual(res.state.data.firstName, '花子');
  const m = res.messages[0];
  assert.strictEqual(m.type, 'template');
  assert.match(m.template.text, /山田 花子 さん/);
  assert.ok(m.template.text.length <= 160);
  assert.strictEqual(m.template.actions[0].uri, 'https://liff.line.me/2011864173-MxilvLoL');
  assert.ok(m.template.actions[0].label.length <= 20);
});

test('スペースがない・長すぎる名前は聞き直す', () => {
  let res = answer(ctx.chatNewState_(), '山田花子');
  assert.strictEqual(res.state.step, 'name');
  assert.match(res.messages[0].text, /スペース/);
  assert.match(res.messages[1].text, /お名前/);
  res = answer(ctx.chatNewState_(), 'あ'.repeat(21) + ' 花子');
  assert.strictEqual(res.state.step, 'name');
  assert.match(res.messages[0].text, /20文字/);
});

test('フォーム入力待ちのときはボタンを送り直す', () => {
  const state = answer(ctx.chatNewState_(), '山田 花子').state;
  const res = answer(state, '登録');
  assert.strictEqual(res.state.step, 'form');
  assert.strictEqual(res.messages[0].type, 'template');
});

test('「やめる」で中断できる', () => {
  assert.ok(answer(ctx.chatNewState_(), 'やめる').cancelled);
  const state = answer(ctx.chatNewState_(), '山田 花子').state;
  assert.ok(answer(state, 'やめる').cancelled);
});
