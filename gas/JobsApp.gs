/**
 * 案件の取り込みと LINE 配信（シート・LINE・AI とのやりとり）。
 * 読み取りに使う AI は Gemini（無料枠あり）か Claude。スクリプト プロパティで切り替える（getConfig_ の aiProvider）。
 * 判定や文面は Jobs.gs、画面は JobImport.html / JobSend.html。
 *
 * - メニュー「セブンハーツ > 案件を取り込む」：依頼文を貼り付け → AI が読み取り → 確認・修正 → 「案件一覧」に追加
 * - メニュー「セブンハーツ > 案件をLINEで配信」：案件を選ぶ → 条件に合うスタッフに一斉送信（応募ボタン付き）
 * - スタッフが応募ボタンを押す → 「案件応募」に追加（onJobPostback_）
 * - 「案件応募」の状態を「確定」「見送り」にする → 本人に LINE で連絡（onApplyEdit_）
 */

var ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
var ANTHROPIC_VERSION = '2023-06-01';
// 安全上の理由で断られたときに、別のモデルで自動でやり直す
var ANTHROPIC_FALLBACK_BETA = 'server-side-fallback-2026-07-01';

/** 「案件一覧」などのシートを用意する（setup から呼ぶ。何度実行しても安全） */
function setupJobSheets_(ss) {
  var jobs = ensureSheet_(ss, JOB_SHEET);
  ensureSheet_(ss, APPLY_SHEET);
  ensureSheet_(ss, IMPORT_SHEET);

  var h = headerMap_(jobs);
  var rows = jobs.getMaxRows() - 1;
  var col = function (label) { return jobs.getRange(2, h[label] + 1, rows, 1); };
  ['単価', '売上', '交通費', '食費', '総支払額'].forEach(function (l) { col(l).setNumberFormat('¥#,##0'); });
  ['休憩時間', '実働時間'].forEach(function (l) { col(l).setNumberFormat('0.##'); });
  col('請求書').setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(INVOICE_OPTIONS, true).build());
  col('募集状況').setDataValidation(SpreadsheetApp.newDataValidation()
    .requireValueInList([RECRUIT.OPEN, RECRUIT.CLOSED], true).build());

  var apply = ss.getSheetByName(APPLY_SHEET);
  var statusValues = Object.keys(APPLY_STATUS).map(function (k) { return APPLY_STATUS[k]; });
  apply.getRange(2, headerMap_(apply)['状態'] + 1, apply.getMaxRows() - 1, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(statusValues, true).setAllowInvalid(false).build());
}

function jobSheets_() {
  var ss = spreadsheet_();
  if (!ss.getSheetByName(JOB_SHEET) || !ss.getSheetByName(APPLY_SHEET) || !ss.getSheetByName(IMPORT_SHEET)) setupJobSheets_(ss);
}

// ---- シートの読み書き（行を見出し名で扱う） ----

/** シートの全行を { rec, row } で返す（row はシートの行番号） */
function readAll_(sheetName) {
  var sh = sheet_(sheetName);
  if (sh.getLastRow() < 2) return [];
  var header = headerMap_(sh);
  return sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).getValues().map(function (v, i) {
    return { rec: rowToRecord_(sheetName, header, v), row: i + 2 };
  });
}

function appendRecords_(sheetName, recs) {
  if (!recs.length) return 0;
  var sh = sheet_(sheetName);
  var header = headerMap_(sh);
  var width = sh.getLastColumn();
  var values = recs.map(function (rec) {
    var v = new Array(width).fill('');
    Object.keys(rec).forEach(function (k) {
      var i = header[labelOf_(sheetName, k)];
      if (i !== undefined) v[i] = cellValue_(rec[k]);
    });
    return v;
  });
  var start = sh.getLastRow() + 1;
  var need = start + values.length - 1 - sh.getMaxRows();
  if (need > 0) sh.insertRowsAfter(sh.getMaxRows(), need); // 書式と入力規則は上の行から引き継がれる
  sh.getRange(start, 1, values.length, width).setValues(values);
  return start;
}

/** 指定した行の列だけを書き換える */
function updateCells_(sheetName, row, fields) {
  var sh = sheet_(sheetName);
  var header = headerMap_(sh);
  Object.keys(fields).forEach(function (k) {
    var i = header[labelOf_(sheetName, k)];
    if (i !== undefined) sh.getRange(row, i + 1).setValue(cellValue_(fields[k]));
  });
}

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new UserError('ただいま混み合っています。少し時間をおいて、もう一度お試しください。');
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

