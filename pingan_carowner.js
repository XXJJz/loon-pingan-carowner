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

  var STORE_PREFIX = "pingan_carowner.";
  var AUTO_HEADER = "X-Loon-Pingan-Auto";
  var SIGN_BASE = "https://hcz-member.pingan.com.cn/micro-api/activity-sign";
  var TASK_BASE = "https://hcz-member.pingan.com.cn/micro-api/activity-points-zone";

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

  function captureRequest() {
    var headers = cleanCapturedHeaders($request.headers || {});
    if (headerValue(headers, AUTO_HEADER) === "1") {
      $done({});
      return;
    }

    var action = actionFromUrl($request.url);
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
      message: json.msg || json.message || json.error_msg || "",
      data: typeof json.data === "undefined" ? json : json.data,
      raw: json
    };
  }

  function postRaw(options, callback) {
    $httpClient.post(options, function (error, response, body) {
      if (error) {
        callback({ ok: false, code: -1, message: String(error) });
        return;
      }
      callback(parseResponse(body, response && response.status));
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
        callback(result, "token");
        return;
      }
      replayProfile(action, function (fallbackResult) {
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

    if (!auth || !(auth.accessToken || auth.secretToken)) {
      $notification.post("平安好车主", "缺少凭据", "请先开启 Loon MITM，再在平安好车主 App 进入签到页和任务中心。");
      $done();
      return;
    }

    function finish(summary) {
      log.push(summary);
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

  if (typeof $request !== "undefined") captureRequest();
  else runDaily();
})();
