/* スタッフ登録フォーム（主に登録内容の変更用。新規登録は LINE のトークで行う） */
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
      if (res.registration) {
        isEdit = true;
        App.fill(form, res.registration);
        // 登録時に同意済み
        App.$all('input[data-consent]', form).forEach(function (el) { el.checked = true; });
        App.$('#edit-notice').hidden = false;
        App.$('#new-notice').hidden = true;
        submit.textContent = '更新する';
      }
      setupInterview();
      App.show('screen-form');
    })
    .catch(function (err) { App.fatal(err.message); });

  /** 面接の希望日時は新規登録のときだけ聞く（変更時は担当者と調整済みのため） */
  function setupInterview() {
    var section = App.$('#interview-section');
    section.hidden = isEdit;
    var t = new Date();
    var pad = function (n) { return (n < 10 ? '0' : '') + n; };
    var day = function (d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
    var min = day(new Date(t.getFullYear(), t.getMonth(), t.getDate() + 1)) + 'T00:00';
    var max = day(new Date(t.getFullYear(), t.getMonth(), t.getDate() + 90)) + 'T23:59';
    App.$all('input', section).forEach(function (input) {
      input.disabled = isEdit;
      input.min = min;
      input.max = max;
    });
  }

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
