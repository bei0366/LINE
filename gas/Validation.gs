/**
 * 入力値の検証と整形。
 * フォーム側でもチェックしていますが、改ざんされた送信を防ぐため、サーバー側でも必ず検証します。
 */

function ValidationError(errors) {
  this.name = 'ValidationError';
  this.errors = errors;
  this.message = Object.keys(errors).map(function (k) { return k + ': ' + errors[k]; }).join(', ');
}
ValidationError.prototype = Object.create(Error.prototype);

var LIST_SEPARATOR = '、';
var NIGHT_SLOT = '深夜（22〜5時）';
var MY_NUMBER_CARD = 'マイナンバーカード（表面のみ）';

/** 全角英数字・記号を半角に */
function toHalfWidth_(s) {
  return s.replace(/[！-～]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); })
    .replace(/　/g, ' ');
}

/** ひらがな・半角カナを全角カタカナに */
function toKatakana_(s) {
  s = s.normalize('NFKC');
  return s.replace(/[ぁ-ゖ]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) + 0x60); });
}

function pad2_(n) { return (n < 10 ? '0' : '') + n; }

function formatDate_(d) {
  return d.getFullYear() + '-' + pad2_(d.getMonth() + 1) + '-' + pad2_(d.getDate());
}

function startOfDay_(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }

function calcAge_(birth, today) {
  var age = today.getFullYear() - birth.getFullYear();
  if (today.getMonth() < birth.getMonth() ||
      (today.getMonth() === birth.getMonth() && today.getDate() < birth.getDate())) {
    age--;
  }
  return age;
}

/**
 * 「満15歳に達した日以後の最初の3月31日」を過ぎているか（労働基準法56条）。
 * 法律上の年齢は誕生日の前日に加算されるため、4月1日生まれは前年度の3月31日で15歳になる。
 */
function hasFinishedCompulsorySchool_(birth, today) {
  var reached15 = new Date(birth.getFullYear() + 15, birth.getMonth(), birth.getDate() - 1);
  var march31 = new Date(reached15.getFullYear(), 2, 31);
  if (reached15 > march31) march31 = new Date(reached15.getFullYear() + 1, 2, 31);
  return startOfDay_(today) > march31;
}

function Validator_(input) {
  this.input = input || {};
  this.errors = {};
}

Validator_.prototype.error = function (key, msg) {
  if (!this.errors[key]) this.errors[key] = msg;
};

Validator_.prototype.raw_ = function (key) {
  var v = this.input[key];
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return v;
  return String(v);
};

Validator_.prototype.text = function (key, opt) {
  opt = opt || {};
  var v = this.raw_(key);
  if (Array.isArray(v)) v = '';
  // 制御文字を除去（備考欄のみ改行を許可）
  v = opt.multiline
    ? v.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, '')
    : v.replace(/[\u0000-\u001F\u007F]/g, ' ');
  v = v.trim();
  if (!v) {
    if (!opt.optional) this.error(key, '入力してください');
    return '';
  }
  if (opt.max && v.length > opt.max) this.error(key, opt.max + '文字以内で入力してください');
  return v;
};

Validator_.prototype.kana = function (key, opt) {
  var v = this.text(key, opt);
  if (!v) return v;
  v = toKatakana_(v).replace(/\s+/g, ' ');
  var pattern = (opt && opt.allowSymbols) ? /^[ァ-ヶー ()（）.．\-‐・]+$/ : /^[ァ-ヶー ]+$/;
  if (!pattern.test(v)) this.error(key, 'カタカナで入力してください');
  return v;
};

Validator_.prototype.digits_ = function (key, opt) {
  var v = this.text(key, opt);
  return v ? toHalfWidth_(v).replace(/[\s\-‐ー－()]/g, '') : v;
};

Validator_.prototype.phone = function (key, opt) {
  var v = this.digits_(key, opt);
  if (v && !/^0\d{9,10}$/.test(v)) this.error(key, '電話番号を正しく入力してください（例：09012345678）');
  return v;
};

Validator_.prototype.postal = function (key) {
  var v = this.digits_(key);
  if (v && !/^\d{7}$/.test(v)) this.error(key, '郵便番号は7桁の数字で入力してください');
  return v;
};

Validator_.prototype.email = function (key) {
  var v = this.text(key, { max: 254 });
  if (v) v = toHalfWidth_(v);
  if (v && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) this.error(key, 'メールアドレスを正しく入力してください');
  return v;
};

