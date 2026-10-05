/* 書類提出フォーム（採用後） */
(function () {
  'use strict';

  var form = App.$('#screen-form');
  var submit = App.$('#submit-button');
  var images = {}; // data-image のキー → 縮小済みデータURL
  var options = null;

  var ALLOWED_STATUSES = ['採用', '書類依頼済', '書類提出済'];
  var PERMISSION_REQUIRED = ['留学', '家族滞在'];
  var MY_NUMBER_CARD = 'マイナンバーカード（表面のみ）';

  App.init()
    .then(function () { return App.api('me'); })
    .then(function (res) {
      if (!res.ok) throw new Error(res.error);
      if (!res.registration) throw new Error('先にスタッフ登録を行ってください。トーク画面で「登録」と送信すると登録フォームが開きます。');
      if (ALLOWED_STATUSES.indexOf(res.status) < 0) throw new Error('書類のご提出は、採用のご連絡後にご案内します。');
      options = res.options;
      App.renderOptions(form, options);
      App.$('#minor-notice').hidden = !res.ageNote;
      toggleSections();
      App.show('screen-form');
    })
    .catch(function (err) { App.fatal(err.message); });

  function checked(name) {
    var el = App.$('input[name="' + name + '"]:checked', form);
    return el ? el.value : '';
  }

  /** 入力内容に応じて、必要な項目だけを表示する（非表示の項目は送信しない） */
  function toggleSections() {
    var nationality = checked('nationality');
    setSection('#japanese-section', nationality === '日本');
    setSection('#foreign-section', nationality === '日本以外');

    var status = App.$('#residenceStatus').value;
    setSection('#permission-field', nationality === '日本以外' && PERMISSION_REQUIRED.indexOf(status) >= 0);

    var isMyNumber = App.$('#idType').value === MY_NUMBER_CARD;
    setSection('#idBack-field', nationality === '日本' && !isMyNumber);
    App.$('#mynumber-hint').hidden = !isMyNumber;

    setSection('#tax-field', checked('otherJob') === 'あり');
  }

  function setSection(sel, visible) {
    var el = App.$(sel);
    el.hidden = !visible;
    App.$all('input, select, textarea', el).forEach(function (input) {
      // 非表示の項目は disabled にして送信対象から外す（裏面の消し忘れなども防ぐ）
      input.disabled = !visible;
    });
  }

  form.addEventListener('change', function (e) {
    if (e.target.type === 'file') return onFile(e.target);
    toggleSections();
  });

  function onFile(input) {
    var key = input.dataset.image;
    var preview = input.parentNode.querySelector('.preview');
    var file = input.files && input.files[0];
    delete images[key];
    preview.hidden = true;
    if (!file) return;
    App.resizeImage(file)
      .then(function (dataUrl) {
        images[key] = dataUrl;
        preview.src = dataUrl;
        preview.hidden = false;
      })
      .catch(function (err) {
        input.value = '';
        alert(err.message);
      });
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    if (!App.validate(form)) return;

    var data = App.collect(form);
    App.$all('input[type="file"]', form).forEach(function (input) {
      if (!input.disabled && images[input.dataset.image]) data[input.dataset.image] = images[input.dataset.image];
    });

    App.busy(submit, true, '送信中…（画像があるため少し時間がかかります）');
    App.api('onboarding', data)
      .then(function (res) {
        if (res.errors) return App.showErrors(form, res.errors);
        if (!res.ok) throw new Error(res.error);
        App.show('screen-done');
      })
      .catch(function (err) { alert(err.message || '送信に失敗しました。通信環境の良い場所で再度お試しください。'); })
      .then(function () { App.busy(submit, false); });
  });

  App.$('#close-button').addEventListener('click', App.close);
})();
