/* 登録フォーム・書類提出フォーム共通の処理 */
(function () {
  'use strict';

  var idToken = null;

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function show(id) {
    $all('[data-screen]').forEach(function (el) { el.hidden = el.id !== id; });
    window.scrollTo(0, 0);
  }

  function fatal(message) {
    $('#error-message').textContent = message;
    show('screen-error');
  }

  /** LIFF の初期化。LINE 外のブラウザで開かれた場合はログイン画面へ */
  function init() {
    if (!window.liff) return Promise.reject(new Error('LINEアプリから開いてください。'));
    return liff.init({ liffId: window.APP_CONFIG.LIFF_ID }).then(function () {
      if (!liff.isLoggedIn()) {
        liff.login({ redirectUri: location.href });
        return new Promise(function () {}); // リダイレクト待ち
      }
      idToken = liff.getIDToken();
      if (!idToken) throw new Error('LINEのログイン情報を取得できませんでした。');
    });
  }

  /**
   * Apps Script の API を呼ぶ。Content-Type を付けない（text/plain）ことで
   * CORS のプリフライトを発生させずに送信できる。
   */
  // 一時的な失敗（電波の途切れ、Google側の一時的なエラー）は、間を空けて自動でやり直す
  var RETRY_DELAYS = [1500, 4000];
  var RETRY_STATUSES = [404, 408, 429, 500, 502, 503, 504];
  var RELOGIN_KEY = 'sevenhearts_relogin_at';

  function wait(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }

  function httpError(status) {
    var err = new Error(status === 404
      ? '現在、受付システムに接続できません。お手数ですが、時間をおいてお試しください。\n（担当者の方へ：ウェブアプリのURLが見つかりません（404）。デプロイを確認してください）'
      : '通信エラーが発生しました（' + status + '）。時間をおいて、もう一度お試しください。');
    err.status = status;
    return err;
  }

  /** ログインの有効期限切れ：入力内容は端末に保存済みなので、LINEログインからやり直す（2分以内の繰り返しはしない） */
  function relogin(message) {
    var last = 0;
    try { last = Number(sessionStorage.getItem(RELOGIN_KEY)) || 0; } catch (e) { /* 何もしない */ }
    if (!window.liff || Date.now() - last < 120000) return Promise.reject(new Error(message));
    try { sessionStorage.setItem(RELOGIN_KEY, String(Date.now())); } catch (e) { /* 何もしない */ }
    alert('ログインの有効期限が切れたため、画面を読み込み直します。');
    if (liff.isLoggedIn()) liff.logout();
    liff.login({ redirectUri: location.href });
    return new Promise(function () {}); // ページの移動を待つ
  }

  function api(action, data) {
    var body = JSON.stringify({ action: action, idToken: idToken, data: data || {} });
    function attempt(i) {
      var retry = function (err) {
        if (i < RETRY_DELAYS.length) return wait(RETRY_DELAYS[i]).then(function () { return attempt(i + 1); });
        throw err;
      };
      return fetch(window.APP_CONFIG.GAS_URL, { method: 'POST', body: body })
        .then(function (res) {
          if (!res.ok) {
            var err = httpError(res.status);
            return RETRY_STATUSES.indexOf(res.status) >= 0 ? retry(err) : Promise.reject(err);
          }
          // Google のエラーページ（JSONでない応答）が返ることがあるので、その場合もやり直す
          return res.json().catch(function () {
            return retry(new Error('サーバーから正しい応答がありませんでした。時間をおいて、もう一度お試しください。'));
          });
        }, function () {
          return retry(new Error('通信に失敗しました。電波の良い場所で、もう一度お試しください。'));
        });
    }
    return attempt(0).then(function (res) {
      if (res && res.code === 'login') return relogin(res.error);
      return res;
    });
  }

  /** data-options="キー" を持つ要素に選択肢を描画する */
  function renderOptions(root, options) {
    $all('select[data-options]', root).forEach(function (select) {
      (options[select.dataset.options] || []).forEach(function (v) {
        var o = document.createElement('option');
        o.value = v;
        o.textContent = v;
        select.appendChild(o);
      });
    });
    $all('.choices[data-options]', root).forEach(function (box) {
      var type = box.dataset.type || 'checkbox';
      (options[box.dataset.options] || []).forEach(function (v) {
        var label = document.createElement('label');
        label.className = 'choice';
        var input = document.createElement('input');
        input.type = type;
        input.name = box.dataset.name;
        input.value = v;
        if (type === 'radio' && box.dataset.required !== undefined) input.required = true;
        var span = document.createElement('span');
        span.textContent = v;
        label.appendChild(input);
        label.appendChild(span);
        box.appendChild(label);
      });
    });
  }

  /** フォームの値をオブジェクトに。チェックボックスは配列、同意欄は true/false */
  function collect(form) {
    var data = {};
    $all('input, select, textarea', form).forEach(function (el) {
      if (!el.name || el.type === 'file' || el.disabled) return;
      if (el.type === 'checkbox') {
        if (el.dataset.consent !== undefined) {
          data[el.name] = el.checked;
          return;
        }
        if (!data[el.name]) data[el.name] = [];
        if (el.checked) data[el.name].push(el.value);
      } else if (el.type === 'radio') {
        if (el.checked) data[el.name] = el.value;
      } else {
        data[el.name] = el.value.trim();
      }
    });
    return data;
  }

  /** 保存済みの値をフォームに反映（複数選択は「、」区切りで保存されている） */
  function fill(form, data) {
    Object.keys(data || {}).forEach(function (name) {
      var value = data[name] === null || data[name] === undefined ? '' : String(data[name]);
      $all('[name="' + name + '"]', form).forEach(function (el) {
        if (el.type === 'checkbox') el.checked = value.split('、').indexOf(el.value) >= 0;
        else if (el.type === 'radio') el.checked = el.value === value;
        else el.value = value;
      });
    });
  }

  function clearErrors(form) {
    $all('.field-error', form).forEach(function (el) { el.remove(); });
    $all('.has-error', form).forEach(function (el) { el.classList.remove('has-error'); });
  }

  /** errors: { 項目名: メッセージ } を各項目の下に表示し、最初のエラーへスクロール */
  function showErrors(form, errors) {
    clearErrors(form);
    var first = null;
    var unknown = [];
    Object.keys(errors).forEach(function (name) {
      var field = $('[data-field="' + name + '"]', form);
      if (!field) {
        var input = $('[name="' + name + '"]', form);
        field = input && input.closest('.field');
      }
      if (!field) {
        unknown.push(name);
        return;
      }
      field.classList.add('has-error');
      var p = document.createElement('p');
      p.className = 'field-error';
      p.textContent = errors[name];
      field.appendChild(p);
      if (!first) first = field;
    });
    // フォームにない項目のエラー＝サーバー（Apps Script）が古い版のまま。応募者には直せないので、その旨を出す
    if (unknown.length) {
      alert('送信できませんでした。システムの更新中の可能性があります。\n' +
        'お手数ですが、時間をおいてお試しいただくか、トークでお知らせください。\n\n' +
        '（担当者の方へ：Apps Script のデプロイが最新ではありません。対象：' + unknown.join(', ') + '）');
      return;
    }
    if (first) first.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  /** 必須の複数選択グループ（data-required を付けた .choices）をチェック */
  function checkRequiredGroups(form) {
    var errors = {};
    $all('.choices[data-required]', form).forEach(function (box) {
      if (box.closest('[hidden]')) return;
      if (!$all('input:checked', box).length) errors[box.dataset.name] = '選択してください';
    });
    return errors;
  }

  /** 端末の言語に関係なく日本語でエラーを出す */
  function messageFor(el) {
    if (el.dataset.message) return el.dataset.message;
    var v = el.validity;
    if (v.valueMissing) {
      if (el.type === 'file') return '画像を選択してください';
      return el.tagName === 'SELECT' || el.type === 'radio' ? '選択してください' : '入力してください';
    }
    if (v.typeMismatch && el.type === 'email') return 'メールアドレスを正しく入力してください';
    if (v.rangeUnderflow || v.rangeOverflow || v.stepMismatch) return el.min + '〜' + el.max + 'の範囲で入力してください';
    if (v.badInput) return '正しい値を入力してください';
    return '入力内容を確認してください';
  }

  /** 入力し直した項目のエラー表示を消す */
  document.addEventListener('change', clearFieldError);
  document.addEventListener('input', clearFieldError);
  function clearFieldError(e) {
    var field = e.target.closest && e.target.closest('.has-error');
    if (!field) return;
    field.classList.remove('has-error');
    $all('.field-error', field).forEach(function (el) { el.remove(); });
  }

  /** ブラウザ標準の入力チェック + グループの必須チェック。エラーがあれば表示して false */
  function validate(form) {
    var errors = checkRequiredGroups(form);
    $all('input, select, textarea', form).forEach(function (el) {
      if (el.closest('[hidden]') || el.disabled || !el.name) return;
      if (!el.checkValidity() && !errors[el.name]) errors[el.name] = messageFor(el);
    });
    if (Object.keys(errors).length) {
      showErrors(form, errors);
      return false;
    }
    clearErrors(form);
    return true;
  }

  /** zipcloud に直接問い合わせる（JSONP）。失敗・見つからないときは null */
  function zipcloudJsonp(zip) {
    return new Promise(function (resolve) {
      var cb = 'zip_cb_' + Date.now();
      var script = document.createElement('script');
      var timer = setTimeout(function () { done(null); }, 4000);
      function done(result) {
        clearTimeout(timer);
        window[cb] = function () {}; // 遅れて返ってきてもエラーにしない
        script.remove();
        var r = result && result.results && result.results[0];
        resolve(r ? { prefecture: r.address1, city: r.address2 + r.address3 } : null);
      }
      window[cb] = done;
      script.src = 'https://zipcloud.ibsnet.co.jp/api/search?zipcode=' + encodeURIComponent(zip) + '&callback=' + cb;
      script.onerror = function () { done(null); };
      document.head.appendChild(script);
    });
  }

  /**
   * 郵便番号から住所を調べる。{ prefecture, city } か、見つからなければ null。
   * LINEのアプリ内ブラウザなどで直接の問い合わせが通らないことがあるため、
   * 失敗したら Apps Script（Googleのサーバー）経由で調べ直す。
   */
  function lookupZip(zip) {
    return zipcloudJsonp(zip).then(function (addr) {
      if (addr) return addr;
      return api('zip', { zip: zip })
        .then(function (res) { return res && res.ok ? res.address : null; })
        .catch(function () { return null; });
    });
  }

  /** 画像を長辺 1280px の JPEG に縮小してデータURLにする（送信サイズ削減。文字が読める大きさは保つ） */
  function resizeImage(file, maxSize) {
    maxSize = maxSize || 1280;
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        var scale = Math.min(1, maxSize / Math.max(img.width, img.height));
        var canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        URL.revokeObjectURL(url);
        resolve(canvas.toDataURL('image/jpeg', 0.8));
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error('画像を読み込めませんでした。別の画像を選んでください。'));
      };
      img.src = url;
    });
  }

  /** 送信ボタンの二重押し防止 */
  function busy(button, isBusy, label) {
    button.disabled = isBusy;
    if (isBusy) {
      button.dataset.label = button.textContent;
      button.textContent = label || '送信中…';
    } else if (button.dataset.label) {
      button.textContent = button.dataset.label;
    }
  }

  function close() {
    if (window.liff && liff.isInClient()) liff.closeWindow();
  }

  window.App = {
    $: $, $all: $all, show: show, fatal: fatal, init: init, api: api,
    renderOptions: renderOptions, collect: collect, fill: fill,
    validate: validate, showErrors: showErrors, lookupZip: lookupZip,
    resizeImage: resizeImage, busy: busy, close: close
  };
})();
