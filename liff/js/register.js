/* スタッフ登録フォーム（新規登録と登録内容の変更。新規登録ではトークで答えたお名前が入る） */
(function () {
  'use strict';

  var form = App.$('#screen-form');
  var submit = App.$('#submit-button');
  var isEdit = false;
  var ready = false;   // LINEログインと登録状況の読み込みが終わったか
  var touched = false; // 読み込み中に入力が始まったか

  // 選択肢はフォームに同梱（js/options.js）しているので、サーバーの応答を待たずにすぐ表示する
  App.renderOptions(form, window.FORM_OPTIONS);
  setupInterview();
  App.show('screen-form');
  form.addEventListener('input', function () { touched = true; });
  form.addEventListener('change', function () { touched = true; });

  // 入力途中の内容を端末に一時保存し、通信エラーや画面を閉じたときに消えないようにする
  var DRAFT_KEY = 'sevenhearts_register_draft';
  restoreDraft();
  form.addEventListener('input', saveDraft);
  form.addEventListener('change', saveDraft);

  // LINEログインと登録状況の取得は裏で行う。失敗してもフォームは消さず、再読み込みのボタンを出す
  var initPromise = null;
  function load() {
    App.$('#load-error').hidden = true;
    App.busy(submit, true, '読み込み中…');
    initPromise = initPromise || App.init();
    initPromise
      .then(function () { return App.api('me'); })
      .then(function (res) {
        if (!res.ok) throw new Error(res.error);
        if (res.privacyPolicyUrl) App.$('#privacy-link').href = res.privacyPolicyUrl;
        if (res.registration) {
          isEdit = true;
          // 読み込み中にすでに入力を始めていたら、入力済みの欄は上書きしない
          fill(res.registration, touched);
          // 登録時に同意済み
          App.$all('input[data-consent]', form).forEach(function (el) { el.checked = true; });
          App.$('#edit-notice').hidden = false;
          App.$('#new-notice').hidden = true;
          setupInterview();
        } else if (res.draft) {
          fill(res.draft, true); // トークで答えたお名前（空欄のときだけ入れる）
        }
        ready = true;
        App.busy(submit, false);
        submit.textContent = isEdit ? '更新する' : '登録する';
      })
      .catch(function (err) {
        initPromise = null;
        App.$('#load-error-message').textContent = (err && err.message) || '通信に失敗しました。';
        App.$('#load-error').hidden = false;
        App.busy(submit, false);
        submit.textContent = '読み込みに失敗しました（上のボタンで再読み込み）';
        submit.disabled = true;
        App.$('#load-error').scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
  }
  App.$('#retry-button').addEventListener('click', load);
  load();

  function saveDraft() {
    try {
      var data = App.collect(form);
      Object.keys(data).forEach(function (k) {
        if (Array.isArray(data[k])) data[k] = data[k].join('、');
        if (typeof data[k] === 'boolean') delete data[k]; // 同意欄は保存しない
      });
      localStorage.setItem(DRAFT_KEY, JSON.stringify(data));
    } catch (e) { /* 保存できない環境では何もしない */ }
  }

  function restoreDraft() {
    try {
      var data = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null');
      if (data) App.fill(form, data);
    } catch (e) { /* 読めなければ何もしない */ }
  }

  function clearDraft() {
    try { localStorage.removeItem(DRAFT_KEY); } catch (e) { /* 何もしない */ }
  }

  /** onlyEmpty なら、まだ入力されていない欄だけに入れる */
  function fill(data, onlyEmpty) {
    if (!onlyEmpty) return App.fill(form, data);
    var empty = {};
    Object.keys(data).forEach(function (name) {
      var els = App.$all('[name="' + name + '"]', form);
      var filled = els.some(function (el) {
        return (el.type === 'checkbox' || el.type === 'radio') ? el.checked : el.value !== '';
      });
      if (!filled) empty[name] = data[name];
    });
    App.fill(form, empty);
  }

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
    if (!ready) return;
    if (!App.validate(form)) return;
    App.busy(submit, true);
    App.api('register', App.collect(form))
      .then(function (res) {
        if (res.errors) return App.showErrors(form, res.errors);
        if (!res.ok) throw new Error(res.error);
        clearDraft();
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
