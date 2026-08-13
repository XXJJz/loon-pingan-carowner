/*
 * 平安好车主 Loon 脚本 v1.0.6
 *
 * 安全边界：只保存并原样重放 App 自己产生的短时请求。脚本不会推算、
 * 生成、刷新或改写认证字段，也不会改写任务 ID。模板过期时联网前停止。
 */

(function () {
  "use strict";

  var SCRIPT_VERSION = "1.0.6";
  var STORE_PREFIX = "pingan_carowner.";
  var AUTO_HEADER = "X-Loon-Pingan-Auto";
  var ALLOWED_URL = /^https:\/\/hcz-member\.pingan\.com\.cn\/micro-api\/(?:activity-sign|activity-points-zone)\/gw\/(?:signCall|taskCall)\/(?:mainv1|toSign|taskMine|finish|reward|rewardBatch|refreshRecommend)(?:\?.*)?$/i;

  function debugLog(message) {
    console.log("[平安好车主] " + message);
  }

  function readJson(key, fallback) {
    var raw = $persistentStore.read(STORE_PREFIX + key);
    if (!raw) return fallback;
    try {
      return JSON.parse(raw);
    } catch (error) {
      return fallback;
    }
  }

  function writeJson(key, value) {
    return $persistentStore.write(JSON.stringify(value), STORE_PREFIX + key);
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

  function bodyFieldNames(body) {
    if (!body) return "无";
    try {
      var parsed = JSON.parse(body);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return Object.keys(parsed).sort().join("|") || "空对象";
      }
    } catch (error) {}
    var fields = [];
    String(body).split("&").forEach(function (pair) {
      var key = pair.split("=")[0];
      if (key && fields.indexOf(key) === -1) fields.push(key);
    });
    return fields.length ? fields.sort().join("|") : "非结构化";
  }

  function profileAgeSeconds(profile) {
    var captured = Date.parse((profile && profile.capturedAt) || "");
    return isFinite(captured) ? Math.max(0, Math.floor((Date.now() - captured) / 1000)) : Infinity;
  }

  function captureRequest() {
    var headers = cleanCapturedHeaders($request.headers || {});
    if (headerValue(headers, AUTO_HEADER) === "1") {
      $done({});
      return;
    }
    if (!ALLOWED_URL.test(String($request.url || ""))) {
      debugLog("忽略不在允许列表内的请求");
      $done({});
      return;
    }

    var action = actionFromUrl($request.url);
    var profile = {
      action: action,
      url: $request.url,
      method: String($request.method || "POST").toUpperCase(),
      headers: headers,
      body: typeof $request.body === "string" ? $request.body : "",
      capturedAt: new Date().toISOString()
    };
    writeJson("profile." + action, profile);

    var hasLocalAuth = Boolean(
      headerValue(headers, "access_token") ||
      headerValue(headers, "secret_token") ||
      headerValue(headers, "cookie")
    );
    debugLog("捕获请求：" + action + "；认证字段=" + (hasLocalAuth ? "已随模板保存" : "未发现") + "；请求体字段=" + bodyFieldNames(profile.body));

    var notified = readJson("capture_notified_v106", {});
    if (!notified[action]) {
      notified[action] = true;
      writeJson("capture_notified_v106", notified);
      $notification.post(
        "平安好车主 · 原请求已保存",
        action,
        "仅保存在 Loon 本地；超过设定有效期后不会重放。"
      );
    }
    $done({});
  }

  function getArgs() {
    var arg = typeof $argument === "object" && $argument ? $argument : {};
    var maxReplayAge = parseInt(arg.maxReplayAge, 10);
    if (!isFinite(maxReplayAge) || maxReplayAge < 10) maxReplayAge = 120;
    if (maxReplayAge > 300) maxReplayAge = 300;
    return { maxReplayAge: maxReplayAge };
  }

  function parseResponse(body, status) {
    var json;
    try {
      json = JSON.parse(body || "{}");
    } catch (error) {
      return { ok: false, code: status || -1, message: "响应不是 JSON", data: {} };
    }
    var code = typeof json.error_code !== "undefined" ? json.error_code : json.code;
    var ok = status >= 200 && status < 300 && (code === 0 || code === "0" || code === 100 || code === "100");
    return {
      ok: ok,
      code: typeof code === "undefined" ? status : code,
      message: json.msg || json.message || json.error_msg || json.errorMsg || json.responseMsg || json.retMsg || "",
      data: typeof json.data === "undefined" ? json : json.data
    };
  }

  function profileDiagnostic(action, maxAge) {
    var profile = readJson("profile." + action, null);
    if (!profile) {
      debugLog("模板 " + action + "：未抓到");
      return;
    }
    var age = profileAgeSeconds(profile);
    debugLog(
      "模板 " + action + "：距今 " + (isFinite(age) ? age + " 秒" : "未知") +
      "，" + (age <= maxAge ? "可重放" : "已过期") +
      "；请求体字段=" + bodyFieldNames(profile.body)
    );
  }

  function replayProfile(action, maxAge, callback) {
    var profile = readJson("profile." + action, null);
    if (!profile || !profile.url || typeof profile.body !== "string") {
      callback({ ok: false, code: -2, message: "没有 " + action + " 原请求模板" });
      return;
    }
    if (!ALLOWED_URL.test(String(profile.url)) || actionFromUrl(profile.url) !== action) {
      callback({ ok: false, code: -3, message: action + " 模板地址未通过允许列表" });
      return;
    }
    if (String(profile.method || "POST").toUpperCase() !== "POST") {
      callback({ ok: false, code: -3, message: action + " 模板请求方法不受支持" });
      return;
    }
    var age = profileAgeSeconds(profile);
    if (age > maxAge) {
      callback({ ok: false, code: -4, message: action + " 模板已过期（" + (isFinite(age) ? age + " 秒" : "时间未知") + "）" });
      return;
    }

    var headers = cleanCapturedHeaders(profile.headers || {});
    headers[AUTO_HEADER] = "1";
    $httpClient.post({
      url: profile.url,
      timeout: 15000,
      headers: headers,
      body: profile.body,
      "auto-cookie": false,
      alpn: "h2"
    }, function (error, response, body) {
      if (error) {
        debugLog("请求 " + action + " 失败：" + String(error));
        callback({ ok: false, code: -1, message: String(error) });
        return;
      }
      var result = parseResponse(body, response && response.status);
      debugLog(
        "请求 " + action + "：HTTP " + ((response && response.status) || "未知") +
        "，业务码 " + result.code + "，" + (result.ok ? "成功" : "失败")
      );
      callback(result);
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

  function runDaily() {
    var args = getArgs();
    var log = [];
    debugLog("v" + SCRIPT_VERSION + " 安全重放开始：模板有效期=" + args.maxReplayAge + " 秒");
    debugLog("安全策略：仅重放 App 原请求，不生成或改写认证字段");
    profileDiagnostic("mainv1", args.maxReplayAge);
    profileDiagnostic("toSign", args.maxReplayAge);
    profileDiagnostic("taskMine", args.maxReplayAge);

    if (!readJson("profile.mainv1", null) && !readJson("profile.taskMine", null)) {
      debugLog("停止：未找到原请求模板。请先在同一台 iPhone 上通过 Loon 打开签到页和任务中心。");
      $notification.post("平安好车主", "缺少原请求", "请先开启 Loon MITM，再在 App 进入签到页和任务中心。");
      $done();
      return;
    }

    function finish() {
      var summary = log.join("\n") || "没有可执行的新鲜模板";
      debugLog("执行结果：\n" + summary);
      $notification.post("平安好车主", "安全重放完成", summary);
      $done();
    }

    function fetchTasks() {
      replayProfile("taskMine", args.maxReplayAge, function (result) {
        if (!result.ok) {
          log.push("任务列表未执行/失败：" + (result.message || result.code));
          finish();
          return;
        }
        var tasks = uniqueTasks(result.data || {});
        var point = recursiveFind(result.data, ["point", "myPoint", "integral"]);
        log.push("任务列表：" + tasks.length + " 项" + (typeof point !== "undefined" ? "，当前 " + point + " 积分" : ""));
        log.push("任务执行与领奖：安全模式已跳过");
        finish();
      });
    }

    replayProfile("mainv1", args.maxReplayAge, function (homeResult) {
      if (!homeResult.ok) {
        log.push("签到首页未执行/失败：" + (homeResult.message || homeResult.code));
        fetchTasks();
        return;
      }
      var signed = Number(recursiveFind(homeResult.data, ["hadSign", "had_sign", "signStatus", "sign_status"])) === 1;
      if (signed) {
        log.push("签到：今天已签到");
        fetchTasks();
        return;
      }
      replayProfile("toSign", args.maxReplayAge, function (signResult) {
        if (signResult.ok) {
          var point = recursiveFind(signResult.data, ["point", "score", "integral"]);
          log.push("签到：原请求重放成功" + (typeof point !== "undefined" ? "，+" + point + " 积分" : ""));
        } else {
          log.push("签到未执行/失败：" + (signResult.message || signResult.code));
        }
        fetchTasks();
      });
    });
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