// ---- Claude ----

function claudeRequest_(cfg, system, text, instruction, schema, maxTokens, withFallback) {
  var body = {
    model: cfg.claudeModel,
    max_tokens: maxTokens,
    system: system,
    // 読み取りは単純な作業なので low。Apps Script の1回の通信（約60秒）に収まるようにする
    output_config: { effort: 'low', format: { type: 'json_schema', schema: schema } },
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: '<依頼文>\n' + text + '\n</依頼文>' },
        { type: 'text', text: instruction }
      ]
    }]
  };
  var headers = { 'x-api-key': cfg.anthropicApiKey, 'anthropic-version': ANTHROPIC_VERSION };
  if (withFallback) {
    body.fallbacks = 'default';
    headers['anthropic-beta'] = ANTHROPIC_FALLBACK_BETA;
  }
  return {
    url: ANTHROPIC_URL, method: 'post', contentType: 'application/json',
    headers: headers, payload: JSON.stringify(body), muteHttpExceptions: true
  };
}

/** Claude の応答 → { data } または { error, retry } */
function claudeResult_(res) {
  var code = res.getResponseCode();
  var body;
  try {
    body = JSON.parse(res.getContentText());
  } catch (e) {
    return { error: 'AIからの応答を読めませんでした（' + code + '）', retry: true };
  }
  if (code !== 200) {
    var msg = body && body.error && body.error.message || '';
    if (code === 401) return { error: 'Claude の APIキー（ANTHROPIC_API_KEY）が正しくありません' };
    if (code === 400 && /fallback/i.test(msg)) return { error: msg, noFallback: true };
    if (code === 429 || code >= 500) return { error: 'AIが混み合っています（' + code + '）', retry: true };
    return { error: 'AIでの読み取りに失敗しました（' + code + '）：' + msg };
  }
  if (body.stop_reason === 'refusal') return { error: 'AIがこの文章の読み取りを断りました。内容を確認してください' };
  if (body.stop_reason === 'max_tokens') return { error: '文章が長すぎて読み取りきれませんでした。案件を分けて貼り付けてください' };
  var block = (body.content || []).filter(function (b) { return b.type === 'text'; })[0];
  if (!block) return { error: 'AIからの応答が空でした', retry: true };
  try {
    return { data: JSON.parse(block.text) };
  } catch (e) {
    return { error: 'AIからの応答を読めませんでした', retry: true };
  }
}

/**
 * Claude に並列で問い合わせる。混雑などで失敗したものは1回だけやり直す。
 * @param {Array<{instruction: string, schema: Object, maxTokens: number}>} asks
 */
function askClaude_(text, asks) {
  var cfg = getConfig_();
  if (!cfg.anthropicApiKey) throw new Error('Claude の APIキーが未設定です。スクリプト プロパティ ANTHROPIC_API_KEY を設定してください（README参照）');
  var system = jobSystemPrompt_(new Date());
  var results = new Array(asks.length);
  var pending = asks.map(function (a, i) { return i; });
  var withFallback = true;

  for (var attempt = 0; attempt < 3 && pending.length; attempt++) {
    if (attempt > 0) Utilities.sleep(3000);
    var responses;
    try {
      responses = UrlFetchApp.fetchAll(pending.map(function (i) {
        return claudeRequest_(cfg, system, text, asks[i].instruction, asks[i].schema, asks[i].maxTokens, withFallback);
      }));
    } catch (err) {
      throw new Error('AIの応答に時間がかかりすぎました。案件をいくつかに分けて貼り付けてください（' + err.message + '）');
    }
    var next = [];
    responses.forEach(function (res, k) {
      var i = pending[k];
      var r = claudeResult_(res);
      results[i] = r;
      if (r.noFallback) withFallback = false;
      if (r.retry || r.noFallback) next.push(i);
    });
    pending = next;
  }
  results.forEach(function (r) { if (r.error) throw new Error(r.error); });
  return results.map(function (r) { return r.data; });
}

// ---- Gemini ----

var GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/';

