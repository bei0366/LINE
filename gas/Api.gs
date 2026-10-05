/**
 * LIFF フォームから呼ばれる API。
 * リクエスト: { action, idToken, data }
 */

/** 登録フォームに再表示してよい項目（本人が入力したもののみ） */
var REG_EDITABLE_KEYS = [
  'lastName', 'firstName', 'lastNameKana', 'firstNameKana', 'birthDate', 'gender',
  'phone', 'email', 'postalCode', 'prefecture', 'city', 'building', 'nearestStation',
  'occupation', 'weekdays', 'timeSlots', 'areas', 'experiences', 'licenses', 'languages',
  'height', 'clothingSize', 'shoeSize', 'hairColor', 'tattoo', 'note'
];

var IMAGE_LABELS = {
  residenceCardFront: '在留カード_表',
  residenceCardBack: '在留カード_裏',
  idFront: '本人確認書類_表',
  idBack: '本人確認書類_裏',
  facePhoto: '顔写真'
};

function handleApi_(body) {
  try {
    var userId = verifyIdToken_(body.idToken);
    var data = body.data || {};
    switch (body.action) {
      case 'me': return apiMe_(userId);
      case 'register': return apiRegister_(userId, data);
      case 'onboarding': return apiOnboarding_(userId, data);
    }
    return { ok: false, error: '不明な操作です' };
  } catch (err) {
    if (err instanceof ValidationError) return { ok: false, errors: err.errors };
    if (err instanceof UserError) return { ok: false, error: err.message };
    console.error('api failed', err && err.stack || err);
    return { ok: false, error: '処理中にエラーが発生しました。時間をおいて再度お試しください。' };
  }
}

/** フォームの初期表示用：選択肢と、登録済みなら入力内容 */
function apiMe_(userId) {
  var rec = readRecord_(REG_SHEET, userId);
  var registration = null;
  if (rec) {
    registration = {};
    REG_EDITABLE_KEYS.forEach(function (k) {
      var v = rec[k];
      registration[k] = typeof v === 'string' && v.charAt(0) === "'" ? v.slice(1) : v;
    });
  }
  return {
    ok: true,
    options: OPTIONS,
    privacyPolicyUrl: getConfig_().privacyPolicyUrl,
    status: rec ? rec.status : null,
    ageNote: rec ? rec.ageNote : '',
    registration: registration
  };
}

function apiRegister_(userId, data) {
  var record = validateRegistration(data);
  var existing = readRecord_(REG_SHEET, userId);
  var now = now_();

  record.updatedAt = now;
  record.privacyConsentAt = now;
  record.antisocialConsentAt = now;
  if (!existing) {
    record.status = STATUS.PRE;
    record.registeredAt = now;
    var profile = getLineProfile_(userId);
    record.lineName = profile ? profile.displayName : '';
  }
  writeRecord_(REG_SHEET, userId, record);

  var name = record.lastName + ' ' + record.firstName;
  if (!existing) {
    pushMessage_(userId, [textMessage_(name + ' さん\n\nスタッフ登録ありがとうございます！\n' +
      '内容を確認のうえ、担当者からご連絡します。\n\n登録内容の変更は「変更」と送信してください。')]);
    notifyAdmin_('新規スタッフ登録', name);
  }
  return { ok: true, isNew: !existing };
}

function apiOnboarding_(userId, data) {
  var reg = readRecord_(REG_SHEET, userId);
  if (!reg) throw new UserError('先にスタッフ登録を行ってください。');
  if (ONBOARDING_ALLOWED.indexOf(reg.status) < 0) {
    throw new UserError('書類のご提出は、採用のご連絡後にご案内します。');
  }

  var result = validateOnboarding(data);
  var record = result.record;
  var name = reg.lastName + ' ' + reg.firstName;

  // 今回の提出に含まれない書類の列は空にする（国籍の変更などで古い画像が残らないように）
  Object.keys(IMAGE_LABELS).forEach(function (key) { record[key] = ''; });
  var folder = userFolder_(userId, name);
  var stamp = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyyMMdd_HHmmss');
  Object.keys(result.images).forEach(function (key) {
    record[key] = saveImage_(folder, IMAGE_LABELS[key] + '_' + stamp, result.images[key]);
  });

  var existing = readRecord_(ONB_SHEET, userId);
  var now = now_();
  record.name = name;
  record.updatedAt = now;
  record.confidentialityConsentAt = now;
  if (!existing) record.submittedAt = now;
  writeRecord_(ONB_SHEET, userId, record);
  setStatus_(userId, STATUS.DOC_SUBMITTED);

  pushMessage_(userId, [textMessage_(name + ' さん\n\n書類のご提出ありがとうございました。\n' +
    '内容を確認し、お仕事のご案内ができるようになりましたらご連絡します。')]);
  notifyAdmin_('書類提出', name);
  return { ok: true };
}

/** スタッフごとのフォルダ（共有設定は親フォルダを引き継ぐ。親フォルダは共有しないこと） */
function userFolder_(userId, name) {
  var parent = DriveApp.getFolderById(getConfig_().driveFolderId);
  var folderName = name + '_' + userId.slice(-8);
  var it = parent.getFoldersByName(folderName);
  return it.hasNext() ? it.next() : parent.createFolder(folderName);
}

function saveImage_(folder, name, dataUrl) {
  var m = /^data:(image\/(jpeg|png));base64,(.+)$/.exec(dataUrl);
  var blob = Utilities.newBlob(Utilities.base64Decode(m[3]), m[1], name + (m[2] === 'png' ? '.png' : '.jpg'));
  return folder.createFile(blob).getUrl();
}
