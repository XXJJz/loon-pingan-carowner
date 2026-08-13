const fs = require("fs");
const path = require("path");
const vm = require("vm");

const source = fs.readFileSync(path.join(__dirname, "..", "pingan_carowner.js"), "utf8");

function createStore(seed) {
  const values = new Map(Object.entries(seed || {}));
  return {
    values,
    api: {
      read(key) { return values.has(key) ? values.get(key) : null; },
      write(value, key) { values.set(key, value); return true; }
    }
  };
}

function runCaptureTest() {
  const store = createStore();
  const notifications = [];
  let doneValue;
  vm.runInNewContext(source, {
    $request: {
      url: "https://hcz-member.pingan.com.cn/micro-api/activity-sign/gw/signCall/mainv1",
      method: "POST",
      headers: { access_token: "token", aopsID: "123", "User-Agent": "UA", "Content-Length": "7" },
      body: "{\"x\":1}"
    },
    $persistentStore: store.api,
    $notification: { post() { notifications.push(Array.from(arguments)); } },
    $done(value) { doneValue = value; },
    console,
    Date,
    JSON,
    Object,
    String
  });
  const profile = JSON.parse(store.values.get("pingan_carowner.profile.mainv1"));
  if (profile.headers.access_token !== "token" || profile.headers.aopsID !== "123") throw new Error("capture profile failed");
  if (profile.headers["Content-Length"]) throw new Error("unsafe header was not removed");
  if (!notifications.length) throw new Error("capture notification missing");
  if (JSON.stringify(doneValue) !== "{}") throw new Error("request was not continued");
}

function runDailyTest() {
  const auth = JSON.stringify({ accessToken: "token", aopsId: "123", headers: { "User-Agent": "UA" } });
  const mainProfile = JSON.stringify({
    capturedAt: new Date().toISOString(),
    url: "https://hcz-member.pingan.com.cn/micro-api/activity-sign/gw/signCall/mainv1",
    method: "POST",
    headers: { access_token: "secret", "User-Agent": "UA" },
    body: JSON.stringify({ m_content_data: "cipher", m_content_type: "1" })
  });
  const taskProfile = JSON.stringify({
    capturedAt: new Date().toISOString(),
    url: "https://hcz-member.pingan.com.cn/micro-api/activity-points-zone/gw/taskCall/taskMine",
    method: "POST",
    headers: { access_token: "secret", "User-Agent": "UA" },
    body: JSON.stringify({ city: "北京" })
  });
  const store = createStore({
    "pingan_carowner.auth": auth,
    "pingan_carowner.profile.mainv1": mainProfile,
    "pingan_carowner.profile.taskMine": taskProfile
  });
  const calls = [];
  const notifications = [];
  const logs = [];
  let finished = false;
  const taskPayload = {
    code: 0,
    data: {
      point: 716,
      task_daily_list: [
        { task_id: "safe", title: "浏览一次成长计划", reward_status: 2 },
        { task_id: "blocked", title: "购买车险", reward_status: 2 },
        { task_id: "ready", title: "查看我的卡券", reward_status: 0 }
      ]
    }
  };
  function responseFor(url) {
    if (/mainv1$/.test(url)) return { code: 0, data: { hadSign: 1 } };
    if (/toSign$/.test(url)) return { code: 0, data: { point: 2 } };
    if (/taskMine$/.test(url)) return taskPayload;
    if (/finish$/.test(url)) return { code: 0, data: {} };
    if (/reward$/.test(url)) return { code: 0, data: { score: 2 } };
    return { code: 1, msg: "unexpected" };
  }
  vm.runInNewContext(source, {
    $argument: { maxReplayAge: "120" },
    $persistentStore: store.api,
    $notification: { post() { notifications.push(Array.from(arguments)); } },
    $httpClient: {
      post(options, callback) {
        calls.push(options);
        callback(null, { status: 200 }, JSON.stringify(responseFor(options.url)));
      }
    },
    $done() { finished = true; },
    console: { log(message) { logs.push(String(message)); } },
    Date,
    JSON,
    Object,
    String,
    Number,
    Array,
    RegExp,
    isFinite,
    parseInt
  });
  if (!finished) throw new Error("daily script did not finish");
  if (!calls.some((call) => /mainv1$/.test(call.url))) throw new Error("fresh main request was not replayed");
  if (!calls.some((call) => /taskMine$/.test(call.url))) throw new Error("fresh task request was not replayed");
  if (calls.some((call) => /\/(finish|reward)$/.test(call.url))) throw new Error("safe mode rewrote a task request");
  if (!notifications.some((entry) => entry[1] === "安全重放完成")) throw new Error("summary notification missing");
  if (!logs.some((line) => line.includes("安全重放开始"))) throw new Error("start diagnostic log missing");
  if (!logs.some((line) => line.includes("执行结果"))) throw new Error("result diagnostic log missing");
  if (!logs.some((line) => line.includes("请求体字段=m_content_data|m_content_type"))) throw new Error("profile shape diagnostic missing");
  if (logs.some((line) => line.includes("cipher") || line.includes("secret"))) throw new Error("diagnostic leaked credential values");
}