function geminiRequest_(cfg, text, withSchema) {
  var instruction = jobAllPrompt_();
  var gen = { responseMimeType: 'application/json', maxOutputTokens: 32768 };
  if (withSchema) gen.responseJsonSchema = JOB_ALL_SCHEMA;
  else instruction += '\n\n次の JSON Schema に従った JSON だけを返してください：\n' + JSON.stringify(JOB_ALL_SCHEMA);
  return {
    url: GEMINI_URL + encodeURIComponent(cfg.geminiModel) + ':generateContent',
    options: {
      method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      headers: { 'x-goog-api-key': cfg.geminiApiKey },
      payload: JSON.stringify({
        systemInstruction: { parts: [{ text: jobSystemPrompt_(new Date()) }] },
        contents: [{ role: 'user', parts: [{ text: '<依頼文>\n' + text + '\n</依頼文>' }, { text: instruction }] }],
        generationConfig: gen
      })
    }
  };
}

/** Gemini の応答 → { data } または { error, retry, waitMs, noSchema } */
function geminiResult_(res, model) {
  var code = res.getResponseCode();
  var body;
  try {
    body = JSON.parse(res.getContentText());
  } catch (e) {
    return { error: 'AIからの応答を読めませんでした（' + code + '）', retry: true };
  }
  if (code !== 200) {
    var err = (body && body.error) || {};
    var msg = err.message || '';
    if (/API key not valid|API_KEY_INVALID/i.test(msg + JSON.stringify(err.details || ''))) {
      return { error: 'Gemini の APIキー（GEMINI_API_KEY）が正しくありません' };
    }
    if (code === 400 && /response_?json_?schema|schema/i.test(msg)) return { error: msg, noSchema: true };
    if (code === 403) return { error: 'Gemini の APIキーに使う権限がありません（' + msg + '）' };
    if (code === 404) return { error: 'Gemini のモデル「' + model + '」が見つかりません。スクリプト プロパティ GEMINI_MODEL を確認してください' };
    if (code === 429) {
      if (/per ?day|PerDay|daily/i.test(msg + JSON.stringify(err.details || ''))) {
        return { error: 'Gemini の今日の無料枠を使い切りました。明日になると使えます（お急ぎの場合は README の「AIの切り替え」を参照）' };
      }
      // 1分あたりの上限：指定された時間だけ待ってやり直す
      var wait = 20000;
      (err.details || []).forEach(function (d) {
        var m = /^(\d+(?:\.\d+)?)s$/.exec(d.retryDelay || '');
        if (m) wait = Math.ceil(+m[1] * 1000);
      });
      return { error: 'Gemini の1分あたりの上限に達しました。1分ほど待ってからもう一度お試しください', retry: true, waitMs: Math.min(wait, 50000) };
    }
    if (code >= 500) return { error: 'AIが混み合っています（' + code + '）', retry: true };
    return { error: 'AIでの読み取りに失敗しました（' + code + '）：' + msg };
  }
  if (body.promptFeedback && body.promptFeedback.blockReason) return { error: 'AIがこの文章の読み取りを断りました。内容を確認してください' };
  var cand = body.candidates && body.candidates[0];
  if (!cand) return { error: 'AIからの応答が空でした', retry: true };
  if (cand.finishReason === 'MAX_TOKENS') return { error: '文章が長すぎて読み取りきれませんでした。案件を分けて貼り付けてください' };
  if (cand.finishReason && cand.finishReason !== 'STOP') return { error: 'AIがこの文章の読み取りを断りました（' + cand.finishReason + '）' };
  var text = ((cand.content && cand.content.parts) || []).filter(function (p) { return p.text && !p.thought; })
    .map(function (p) { return p.text; }).join('').trim()
    .replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
  try {
    return { data: JSON.parse(text) };
  } catch (e) {
    return { error: 'AIからの応答を読めませんでした', retry: true };
  }
}

/**
 * Gemini で依頼文の案件をすべて読む（1回の問い合わせ。無料枠は1日の回数が少ないため）。
 * 混雑・1分あたりの上限のときは待ってやり直す。JSON Schema の指定を受け付けないモデルなら、指示文で形を伝える。
 */
