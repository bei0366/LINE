// フォーム側の選択肢（liff/js/options.js）が gas/Options.gs と同じか確認する
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { loadOptions, render, OUT } = require('../scripts/build-options.js');

test('liff/js/options.js が gas/Options.gs と一致している（違う場合は npm run build:options）', () => {
  assert.strictEqual(fs.readFileSync(OUT, 'utf8'), render(loadOptions()));
});
