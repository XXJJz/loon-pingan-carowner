/*
 * 平安好车主 Loon 脚本
 *
 * 已根据平安好车主 6.03.1 的 signPoint 前端资源核对接口：
 * - /micro-api/activity-sign/gw/signCall/mainv1
 * - /micro-api/activity-sign/gw/signCall/toSign
 * - /micro-api/activity-points-zone/gw/taskCall/taskMine
 * - /micro-api/activity-points-zone/gw/taskCall/finish
 * - /micro-api/activity-points-zone/gw/taskCall/reward
 * - /micro-api/activity-points-zone/gw/taskCall/rewardBatch
 *
 * App 会在原生层动态签名并加密请求。脚本优先尝试 secret_token 明文模式，
 * 失败时只对静态请求使用已抓取的原请求降级重放，不伪装成已验证成功。
 */

(function () {
  "use strict";

  var SCRIPT_VERSION = "1.0.3";
  var STORE_PREFIX = "pingan_carowner.";
  var AUTO_HEADER = "X-Loon-Pingan-Auto";
  var SIGN_BASE = "https://hcz-member.pingan.com.cn/micro-api/activity-sign";
  var TASK_BASE = "https://hcz-member.pingan.com.cn/micro-api/activity-points-zone";

  function debugLog(message) {
    console.log("[平安好车主] " + message);
  }

  function readJson(key, fallback) {
    var raw = $persistentStore.read(STORE_PREFIX + key);
    if (!raw) return fallback;
    try {
      return JSON.parse(raw);
    } catch (e) {
      return fallback;
    }
  }

  function writeJson(key, value) {
    return $persistentStore.write(JSON.stringify(value), STORE_PREFIX + key);
  }

  function clone(value) {
    var out = {};
    Object.keys(value || {}).forEach(function (key) {
      out[key] = value[key];
    });
    return out;
  }

  function headerValue(headers, wanted) {
    var result = "";
    Object.keys(headers || {}).some(function (key) {
      if (key.toLowerCase() === wanted.toLowerCase()) {
        result = String(headers[key]);
        return true;
      }
      return false;
    });
    return result;
  }

  function removeHeader(headers, wanted) {
    Object.keys(headers || {}).forEach(function (key) {
      if (key.toLowerCase() === wanted.toLowerCase()) delete headers[key];
    });
  }

  function cleanCapturedHeaders(headers) {
    var out = {};
    var blocked = {
      host: true,
      "content-length": true,
      connection: true,
      "accept-encoding": true,
      "transfer-encoding": true
    };
    Object.keys(headers || {}).forEach(function (key) {
      if (!blocked[key.toLowerCase()]) out[key] = headers[key];
    });
    return out;
  }

  function actionFromUrl(url) {
    var match = String(url || "").match(/\/(mainv1|toSign|taskMine|finish|reward|rewardBatch|refreshRecommend)(?:\?|$)/);
    return match ? match[1] : "unknown";
  }

  function maskPresent(value) {
    return value ? "已获取" : "未发现";
  }

  function bodyFieldNames(body) {
    if (!body) return "无";
    try {
      var parsed = JSON.parse(body);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return Object.keys(parsed).sort().join("|") || "空对象";
      }
    } catch (e) {}
    var fields = [];
    String(body).split("&").forEach(function (pair) {
      var key = pair.split("=")[0];
      if (key && fields.indexOf(key) === -1) fields.push(key);
    });
    return fields.length ? fields.sort().join("|") : "非结构化";
  }

  function utf8Bytes(value) {
    var text = String(value || "");
    var bytes = [];
    var i;
    for (i = 0; i < text.length; i += 1) {
      var code = text.charCodeAt(i);
      if (code < 0x80) {
        bytes.push(code);
      } else if (code < 0x800) {
        bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
      } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
        var low = text.charCodeAt(i + 1);
        if (low >= 0xdc00 && low <= 0xdfff) {
          var point = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
          bytes.push(
            0xf0 | (point >> 18),
            0x80 | ((point >> 12) & 0x3f),
            0x80 | ((point >> 6) & 0x3f),
            0x80 | (point & 0x3f)
          );
          i += 1;
        } else {
          bytes.push(0xef, 0xbf, 0xbd);
        }
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        bytes.push(0xef, 0xbf, 0xbd);
      } else {
        bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
      }
    }
    return bytes;
  }

  function base64Encode(value) {
    var bytes = utf8Bytes(value);
    var alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    var out = "";
    var i;
    for (i = 0; i < bytes.length; i += 3) {
      var a = bytes[i];
      var b = i + 1 < bytes.length ? bytes[i + 1] : 0;
      var c = i + 2 < bytes.length ? bytes[i + 2] : 0;
      out += alphabet.charAt(a >> 2);
      out += alphabet.charAt(((a & 3) << 4) | (b >> 4));
      out += i + 1 < bytes.length ? alphabet.charAt(((b & 15) << 2) | (c >> 6)) : "=";
      out += i + 2 < bytes.length ? alphabet.charAt(c & 63) : "=";
    }
    return out;
  }

  function rightRotate(value, amount) {
    return (value >>> amount) | (value << (32 - amount));
  }

  function sha256(value) {
    var constants = [
      0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
      0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
      0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
      0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
      0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
      0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
      0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
      0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
    ];
    var hash = [
      0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
      0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
    ];
    var bytes = utf8Bytes(value);
    var bitLengthHigh = Math.floor((bytes.length * 8) / 0x100000000);
    var bitLengthLow = (bytes.length * 8) >>> 0;
    bytes.push(0x80);
    while (bytes.length % 64 !== 56) bytes.push(0);
    bytes.push(
      (bitLengthHigh >>> 24) & 255, (bitLengthHigh >>> 16) & 255,
      (bitLengthHigh >>> 8) & 255, bitLengthHigh & 255,
      (bitLengthLow >>> 24) & 255, (bitLengthLow >>> 16) & 255,
      (bitLengthLow >>> 8) & 255, bitLengthLow & 255
    );

    var offset;
    for (offset = 0; offset < bytes.length; offset += 64) {
      var words = [];
      var i;
      for (i = 0; i < 16; i += 1) {
        var p = offset + i * 4;
        words[i] = ((bytes[p] << 24) | (bytes[p + 1] << 16) | (bytes[p + 2] << 8) | bytes[p + 3]) | 0;
      }
      for (i = 16; i < 64; i += 1) {
        var w15 = words[i - 15];
        var w2 = words[i - 2];
        var s0 = rightRotate(w15, 7) ^ rightRotate(w15, 18) ^ (w15 >>> 3);
        var s1 = rightRotate(w2, 17) ^ rightRotate(w2, 19) ^ (w2 >>> 10);
        words[i] = (words[i - 16] + s0 + words[i - 7] + s1) | 0;
      }

      var a = hash[0];
      var b = hash[1];
      var c = hash[2];
      var d = hash[3];
      var e = hash[4];
      var f = hash[5];
      var g = hash[6];
      var h = hash[7];
      for (i = 0; i < 64; i += 1) {
        var bigS1 = rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25);
        var choose = (e & f) ^ ((~e) & g);
        var temp1 = (h + bigS1 + choose + constants[i] + words[i]) | 0;
        var bigS0 = rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22);
        var majority = (a & b) ^ (a & c) ^ (b & c);
        var temp2 = (bigS0 + majority) | 0;
        h = g;
        g = f;
        f = e;
        e = (d + temp1) | 0;
        d = c;
        c = b;
        b = a;
        a = (temp1 + temp2) | 0;
      }
      hash[0] = (hash[0] + a) | 0;
      hash[1] = (hash[1] + b) | 0;
      hash[2] = (hash[2] + c) | 0;
      hash[3] = (hash[3] + d) | 0;
      hash[4] = (hash[4] + e) | 0;
      hash[5] = (hash[5] + f) | 0;
      hash[6] = (hash[6] + g) | 0;
      hash[7] = (hash[7] + h) | 0;
    }
    return hash.map(function (word) {
      return ("00000000" + (word >>> 0).toString(16)).slice(-8);
    }).join("").toUpperCase();
  }

  function urlParts(url) {
    var match = String(url || "").match(/^(?:https?:\/\/[^/]+)?([^?#]*)(?:\?([^#]*))?/i);
    return { path: match && match[1] ? match[1] : "", query: match && match[2] ? match[2] : "" };
  }

  function valueShape(value) {
    var text = String(value || "");
    if (!text) return "无";
    if (/^[0-9]+$/.test(text)) return text.length + "位数字";
    if (/^[0-9a-f]+$/i.test(text)) return text.length + "位十六进制";
    if (/^[0-9a-f-]+$/i.test(text)) return text.length + "位UUID样式";
    return text.length + "字符";
  }

  function nonceShape(body) {
    try {
      var parsed = JSON.parse(body || "{}");
      var nonce = parsed["x-PA-NONCESTR"] || parsed["x-pa-noncestr"] || parsed.nonce || "";
      return valueShape(nonce);
    } catch (e) {
      return "无法解析";
    }
  }

  function signatureDiagnostic(action) {
    var profile = readJson("profile." + action, null);
    if (!profile) return;
    var headers = profile.headers || {};
    var actual = headerValue(headers, "x-pa-sign").replace(/\s/g, "").toUpperCase();
    var timestamp = headerValue(headers, "x-pa-timestamp");
    if (!actual || !timestamp) {
      debugLog("签名自检 " + action + "：跳过（缺少签名或时间戳）");
      return;
    }

    var method = String(profile.method || "POST").toUpperCase();
    var parts = urlParts(profile.url);
    var paths = [{ name: "完整路径", value: parts.path }];
    if (parts.path.indexOf("/micro-api/") === 0) {
      paths.push({ name: "去micro-api路径", value: parts.path.slice(10) });
    }
    var body = String(profile.body || "");
    var payloads = [
      { name: "正文Base64", value: base64Encode(body) },
      { name: "原始正文", value: body },
      { name: "查询串", value: parts.query },
      { name: "查询串加正文Base64", value: parts.query + base64Encode(body) },
      { name: "空载荷", value: "" }
    ];
    var fixedValues = [
      { name: "x-pa-agent", value: headerValue(headers, "x-pa-agent") },
      { name: "旧版固定因子", value: "05419C0F13B8004C" },
      { name: "x-pa-udid", value: headerValue(headers, "x-pa-udid") },
      { name: "x-pa-uuid", value: headerValue(headers, "x-pa-uuid") },
      { name: "空因子", value: "" }
    ];
    var platforms = ["ios", "iOS", "IOS"];
    var seen = {};
    var tested = 0;
    var matched = "";

    function testCandidate(preimage, label) {
      if (matched || seen[preimage]) return;
      seen[preimage] = true;
      tested += 1;
      if (sha256(preimage) === actual) matched = label;
    }

    paths.forEach(function (pathItem) {
      payloads.forEach(function (payload) {
        fixedValues.forEach(function (fixed) {
          platforms.forEach(function (platform) {
            var core = method + fixed.value + pathItem.value + payload.value + timestamp + platform;
            var label = fixed.name + "/" + pathItem.name + "/" + payload.name + "/" + platform;
            testCandidate(core, "旧版顺序/" + label);
            testCandidate(core + "1", "旧版顺序加版本1/" + label);
            testCandidate(method + pathItem.value + payload.value + timestamp + platform + fixed.value, "末尾因子/" + label);
            testCandidate(method + pathItem.value + payload.value + timestamp + fixed.value + platform, "时间戳后因子/" + label);
          });
        });
      });
    });

    if (matched) {
      debugLog("签名自检 " + action + "：匹配 " + matched);
    } else {
      debugLog(
        "签名自检 " + action + "：未匹配（已测试 " + tested + " 种；签名=" + valueShape(actual) +
        "，时间戳=" + valueShape(timestamp) + "，agent=" + valueShape(headerValue(headers, "x-pa-agent")) +
        "，nonce=" + nonceShape(body) + "）"
      );
    }
  }

  function profileDiagnostic(action) {
    var profile = readJson("profile." + action, null);
    if (!profile) {
      debugLog("模板 " + action + "：未抓到");
      return;
    }
    var captured = Date.parse(profile.capturedAt || "");
    var age = isFinite(captured) ? Math.max(0, Math.round((Date.now() - captured) / 60000)) + " 分钟" : "未知";
    debugLog(
      "模板 " + action + "：距今 " + age +
      "；请求头=" + (Object.keys(profile.headers || {}).sort().join("|") || "无") +
      "；请求体字段=" + bodyFieldNames(profile.body)
    );
  }

  function captureRequest() {
    var headers = cleanCapturedHeaders($request.headers || {});
    if (headerValue(headers, AUTO_HEADER) === "1") {
      $done({});
      return;
    }

    var action = actionFromUrl($request.url);
    debugLog("捕获请求：" + action);
    var profile = {
      action: action,
      url: $request.url,
      method: $request.method || "POST",
      headers: headers,
      body: typeof $request.body === "string" ? $request.body : "",
      capturedAt: new Date().toISOString()
    };
    writeJson("profile." + action, profile);

    var oldAuth = readJson("auth", {});
    var accessToken = headerValue(headers, "access_token") || headerValue(headers, "access-token");
    var secretToken = headerValue(headers, "secret_token") || headerValue(headers, "secret-token");
    var aopsId = headerValue(headers, "aopsID") || headerValue(headers, "aopsid");
    var spartaId = headerValue(headers, "spartaId") || headerValue(headers, "sparta-id");
    var auth = {
      headers: headers,
      accessToken: accessToken || oldAuth.accessToken || "",
      secretToken: secretToken || oldAuth.secretToken || "",
      aopsId: aopsId || oldAuth.aopsId || "",
      spartaId: spartaId || oldAuth.spartaId || "",
      capturedAt: profile.capturedAt,
      lastAction: action
    };
    writeJson("auth", auth);
    debugLog(
      "凭据状态：Token " + maskPresent(auth.accessToken || auth.secretToken) +
      "，AopsID " + maskPresent(auth.aopsId) +
      "，模板 " + (profile.body ? "已保存" : "无请求体")
    );

    var notified = readJson("capture_notified", {});
    if (!notified[action]) {
      notified[action] = true;
      writeJson("capture_notified", notified);
      $notification.post(
        "平安好车主 · 抓取成功",
        action,
        "Token " + maskPresent(auth.accessToken || auth.secretToken) + "，AopsID " + maskPresent(auth.aopsId) + "。凭据仅保存在 Loon 本地。"
      );
    }
    $done({});
  }

  function boolArg(value, fallback) {
    if (value === true || value === "true" || value === 1 || value === "1") return true;
    if (value === false || value === "false" || value === 0 || value === "0") return false;
    return fallback;
  }

  function getArgs() {
    var arg = typeof $argument === "object" && $argument ? $argument : {};
    var max = parseInt(arg.maxTasks, 10);
    if (!isFinite(max) || max < 0) max = 5;
    if (max > 10) max = 10;
    return {
      city: String(arg.city || "北京").trim() || "北京",
      autoFinish: boolArg(arg.autoFinish, true),
      autoReward: boolArg(arg.autoReward, true),
      maxTasks: max,
      replayFallback: boolArg(arg.replayFallback, true)
    };
  }

  function buildPlainHeaders(auth) {
    var source = auth.headers || {};
    var headers = {
      Accept: "application/json",
      "Content-Type": "application/json",
      Origin: "https://hcz-static.pingan.com.cn",
      Referer: "https://hcz-static.pingan.com.cn/activities/signPoint/index.html",
      "User-Agent": headerValue(source, "User-Agent") || "Mozilla/5.0 (iPhone; CPU iPhone OS like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148",
      "X-Loon-Pingan-Auto": "1"
    };
    var cookie = headerValue(source, "Cookie");
    if (cookie) headers.Cookie = cookie;
    if (auth.aopsId) headers.aopsID = auth.aopsId;
    if (auth.spartaId) headers.spartaId = auth.spartaId;
    if (auth.accessToken) headers.access_token = auth.accessToken;
    headers.secret_token = auth.secretToken || auth.accessToken || "";
    if (!headers.secret_token) delete headers.secret_token;
    return headers;
  }

  function parseResponse(body, status) {
    var json;
    try {
      json = JSON.parse(body || "{}");
    } catch (e) {
      return { ok: false, code: status || -1, message: "响应不是 JSON", raw: body || "" };
    }
    var code = typeof json.error_code !== "undefined" ? json.error_code : json.code;
    var ok = (status >= 200 && status < 300) && (code === 0 || code === "0" || code === 100 || code === "100");
    return {
      ok: ok,
      code: typeof code === "undefined" ? status : code,
      message: json.msg || json.message || json.error_msg || json.errorMsg || json.errorMessage || json.responseMsg || json.retMsg || json.resultMsg || json.desc || "",
      data: typeof json.data === "undefined" ? json : json.data,
      raw: json
    };
  }

  function postRaw(options, callback) {
    $httpClient.post(options, function (error, response, body) {
      if (error) {
        debugLog("请求 " + actionFromUrl(options.url) + " 失败：" + String(error));
        callback({ ok: false, code: -1, message: String(error) });
        return;
      }
      var result = parseResponse(body, response && response.status);
      debugLog(
        "请求 " + actionFromUrl(options.url) +
        "：HTTP " + ((response && response.status) || "未知") +
        "，业务码 " + result.code +
        "，" + (result.ok ? "成功" : "失败")
      );
      callback(result);
    });
  }

  function postPlain(auth, url, data, callback) {
    postRaw({
      url: url,
      timeout: 15000,
      headers: buildPlainHeaders(auth),
      body: JSON.stringify(data || {}),
      "auto-cookie": false,
      alpn: "h2"
    }, callback);
  }

  function replayProfile(action, callback) {
    var profile = readJson("profile." + action, null);
    if (!profile || !profile.url || !profile.body) {
      callback({ ok: false, code: -2, message: "没有 " + action + " 原请求模板" });
      return;
    }
    var headers = cleanCapturedHeaders(profile.headers || {});
    headers[AUTO_HEADER] = "1";
    postRaw({
      url: profile.url,
      timeout: 15000,
      headers: headers,
      body: profile.body,
      "auto-cookie": false,
      alpn: "h2"
    }, callback);
  }

  function staticPost(auth, args, action, url, data, callback) {
    postPlain(auth, url, data, function (result) {
      if (result.ok || !args.replayFallback) {
        debugLog(action + " 使用 Token 模式：" + (result.ok ? "成功" : "失败"));
        callback(result, "token");
        return;
      }
      debugLog(action + " 的 Token 模式失败，尝试原请求重放");
      replayProfile(action, function (fallbackResult) {
        debugLog(action + " 使用重放模式：" + (fallbackResult.ok ? "成功" : "失败"));
        callback(fallbackResult, "replay");
      });
    });
  }

  function recursiveFind(object, names) {
    if (!object || typeof object !== "object") return undefined;
    var keys = Object.keys(object);
    var found;
    keys.some(function (key) {
      if (names.indexOf(key) !== -1) {
        found = object[key];
        return true;
      }
      return false;
    });
    if (typeof found !== "undefined") return found;
    keys.some(function (key) {
      found = recursiveFind(object[key], names);
      return typeof found !== "undefined";
    });
    return found;
  }

  function uniqueTasks(data) {
    var names = ["recommendList", "taskRenewList", "task_once_list", "task_daily_list", "task_monthly_list"];
    var seen = {};
    var tasks = [];
    names.forEach(function (name) {
      var list = data && data[name];
      if (!Array.isArray(list)) return;
      list.forEach(function (task) {
        var id = String(task.task_id || task.taskId || "");
        if (id && !seen[id]) {
          seen[id] = true;
          tasks.push(task);
        }
      });
    });
    return tasks;
  }

  function isSafeBrowseTask(task) {
    var title = String(task.title || task.task_name || "");
    var desc = String(task.desc || task.description || "");
    var positive = /(浏览|查看|阅读|访问|逛一逛|去看看|了解一下|打开)/.test(title);
    var blocked = /(购买|投保|支付|下单|充值|邀请|绑定|上传|完善资料|添加车辆|修改|评论|发帖|点赞|分享|授权|预约)/.test(title + " " + desc);
    return positive && !blocked;
  }

  function taskStatus(task) {
    var value = typeof task.reward_status !== "undefined" ? task.reward_status : task.rewardStatus;
    return Number(value);
  }

  function taskId(task) {
    return task.task_id || task.taskId;
  }

  function runSeries(items, iterator, done) {
    var index = 0;
    function next() {
      if (index >= items.length) {
        done();
        return;
      }
      iterator(items[index++], next);
    }
    next();
  }

  function runDaily() {
    var args = getArgs();
    var auth = readJson("auth", null);
    var log = [];
    var counters = { finished: 0, finishFailed: 0, rewarded: 0, rewardFailed: 0 };
    var rewardAttempted = {};

    debugLog(
      "v" + SCRIPT_VERSION + " 定时任务开始：城市=" + args.city +
      "，浏览任务=" + (args.autoFinish ? "开" : "关") +
      "，自动领奖=" + (args.autoReward ? "开" : "关") +
      "，任务上限=" + args.maxTasks
    );
    debugLog("已保存认证请求头=" + (auth && auth.headers ? Object.keys(auth.headers).sort().join("|") : "无"));
    profileDiagnostic("mainv1");
    profileDiagnostic("toSign");
    profileDiagnostic("taskMine");
    signatureDiagnostic("mainv1");
    signatureDiagnostic("toSign");
    signatureDiagnostic("taskMine");

    if (!auth || !(auth.accessToken || auth.secretToken)) {
      debugLog("停止：未找到凭据。请先在同一台 iPhone 上通过 Loon 打开平安好车主签到页和任务中心。");
      $notification.post("平安好车主", "缺少凭据", "请先开启 Loon MITM，再在平安好车主 App 进入签到页和任务中心。");
      $done();
      return;
    }

    function finish(summary) {
      log.push(summary);
      console.log("[平安好车主] 执行结果：\n" + log.join("\n"));
      $notification.post("平安好车主", "定时任务完成", log.join("\n"));
      $done();
    }

    function fetchTasks(callback) {
      staticPost(auth, args, "taskMine", TASK_BASE + "/gw/taskCall/taskMine", { city: args.city }, function (result, mode) {
        if (!result.ok) {
          callback(result, [], mode);
          return;
        }
        callback(result, uniqueTasks(result.data || {}), mode);
      });
    }

    function claimRewards(tasks, callback) {
      if (!args.autoReward) {
        callback();
        return;
      }
      var ready = tasks.filter(function (task) {
        var id = String(taskId(task) || "");
        return taskStatus(task) === 0 && id && !rewardAttempted[id];
      });
      runSeries(ready, function (task, next) {
        rewardAttempted[String(taskId(task))] = true;
        postPlain(auth, TASK_BASE + "/gw/taskCall/reward", { task_id: taskId(task) }, function (result) {
          if (result.ok) counters.rewarded += 1;
          else counters.rewardFailed += 1;
          next();
        });
      }, callback);
    }

    function finishBrowseTasks(tasks, callback) {
      if (!args.autoFinish || args.maxTasks === 0) {
        callback();
        return;
      }
      var pending = tasks.filter(function (task) {
        return taskStatus(task) === 2 && isSafeBrowseTask(task);
      }).slice(0, args.maxTasks);
      runSeries(pending, function (task, next) {
        postPlain(auth, TASK_BASE + "/gw/taskCall/finish", { task_id: taskId(task) }, function (result) {
          if (result.ok) counters.finished += 1;
          else counters.finishFailed += 1;
          next();
        });
      }, callback);
    }

    staticPost(auth, args, "mainv1", SIGN_BASE + "/gw/signCall/mainv1", {
      city: args.city,
      prayerInteractFlag: "1",
      isMini: 0,
      isHmEnv: 0
    }, function (homeResult, homeMode) {
      if (!homeResult.ok) {
        log.push("签到首页失败：" + (homeResult.message || homeResult.code));
      }
      var signed = Number(recursiveFind(homeResult.data, ["hadSign", "had_sign", "signStatus", "sign_status"])) === 1;
      if (signed) {
        log.push("签到：今天已签到");
        continueTasks();
        return;
      }
      staticPost(auth, args, "toSign", SIGN_BASE + "/gw/signCall/toSign", { oilFlag: 1 }, function (signResult, signMode) {
        if (signResult.ok) {
          var point = recursiveFind(signResult.data, ["point", "score", "integral"]);
          log.push("签到：成功" + (typeof point !== "undefined" ? "，+" + point + " 积分" : "") + "（" + signMode + "）");
        } else {
          log.push("签到失败：" + (signResult.message || signResult.code));
        }
        continueTasks();
      });
    });

    function continueTasks() {
      fetchTasks(function (listResult, tasks, listMode) {
        if (!listResult.ok) {
          finish("任务列表失败：" + (listResult.message || listResult.code));
          return;
        }
        var point = recursiveFind(listResult.data, ["point", "myPoint", "integral"]);
        log.push("任务列表：" + tasks.length + " 项（" + listMode + "）" + (typeof point !== "undefined" ? "，当前 " + point + " 积分" : ""));
        claimRewards(tasks, function () {
          finishBrowseTasks(tasks, function () {
            fetchTasks(function (latestResult, latestTasks) {
              if (!latestResult.ok) {
                finish("任务：已领取 " + counters.rewarded + "，已尝试完成 " + counters.finished + "；刷新列表失败");
                return;
              }
              claimRewards(latestTasks, function () {
                finish(
                  "任务：完成 " + counters.finished + "，领取 " + counters.rewarded +
                  (counters.finishFailed || counters.rewardFailed ? "，失败 " + (counters.finishFailed + counters.rewardFailed) : "")
                );
              });
            });
          });
        });
      });
    }
  }

  function isRequestContext() {
    return typeof $request !== "undefined" && $request && typeof $request.url === "string" && $request.url.length > 0;
  }

  try {
    if (isRequestContext()) captureRequest();
    else runDaily();
  } catch (error) {
    var message = error && error.stack ? error.stack : String(error);
    debugLog("脚本异常：" + message);
    $notification.post("平安好车主", "脚本异常", String(error));
    if (isRequestContext()) $done({});
    else $done();
  }
})();