function askGemini_(text) {
  var cfg = getConfig_();
  if (!cfg.geminiApiKey) throw new Error('Gemini の APIキーが未設定です。スクリプト プロパティ GEMINI_API_KEY を設定してください（README参照）');
  var withSchema = true;
  var r = null;
  for (var attempt = 0; attempt < 3; attempt++) {
    if (r && r.retry) Utilities.sleep(r.waitMs || 3000);
    var req = geminiRequest_(cfg, text, withSchema);
    var res;
    try {
      res = UrlFetchApp.fetch(req.url, req.options);
    } catch (err) {
      throw new Error('AIの応答に時間がかかりすぎました。案件をいくつかに分けて貼り付けてください（' + err.message + '）');
    }
    r = geminiResult_(res, cfg.geminiModel);
    if (r.data) return r.data;
    if (r.noSchema && withSchema) { withSchema = false; r = { retry: true, waitMs: 1 }; continue; }
    if (!r.retry) break;
  }
  throw new Error(r.error);
}

// ---- 案件の取り込み（JobImport.html から呼ぶ） ----

function showJobImport() {
  jobSheets_();
  var html = HtmlService.createHtmlOutputFromFile('JobImport').setWidth(1100).setHeight(760);
  SpreadsheetApp.getUi().showModalDialog(html, '案件を取り込む');
}

/** 画面を開いたとき：これまでの取引先名（入力候補） */
function jobImportInit() {
  var seen = {};
  readAll_(JOB_SHEET).forEach(function (x) { if (x.rec.client) seen[x.rec.client] = true; });
  return { clients: Object.keys(seen).sort() };
}

/** 依頼文を読み取って、確認画面に出す案件の一覧を返す */
function parseJobText(text) {
  text = String(text || '').trim();
  if (!text) throw new Error('依頼文を貼り付けてください');
  if (text.length > 30000) throw new Error('文章が長すぎます。案件をいくつかに分けて貼り付けてください');

  if (getConfig_().aiProvider === 'gemini') {
    var all = (askGemini_(text).cases || []).filter(function (c) { return c && typeof c === 'object'; });
    if (!all.length) throw new Error('案件を読み取れませんでした。日程や場所が書かれた依頼文か確認してください');
    return { cases: all.map(normalizeCase_) };
  }

  // 1回目：どんな案件が含まれているか（短い応答なのですぐ終わる）
  var list = askClaude_(text, [{ instruction: jobListPrompt_(), schema: JOB_LIST_SCHEMA, maxTokens: 4000 }])[0];
  var labels = (list.cases || []).map(function (c) { return str_(c.label); }).filter(Boolean);
  if (!labels.length) throw new Error('案件を読み取れませんでした。日程や場所が書かれた依頼文か確認してください');
  if (labels.length > 20) throw new Error('案件が多すぎます（' + labels.length + '件）。20件以下に分けて貼り付けてください');

  // 2回目：案件ごとに並列で詳しく読む（1回で全部読むより速く、時間切れになりにくい）
  var details = askClaude_(text, labels.map(function (label) {
    return { instruction: jobDetailPrompt_(label, labels), schema: JOB_DETAIL_SCHEMA, maxTokens: 8000 };
  }));
  return { cases: details.map(normalizeCase_) };
}

/** 確認画面で「シートに追加」を押したとき */
function saveJobs(payload) {
  var cases = (payload && payload.cases) || [];
  var client = str_(payload && payload.client);
  if (!cases.length) throw new Error('追加する案件がありません');
  var importId = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyMMddHHmmss');
  var rows = jobRows_(cases, { client: client, importId: importId, paymentMonthsAfter: getConfig_().paymentMonthsAfter });
  if (!rows.length) throw new Error('日程が1つもありません。日程を入れてから追加してください');

  var start = withLock_(function () {
    jobSheets_();
    var first = appendRecords_(JOB_SHEET, rows);
    appendRecords_(IMPORT_SHEET, [{
      importId: importId, at: now_(), client: client || rows[0].client, cases: cases.length, rows: rows.length,
      text: String(payload.text || '').slice(0, 45000)
    }]);
    return first;
  });
  var sh = sheet_(JOB_SHEET);
  sh.activate();
  sh.setActiveRange(sh.getRange(start, 1, rows.length, sh.getLastColumn()));
  return { rows: rows.length, cases: cases.length };
}

// ---- LINE 配信（JobSend.html から呼ぶ） ----

function showJobSend() {
  jobSheets_();
  var html = HtmlService.createHtmlOutputFromFile('JobSend').setWidth(900).setHeight(760);
  SpreadsheetApp.getUi().showModalDialog(html, '案件をLINEで配信');
}

