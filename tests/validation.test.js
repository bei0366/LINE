// Apps Script の入力チェック（gas/Validation.gs）を Node で検証する: node --test tests/
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ctx = vm.createContext({});
for (const f of ['Options.gs', 'Validation.gs']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'gas', f), 'utf8'), ctx, { filename: f });
}
const { validateRegistration, validateOnboarding } = ctx;

const TODAY = new Date(2026, 9, 5); // 2026-10-05

function reg(overrides) {
  return Object.assign({
    lastName: '山田', firstName: '花子', lastNameKana: 'やまだ', firstNameKana: 'ﾊﾅｺ',
    birthDate: '2000-04-01', gender: '女性',
    phone: '090-1234-5678', email: 'ｈａｎａｋｏ@example.com',
    postalCode: '150-0043', prefecture: '東京都', city: '渋谷区道玄坂1-2-3', building: '',
    nearestStation: '渋谷駅', occupation: 'フリーター',
    weekdays: ['日', '土'], timeSlots: ['日中（9〜17時）'], areas: ['東京23区'],
    experiences: ['受付・案内'], licenses: [], languages: [],
    height: '160', clothingSize: 'M', shoeSize: '23.5', hairColor: '黒・暗めの茶', tattoo: 'いいえ',
    note: '', privacyConsent: true, antisocialConsent: true
  }, overrides);
}

function errorsOf(fn) {
  try {
    fn();
  } catch (e) {
    if (e.name === 'ValidationError') return e.errors;
    throw e;
  }
  return {};
}

const IMG = 'data:image/jpeg;base64,/9j/AAAA';

function onb(overrides) {
  return Object.assign({
    nationality: '日本', idType: '運転免許証', idFront: IMG, facePhoto: IMG,
    bankName: '三井住友銀行', branchName: '渋谷支店', accountType: '普通', accountNumber: '12345',
    accountHolder: 'やまだ はなこ', emergencyName: '山田太郎', emergencyRelation: '父',
    emergencyPhone: '0312345678', otherJob: 'なし', health: '', confidentialityConsent: true
  }, overrides);
}

test('正常な登録データを整形する', () => {
  const r = validateRegistration(reg(), TODAY);
  assert.strictEqual(r.lastNameKana, 'ヤマダ');
  assert.strictEqual(r.firstNameKana, 'ハナコ');
  assert.strictEqual(r.phone, '09012345678');
  assert.strictEqual(r.postalCode, '1500043');
  assert.strictEqual(r.email, 'hanako@example.com');
  assert.strictEqual(r.weekdays, '土、日'); // 選択肢の順にそろう
  assert.strictEqual(r.licenses, '');
  assert.strictEqual(r.height, 160);
  assert.strictEqual(r.shoeSize, 23.5);
  assert.strictEqual(r.age, 26);
  assert.strictEqual(r.ageNote, '');
});

test('必須項目・同意の不足を検出する', () => {
  const e = errorsOf(() => validateRegistration(reg({ lastName: ' ', weekdays: [], privacyConsent: false }), TODAY));
  assert.ok(e.lastName && e.weekdays && e.privacyConsent);
});

test('選択肢にない値や不正な形式を拒否する', () => {
  const e = errorsOf(() => validateRegistration(reg({
    gender: '不明', areas: ['火星'], phone: '12345', lastNameKana: 'Yamada', shoeSize: '23.3'
  }), TODAY));
  assert.ok(e.gender && e.areas && e.phone && e.lastNameKana && e.shoeSize);
});

test('18歳未満は注意書きを付け、深夜帯を拒否する', () => {
  const r = validateRegistration(reg({ birthDate: '2009-01-01' }), TODAY);
  assert.strictEqual(r.age, 17);
  assert.match(r.ageNote, /18歳未満/);
  const e = errorsOf(() => validateRegistration(reg({ birthDate: '2009-01-01', timeSlots: ['深夜（22〜5時）'] }), TODAY));
  assert.ok(e.timeSlots);
});

test('中学校卒業前（15歳到達後最初の3月31日まで）は登録できない', () => {
  // 2011-04-02 生まれ：2026-04-01 に15歳到達 → 2027-03-31 まで不可
  assert.ok(errorsOf(() => validateRegistration(reg({ birthDate: '2011-04-02' }), TODAY)).birthDate);
  // 2011-04-01 生まれ：2026-03-31 に15歳到達 → 2026-04-01 から可
  assert.deepStrictEqual(errorsOf(() => validateRegistration(reg({ birthDate: '2011-04-01' }), TODAY)), {});
  assert.ok(errorsOf(() => validateRegistration(reg({ birthDate: '2011-04-01' }), new Date(2026, 2, 31))).birthDate);
});

test('存在しない日付を拒否する', () => {
  assert.ok(errorsOf(() => validateRegistration(reg({ birthDate: '2001-02-30' }), TODAY)).birthDate);
});

test('書類提出：口座番号を7桁にそろえ、名義をカタカナにする', () => {
  const { record, images } = validateOnboarding(onb(), TODAY);
  assert.strictEqual(record.accountNumber, '0012345');
  assert.strictEqual(record.accountHolder, 'ヤマダ ハナコ');
  assert.deepStrictEqual(Object.keys(images).sort(), ['facePhoto', 'idFront']);
});

test('書類提出：マイナンバーカードの裏面は受け取らない', () => {
  const { images } = validateOnboarding(onb({ idType: 'マイナンバーカード（表面のみ）', idBack: IMG }), TODAY);
  assert.strictEqual(images.idBack, undefined);
});

test('書類提出：留学で資格外活動許可がない場合は拒否する', () => {
  const base = {
    nationality: '日本以外', residenceStatus: '留学', residenceExpiry: '2027-03-31',
    residenceCardFront: IMG, residenceCardBack: IMG
  };
  assert.ok(errorsOf(() => validateOnboarding(onb(Object.assign({}, base, { workPermission: 'いいえ' })), TODAY)).workPermission);
  const { record } = validateOnboarding(onb(Object.assign({}, base, { workPermission: 'はい' })), TODAY);
  assert.match(record.workCheck, /28時間/);
});

test('書類提出：在留カードの期限切れ・画像不足を拒否する', () => {
  const e = errorsOf(() => validateOnboarding(onb({
    nationality: '日本以外', residenceStatus: '永住者', residenceExpiry: '2026-01-01', residenceCardFront: IMG
  }), TODAY));
  assert.ok(e.residenceExpiry && e.residenceCardBack);
});

test('書類提出：画像以外のデータを拒否する', () => {
  assert.ok(errorsOf(() => validateOnboarding(onb({ facePhoto: 'data:text/html;base64,PHNjcmlwdD4=' }), TODAY)).facePhoto);
});

test('書類提出：他社勤務ありなら申告書の提出状況が必須', () => {
  assert.ok(errorsOf(() => validateOnboarding(onb({ otherJob: 'あり' }), TODAY)).taxDeclarationElsewhere);
});