function runNullRequestCronTest() {
  const store = createStore();
  const notifications = [];
  const logs = [];
  let finished = false;
  vm.runInNewContext(source, {
    $request: null,
    $argument: { city: "北京" },
    $persistentStore: store.api,
    $notification: { post() { notifications.push(Array.from(arguments)); } },
    $httpClient: { post() { throw new Error("missing credentials should stop before HTTP"); } },
    $done() { finished = true; },
    console: { log(message) { logs.push(String(message)); } },
    Date,
    JSON,
    Object,
    String,
    Number,
    Array,
    RegExp,
    isFinite,
    parseInt
  });
  if (!finished) throw new Error("null-request cron did not finish");
  if (!notifications.some((entry) => entry[1] === "缺少原请求")) throw new Error("missing profile notification missing");
  if (!logs.some((line) => line.includes("未找到原请求模板"))) throw new Error("missing profile diagnostic log missing");
}

function runSafeReplayTest() {
  const agent = "APP";
  const timestamp = "1667191396";
  const url = "https://hcz-member.pingan.com.cn/micro-api/activity-sign/gw/signCall/mainv1";
  const body = JSON.stringify({ "x-PA-NONCESTR": "00112233445566778899aabbccddeeff", city: "海口" });
  const signature = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const profile = JSON.stringify({
    capturedAt: new Date().toISOString(),
    url,
    method: "POST",
    headers: {
      access_token: "credential-not-for-logs",
      "x-pa-agent": agent,
      "x-pa-sign-v": "v3",
      "x-pa-sign-alg": "1",
      "x-pa-timestamp": timestamp,
      "x-pa-sign": signature
    },
    body
  });
  const unmatchedProfile = JSON.stringify({
    capturedAt: new Date().toISOString(),
    url: "https://hcz-member.pingan.com.cn/micro-api/activity-points-zone/gw/taskCall/taskMine",
    method: "POST",
    headers: {
      access_token: "credential-not-for-logs",
      "x-pa-agent": "APP",
      "x-pa-sign-v": "2",
      "x-pa-sign-alg": "SHA256",
      "x-pa-version": "6.03.1",
      "x-pa-timestamp": timestamp,
      "x-pa-sign": "FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF"
    },
    body: JSON.stringify({ "x-PA-NONCESTR": "", city: "海口", spartaId: "private-device-value" })
  });
  const auth = JSON.stringify({ accessToken: "credential-not-for-logs", headers: {} });
  const store = createStore({
    "pingan_carowner.auth": auth,
    "pingan_carowner.profile.mainv1": profile,
    "pingan_carowner.profile.taskMine": unmatchedProfile
  });
  const logs = [];
  const calls = [];
  let finished = false;
  vm.runInNewContext(source, {
    $argument: { maxReplayAge: "120" },
    $persistentStore: store.api,
    $notification: { post() {} },
    $httpClient: {
      post(options, callback) {
        calls.push(options);
        if (/mainv1$/.test(options.url) && options.headers["x-pa-sign"] !== signature) {
          throw new Error("captured request was not replayed unchanged");
        }
        const payload = /mainv1$/.test(options.url)
          ? { code: 0, data: { hadSign: 1 } }
          : { code: 0, data: {} };
        callback(null, { status: 200 }, JSON.stringify(payload));
      }
    },
    $done() { finished = true; },
    console: { log(message) { logs.push(String(message)); } },
    Date,
    JSON,
    Object,
    String,
    Number,
    Array,
    RegExp,
    isFinite,
    parseInt
  });
  if (!finished) throw new Error("safe replay script did not finish");
  if (!calls.some((call) => /mainv1$/.test(call.url) && call.headers["x-pa-sign"] === signature)) {
    throw new Error("captured signed request was not replayed");
  }
  if (!logs.some((line) => line.includes("不生成或改写认证字段"))) throw new Error("safe-mode diagnostic missing");
  if (logs.some((line) => line.includes(agent) || line.includes(signature) || line.includes("00112233445566778899aabbccddeeff") || line.includes("private-device-value"))) {
    throw new Error("signature diagnostic leaked sensitive values");
  }
}

function runExpiredProfileTest() {
  const stale = JSON.stringify({
    capturedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    url: "https://hcz-member.pingan.com.cn/micro-api/activity-sign/gw/signCall/mainv1",
    method: "POST",
    headers: { "x-pa-sign": "private-signature" },
    body: "{}"
  });
  const store = createStore({ "pingan_carowner.profile.mainv1": stale });
  const logs = [];
  let calls = 0;
  let finished = false;
  vm.runInNewContext(source, {
    $argument: { maxReplayAge: "120" },
    $persistentStore: store.api,
    $notification: { post() {} },
    $httpClient: { post() { calls += 1; } },
    $done() { finished = true; },
    console: { log(message) { logs.push(String(message)); } },
    Date,
    JSON,
    Object,
    String,
    Number,
    Array,
    RegExp,
    isFinite,
    parseInt
  });
  if (!finished) throw new Error("expired-profile script did not finish");
  if (calls !== 0) throw new Error("expired profile reached the network");
  if (!logs.some((line) => line.includes("模板已过期"))) throw new Error("expired profile diagnostic missing");
  if (logs.some((line) => line.includes("private-signature"))) throw new Error("expired profile leaked a credential");
}

runCaptureTest();
runDailyTest();
runNullRequestCronTest();
runSafeReplayTest();
runExpiredProfileTest();
console.log("pingan_carowner tests passed");