/** 募集中で、まだ始まっていない枠を案件IDごとにまとめる */
function openJobGroups_(now) {
  var groups = {};
  var order = [];
  readAll_(JOB_SHEET).forEach(function (x) {
    var r = x.rec;
    if (!r.slotId || !r.caseId) return;
    if (applyRejectReason_(r, {}, false, now)) return; // 募集終了・開始済み
    if (!groups[r.caseId]) { groups[r.caseId] = []; order.push(r.caseId); }
    r._row = x.row;
    groups[r.caseId].push(r);
  });
  return order.map(function (id) { return groups[id]; });
}

/** 画面を開いたとき：配信できる案件と、シートで選んでいた案件 */
function jobSendInit() {
  var now = new Date();
  var selected = {};
  var sh = SpreadsheetApp.getActiveSheet();
  if (sh && sh.getName() === JOB_SHEET) {
    var header = headerMap_(sh);
    var list = sh.getActiveRangeList();
    (list ? list.getRanges() : []).forEach(function (range) {
      if (range.getRow() < 2) return;
      sh.getRange(range.getRow(), header['案件ID'] + 1, range.getNumRows(), 1).getValues()
        .forEach(function (v) { if (v[0]) selected[v[0]] = true; });
    });
  }
  return {
    statuses: Object.keys(STATUS).map(function (k) { return STATUS[k]; }),
    defaultStatuses: [STATUS.ACTIVE],
    groups: openJobGroups_(now).map(function (rows) {
      var f = rows[0];
      return {
        caseId: f.caseId, title: f.title, client: f.client, place: f.place, area: areaOf_(f.prefecture),
        genderReq: f.genderReq, conditions: f.conditions, staffPay: f.staffPay, staffTransport: f.staffTransport,
        sentAt: f.sentAt ? String(f.sentAt) : '', selected: !!selected[f.caseId],
        slots: rows.map(function (r) {
          return { label: slotLabel_(r), headcount: r.headcount, applied: r.applied || 0 };
        })
      };
    })
  };
}

function selectedGroups_(caseIds) {
  var groups = openJobGroups_(new Date()).filter(function (rows) { return caseIds.indexOf(rows[0].caseId) >= 0; });
  if (!groups.length) throw new Error('配信する案件を選んでください（募集中で、まだ始まっていない日程のみ配信できます）');
  return groups;
}

function staffRecords_() {
  return readAll_(REG_SHEET).map(function (x) { return x.rec; });
}

/** 送信先の人数と名前（送る前の確認） */
function jobSendPreview(req) {
  var groups = selectedGroups_(req.caseIds || []);
  var staff = staffRecords_();
  var buckets = jobBuckets_(staff, groups, req);
  var byId = {};
  staff.forEach(function (r) { byId[r.userId] = r; });
  var ids = [];
  buckets.forEach(function (b) { ids = ids.concat(b.userIds); });
  return {
    count: ids.length,
    names: ids.slice(0, 100).map(function (id) { return byId[id].lastName + ' ' + byId[id].firstName; }),
    perCase: groups.map(function (rows) {
      var n = 0;
      buckets.forEach(function (b) { if (b.groups.indexOf(rows) >= 0) n += b.userIds.length; });
      return { title: rows[0].title, count: n, filter: jobFilter_(rows, req) };
    })
  };
}

/** 一斉送信する。給与・交通費の表示はシートにも保存する */
function jobSend(req) {
  var edits = req.edits || {};
  // 先に表示内容をシートに保存してから、読み直して送る
  readAll_(JOB_SHEET).forEach(function (x) {
    var e = edits[x.rec.caseId];
    if (!e) return;
    if (str_(e.staffPay) !== str_(x.rec.staffPay) || str_(e.staffTransport) !== str_(x.rec.staffTransport)) {
      updateCells_(JOB_SHEET, x.row, { staffPay: str_(e.staffPay), staffTransport: str_(e.staffTransport) });
    }
  });
  var groups = selectedGroups_(req.caseIds || []);
  var buckets = jobBuckets_(staffRecords_(), groups, req);
  if (!buckets.length) throw new Error('送信先のスタッフがいません。条件を変えてください');

  // 同じ案件の組み合わせを受け取る人ごとにまとめて送る（エリア・性別の条件が案件ごとに違うため）
  var sent = 0, failed = 0;
  var sentPerCase = {};
  buckets.forEach(function (b) {
    var messages = jobMessages_(b.groups);
    for (var i = 0; i < b.userIds.length; i += MULTICAST_LIMIT) {
      var to = b.userIds.slice(i, i + MULTICAST_LIMIT);
      if (lineRequest_('post', '/message/multicast', { to: to, messages: messages })) {
        sent += to.length;
        b.groups.forEach(function (rows) { sentPerCase[rows[0].caseId] = (sentPerCase[rows[0].caseId] || 0) + to.length; });
      } else {
        failed += to.length;
        logError_('案件の配信', '', new Error('LINE への送信に失敗しました（' + to.length + '人分）'));
      }
    }
  });
  if (!sent) throw new Error('LINE への送信に失敗しました。シート「エラーログ」と checkSettings を確認してください');

  var at = now_();
  groups.forEach(function (rows) {
    var n = sentPerCase[rows[0].caseId];
    if (!n) return;
    rows.forEach(function (r) {
      updateCells_(JOB_SHEET, r._row, { sentAt: at, sentCount: (toNum_(r.sentCount) || 0) + n });
    });
  });
  return { sent: sent, failed: failed };
}

