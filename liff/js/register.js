/* スタッフ登録フォーム */
(function () {
  'use strict';

  var form = App.$('#screen-form');
  var submit = App.$('#submit-button');
  var isEdit = false;

  App.init()
    .then(function () { return App.api('me'); })
    .then(function (res) {
      if (!res.ok) throw new Error(res.error);
      App.renderOptions(form, res.options);
      if (res.privacyPolicyUrl) App.$('#privacy-link').href = res.privacyPolicyUrl;
      else App.$('#privacy-link').removeAttribute('href');
      if (res.registration) {
        isEdit = true;
        App.fill(form, res.registration);
        updateNightSlot();
        App.$('#edit-notice').hidden = false;
        App.$('#new-notice').hidden = true;
        submit.textContent = '更新する';
      }
      App.show('screen-form');
    })
    .catch(function (err) { App.fatal(err.message); });

  // 郵便番号 → 住所の自動入力（未入力の欄だけ埋める）
  App.$('#postalCode').addEventListener('input', function (e) {
    var zip = e.target.value.replace(/[０-９]/g, function (c) {
      return String.fromCharCode(c.charCodeAt(0) - 0xFEE0);
    }).replace(/\D/g, '');
    if (zip.length !== 7) return;
    App.lookupZip(zip).then(function (addr) {
      if (!addr) return;
      App.$('#prefecture').value = addr.address1;
      var city = App.$('#city');
      if (!city.value) city.value = addr.address2 + addr.address3;
    });
  });

  // 18歳未満は深夜帯を選べないことを入力時に知らせる
  App.$('#birthDate').addEventListener('change', updateNightSlot);
  form.addEventListener('change', function (e) { if (e.target.name === 'timeSlots') updateNightSlot(); });

  function ageOf(dateStr) {
    var b = new Date(dateStr + 'T00:00:00');
    if (isNaN(b)) return null;
    var t = new Date();
    var age = t.getFullYear() - b.getFullYear();
    if (t.getMonth() < b.getMonth() || (t.getMonth() === b.getMonth() && t.getDate() < b.getDate())) age--;
    return age;
  }

  function updateNightSlot() {
    var age = ageOf(App.$('#birthDate').value);
    var night = App.$all('input[name="timeSlots"]').filter(function (el) { return /深夜/.test(el.value); })[0];
    if (!night) return;
    var minor = age !== null && age < 18;
    night.disabled = minor;
    if (minor) night.checked = false;
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    if (!App.validate(form)) return;
    App.busy(submit, true);
    App.api('register', App.collect(form))
      .then(function (res) {
        if (res.errors) return App.showErrors(form, res.errors);
        if (!res.ok) throw new Error(res.error);
        if (isEdit) {
          App.$('#done-title').textContent = '登録内容を更新しました';
          App.$('#done-message').textContent = 'ご協力ありがとうございます。';
        }
        App.show('screen-done');
      })
      .catch(function (err) { alert(err.message || '送信に失敗しました。通信環境の良い場所で再度お試しください。'); })
      .then(function () { App.busy(submit, false); });
  });

  App.$('#close-button').addEventListener('click', App.close);
})();
