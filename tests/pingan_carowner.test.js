const fs = require("fs");
const path = require("path");
const vm = require("vm");
const crypto = require("crypto");

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
  const auth = JSON.parse(store.values.get("pingan_carowner.auth"));
  if (auth.accessToken !== "token" || auth.aopsId !== "123") throw new Error("capture auth failed");
  if (auth.headers["Content-Length"]) throw new Error("unsafe header was not removed");
  if (!store.values.has("pingan_carowner.profile.mainv1")) throw new Error("profile missing");
  if (!notifications.length) throw new Error("capture notification missing");
  if (JSON.stringify(doneValue) !== "{}") throw new Error("request was not continued");
}

function runDailyTest() {
  const auth = JSON.stringify({ accessToken: "token", aopsId: "123", headers: { "User-Agent": "UA" } });
  const mainProfile = JSON.stringify({
    capturedAt: new Date().toISOString(),
    headers: { access_token: "secret", "User-Agent": "UA" },
    body: JSON.stringify({ m_content_data: "cipher", m_content_type: "1" })
  });
  const store = createStore({ "pingan_carowner.auth": auth, "pingan_carowner.profile.mainv1": mainProfile });
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
    if (/mainv1$/.test(url)) return { code: 0, data: { hadSign: 0 } };
    if (/toSign$/.test(url)) return { code: 0, data: { point: 2 } };
    if (/taskMine$/.test(url)) return taskPayload;
    if (/finish$/.test(url)) return { code: 0, data: {} };
    if (/reward$/.test(url)) return { code: 0, data: { score: 2 } };
    return { code: 1, msg: "unexpected" };
  }
  vm.runInNewContext(source, {
    $argument: { city: "北京", autoFinish: true, autoReward: true, maxTasks: "5", replayFallback: false },
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
  if (!calls.some((call) => /toSign$/.test(call.url))) throw new Error("sign request missing");
  const finishBodies = calls.filter((call) => /\/finish$/.test(call.url)).map((call) => call.body);
  if (finishBodies.length !== 1 || !finishBodies[0].includes("safe")) throw new Error("safe task filter failed");
  if (finishBodies.some((body) => body.includes("blocked"))) throw new Error("blocked task was attempted");
  if (!calls.some((call) => /\/reward$/.test(call.url))) throw new Error("reward request missing");
  if (!notifications.some((entry) => entry[1] === "定时任务完成")) throw new Error("summary notification missing");
  if (!logs.some((line) => line.includes("定时任务开始"))) throw new Error("start diagnostic log missing");
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
  if (!notifications.some((entry) => entry[1] === "缺少凭据")) throw new Error("missing credential notification missing");
  if (!logs.some((line) => line.includes("未找到凭据"))) throw new Error("missing credential diagnostic log missing");
}

function runSignatureDiagnosticTest() {
  const agent = "A1B2C3D4E5F60708";
  const timestamp = "1667191396";
  const url = "https://hcz-member.pingan.com.cn/micro-api/activity-sign/gw/signCall/mainv1";
  const body = JSON.stringify({ "x-PA-NONCESTR": "00112233445566778899aabbccddeeff", city: "海口" });
  const pathname = "/micro-api/activity-sign/gw/signCall/mainv1";
  const bodyBase64 = Buffer.from(body, "utf8").toString("base64");
  const signature = crypto.createHash("sha256")
    .update("POST" + agent + pathname + bodyBase64 + timestamp + "ios", "utf8")
    .digest("hex")
    .toUpperCase();
  const profile = JSON.stringify({
    capturedAt: new Date().toISOString(),
    url,
    method: "POST",
    headers: {
      access_token: "credential-not-for-logs",
      "x-pa-agent": agent,
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
  let finished = false;
  vm.runInNewContext(source, {
    $argument: { city: "海口", autoFinish: false, autoReward: false, maxTasks: "0", replayFallback: false },
    $persistentStore: store.api,
    $notification: { post() {} },
    $httpClient: {
      post(options, callback) {
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
  if (!finished) throw new Error("signature diagnostic script did not finish");
  if (!logs.some((line) => line.includes("签名自检 mainv1：匹配 旧版顺序/x-pa-agent/完整路径/正文Base64/ios"))) {
    throw new Error("known SHA-256 signature formula was not detected");
  }
  if (!logs.some((line) => line.includes("签名自检 taskMine：未匹配（已测试"))) {
    throw new Error("unmatched signature diagnostic missing");
  }
  if (logs.some((line) => line.includes(agent) || line.includes(signature) || line.includes("00112233445566778899aabbccddeeff") || line.includes("private-device-value"))) {
    throw new Error("signature diagnostic leaked sensitive values");
  }
}

runCaptureTest();
runDailyTest();
runNullRequestCronTest();
runSignatureDiagnosticTest();
console.log("pingan_carowner tests passed");