// ---- 応募（LINE の応募ボタン） ----

function findSlot_(slotId) {
  var all = readAll_(JOB_SHEET);
  for (var i = 0; i < all.length; i++) if (all[i].rec.slotId === slotId) return all[i];
  return null;
}

function onJobPostback_(ev, userId, params) {
  if (params.job !== 'apply' || !params.s) return;
  var staff = readRecord_(REG_SHEET, userId);
  var reply = withLock_(function () {
    var slot = findSlot_(params.s);
    var apps = readAll_(APPLY_SHEET);
    var already = apps.some(function (x) {
      return x.rec.slotId === params.s && x.rec.userId === userId && x.rec.status !== APPLY_STATUS.CANCELLED;
    });
    var reason = applyRejectReason_(slot && slot.rec, staff, already, new Date());
    if (reason) return reason;

    var s = slot.rec;
    appendRecords_(APPLY_SHEET, [{
      appliedAt: now_(), status: APPLY_STATUS.APPLIED, slotId: s.slotId, caseId: s.caseId, title: s.title,
      date: s.date, time: [s.start, s.end].filter(Boolean).join('〜'),
      name: fullName_(staff), phone: staff.phone, userId: userId
    }]);
    var count = apps.filter(function (x) { return x.rec.slotId === s.slotId && x.rec.status !== APPLY_STATUS.CANCELLED; }).length + 1;
    updateCells_(JOB_SHEET, slot.row, { applied: count });
    return applyAcceptedText_(s);
  });
  replyMessage_(ev.replyToken, [textMessage_(reply)]);
  if (reply.indexOf('応募を受け付けました') === 0) notifyAdmin_('案件への応募', fullName_(staff));
}

/** 「案件応募」の状態を変えたとき（onStatusEdit から）。確定・見送りを本人に知らせる */
function onApplyEdit_(e) {
  var sh = e.range.getSheet();
  var header = headerMap_(sh);
  var statusCol = header['状態'] + 1;
  if (e.range.getColumn() > statusCol || e.range.getLastColumn() < statusCol) return;
  var firstRow = Math.max(e.range.getRow(), 2);
  var lastRow = e.range.getLastRow();
  if (lastRow < firstRow) return;
  var rows = sh.getRange(firstRow, 1, lastRow - firstRow + 1, sh.getLastColumn()).getValues();

  rows.forEach(function (values, k) {
    var app = rowToRecord_(APPLY_SHEET, header, values);
    if (!app.userId || app.notifiedAt) return;
    if (app.status !== APPLY_STATUS.CONFIRMED && app.status !== APPLY_STATUS.DECLINED) return;
    try {
      var slot = findSlot_(app.slotId);
      var text = app.status === APPLY_STATUS.CONFIRMED ? applyConfirmedText_(app, slot && slot.rec) : applyDeclinedText_(app);
      if (pushMessage_(app.userId, [textMessage_(text)])) {
        updateCells_(APPLY_SHEET, firstRow + k, { notifiedAt: now_() });
      } else {
        updateCells_(APPLY_SHEET, firstRow + k, { adminMemo: appendMemo_(app.adminMemo, '連絡を送れませんでした（' + now_() + '）') });
      }
    } catch (err) {
      console.error('onApplyEdit failed', app.userId, err && err.stack || err);
      logError_('案件応募：' + app.status, app.userId, err);
    }
  });
}
