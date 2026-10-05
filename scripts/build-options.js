// gas/Options.gs の選択肢から liff/js/options.js を作る: npm run build:options
// フォームを開いたらすぐ表示できるよう、選択肢はフォーム側にも持たせている（中身は Options.gs と同じ）。
// Options.gs を変えたら必ずこのスクリプトを実行する（ずれていると npm test が失敗する）。
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadOptions() {
  const ctx = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'gas', 'Options.gs'), 'utf8'), ctx);
  return JSON.parse(JSON.stringify(ctx.OPTIONS));
}

function render(options) {
  return '// 自動生成ファイル（編集しないでください）。元は gas/Options.gs：npm run build:options で更新\n' +
    'window.FORM_OPTIONS = ' + JSON.stringify(options, null, 2) + ';\n';
}

const OUT = path.join(__dirname, '..', 'liff', 'js', 'options.js');

if (require.main === module) {
  fs.writeFileSync(OUT, render(loadOptions()));
  console.log('wrote ' + path.relative(process.cwd(), OUT));
}

module.exports = { loadOptions, render, OUT };