/** YYYY-MM-DD を Date に。不正なら null */
Validator_.prototype.date = function (key) {
  var v = this.digits_(key);
  if (!v) return null;
  var m = /^(\d{4})\D?(\d{1,2})\D?(\d{1,2})$/.exec(v.replace(/\//g, '-'));
  var d = m && new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (!d || d.getMonth() !== Number(m[2]) - 1 || d.getDate() !== Number(m[3])) {
    this.error(key, '日付を正しく入力してください');
    return null;
  }
  return d;
};

Validator_.prototype.number = function (key, opt) {
  var v = this.digits_(key, opt);
  if (!v) return '';
  var n = Number(v);
  if (!isFinite(n) || n < opt.min || n > opt.max || (opt.step && Math.round(n / opt.step) * opt.step !== n)) {
    this.error(key, opt.min + '〜' + opt.max + 'の範囲で入力してください');
    return '';
  }
  return n;
};

Validator_.prototype.oneOf = function (key, list, opt) {
  var v = this.raw_(key);
  if (Array.isArray(v) || !v) {
    if (!(opt && opt.optional)) this.error(key, '選択してください');
    return '';
  }
  if (list.indexOf(v) < 0) {
    this.error(key, '選択肢から選んでください');
    return '';
  }
  return v;
};

/** 複数選択。シートには「、」区切りで保存する */
Validator_.prototype.manyOf = function (key, list, opt) {
  var v = this.raw_(key);
  if (!Array.isArray(v)) v = v ? [v] : [];
  var seen = {};
  v = v.filter(function (x) {
    if (seen[x]) return false;
    seen[x] = true;
    return true;
  });
  if (!v.length) {
    if (!(opt && opt.optional)) this.error(key, '1つ以上選択してください');
    return '';
  }
  for (var i = 0; i < v.length; i++) {
    if (list.indexOf(v[i]) < 0) {
      this.error(key, '選択肢から選んでください');
      return '';
    }
  }
  // 選択肢の並び順にそろえる
  return list.filter(function (x) { return seen[x]; }).join(LIST_SEPARATOR);
};

Validator_.prototype.consent = function (key) {
  var v = this.input[key];
  if (v !== true && v !== 'true' && v !== 'on') this.error(key, '同意が必要です');
};

Validator_.prototype.throwIfErrors = function () {
  if (Object.keys(this.errors).length) throw new ValidationError(this.errors);
};

/**
 * スタッフ登録フォーム（友だち追加直後）の検証。
 * @return {Object} シートに書き込む値
 */
function validateRegistration(input, today) {
  today = today || new Date();
  var v = new Validator_(input);
  var r = {};

  r.lastName = v.text('lastName', { max: 20 });
  r.firstName = v.text('firstName', { max: 20 });
  r.lastNameKana = v.kana('lastNameKana', { max: 30 });
  r.firstNameKana = v.kana('firstNameKana', { max: 30 });
  var birth = v.date('birthDate');
  if (!birth && !v.errors.birthDate) v.error('birthDate', '入力してください');
  r.gender = v.oneOf('gender', OPTIONS.gender);

  r.phone = v.phone('phone');
  r.email = v.email('email');
  r.postalCode = v.postal('postalCode');
  r.prefecture = v.oneOf('prefecture', OPTIONS.prefectures);
  r.city = v.text('city', { max: 100 });
  r.building = v.text('building', { max: 100, optional: true });
  r.nearestStation = v.text('nearestStation', { max: 50 });

  r.occupation = v.oneOf('occupation', OPTIONS.occupation);
  r.weekdays = v.manyOf('weekdays', OPTIONS.weekdays);
  r.timeSlots = v.manyOf('timeSlots', OPTIONS.timeSlots);
  r.areas = v.manyOf('areas', OPTIONS.areas);

  r.experiences = v.manyOf('experiences', OPTIONS.experiences);
  r.licenses = v.manyOf('licenses', OPTIONS.licenses, { optional: true });
  r.languages = v.manyOf('languages', OPTIONS.languages, { optional: true });

  r.height = v.number('height', { min: 100, max: 230, step: 1 });
  r.clothingSize = v.oneOf('clothingSize', OPTIONS.clothingSizes);
  r.shoeSize = v.number('shoeSize', { min: 18, max: 35, step: 0.5 });
  r.hairColor = v.oneOf('hairColor', OPTIONS.hairColors);
  r.tattoo = v.oneOf('tattoo', OPTIONS.yesNo);
  r.note = v.text('note', { max: 500, optional: true, multiline: true });

  v.consent('privacyConsent');
  v.consent('antisocialConsent');

  if (birth) {
    var age = calcAge_(birth, today);
    if (birth > today || age > 100) {
      v.error('birthDate', '生年月日を正しく入力してください');
    } else if (!hasFinishedCompulsorySchool_(birth, today)) {
      v.error('birthDate', '中学校卒業前の方はご登録いただけません');
    } else {
      r.birthDate = formatDate_(birth);
      r.age = age;
      r.ageNote = '';
      if (age < 18) {
        r.ageNote = '18歳未満：深夜（22〜5時）勤務不可・年齢証明書の備付が必要';
        if (r.timeSlots.split(LIST_SEPARATOR).indexOf(NIGHT_SLOT) >= 0) {
          v.error('timeSlots', '18歳未満の方は深夜（22〜5時）の勤務はできません');
        }
      }
    }
  }

  v.throwIfErrors();
  return r;
}

/**
 * 書類提出フォーム（採用後）の検証。画像はデータURLのまま images に分けて返す。
 * @return {{record: Object, images: Object}}
 */
function validateOnboarding(input, today) {
  today = today || new Date();
  var v = new Validator_(input);
  var r = {};
  var images = {};

  function image(key, optional) {
    var s = v.raw_(key);
    if (Array.isArray(s) || !s) {
      if (!optional) v.error(key, '画像を選択してください');
      return;
    }
    if (!/^data:image\/(jpeg|png);base64,[A-Za-z0-9+\/=]+$/.test(s) || s.length > 7000000) {
      v.error(key, '画像の形式が正しくありません。撮り直してください');
      return;
    }
    images[key] = s;
  }

  r.nationality = v.oneOf('nationality', OPTIONS.nationality);
  r.workCheck = '';

  if (r.nationality === '日本以外') {
    r.residenceStatus = v.oneOf('residenceStatus', OPTIONS.residenceStatus);
    var expiry = v.date('residenceExpiry');
    if (!expiry && !v.errors.residenceExpiry) v.error('residenceExpiry', '入力してください');
    if (expiry && expiry < startOfDay_(today)) v.error('residenceExpiry', '期限が切れています。更新後のカードをご用意ください');
    if (expiry) r.residenceExpiry = formatDate_(expiry);
    image('residenceCardFront');
    image('residenceCardBack');

    if (PERMISSION_REQUIRED_STATUSES.indexOf(r.residenceStatus) >= 0) {
      r.workPermission = v.oneOf('workPermission', OPTIONS.yesNo);
      if (r.workPermission === 'いいえ') {
        v.error('workPermission', '資格外活動許可がない場合、アルバイトはできません。入管で許可を取得してからご提出ください');
      }
      r.workCheck = '要確認：資格外活動許可（裏面）・週28時間以内';
    } else if (r.residenceStatus && UNRESTRICTED_STATUSES.indexOf(r.residenceStatus) < 0) {
      r.workCheck = '要確認：就労可否（指定書・資格外活動許可）';
    }
  } else if (r.nationality === '日本') {
    r.idType = v.oneOf('idType', OPTIONS.idTypes);
    image('idFront');
    // マイナンバーカードの裏面には個人番号が載っているため受け取らない
    if (r.idType !== MY_NUMBER_CARD) image('idBack', true);
  }

  image('facePhoto');

  r.bankName = v.text('bankName', { max: 40 });
  r.branchName = v.text('branchName', { max: 40 });
  r.accountType = v.oneOf('accountType', OPTIONS.accountTypes);
  var account = v.digits_('accountNumber');
  if (account && !/^\d{1,7}$/.test(account)) v.error('accountNumber', '口座番号は7桁以内の数字で入力してください');
  r.accountNumber = account ? ('0000000' + account).slice(-7) : '';
  r.accountHolder = v.kana('accountHolder', { max: 50, allowSymbols: true });

  r.emergencyName = v.text('emergencyName', { max: 40 });
  r.emergencyRelation = v.oneOf('emergencyRelation', OPTIONS.relations);
  r.emergencyPhone = v.phone('emergencyPhone');

  r.otherJob = v.oneOf('otherJob', OPTIONS.otherJob);
  r.taxDeclarationElsewhere = r.otherJob === 'あり'
    ? v.oneOf('taxDeclarationElsewhere', OPTIONS.taxDeclarationElsewhere)
    : '';

  r.health = v.text('health', { max: 300, optional: true, multiline: true });
  v.consent('confidentialityConsent');

  v.throwIfErrors();
  return { record: r, images: images };
}
