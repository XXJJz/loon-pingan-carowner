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
  const auth = JSON.parse(store.values.get("pingan_carowner.auth"));
  if (auth.accessToken !== "token" || auth.aopsId !== "123") throw new Error("capture auth failed");
  if (auth.headers["Content-Length"]) throw new Error("unsafe header was not removed");
  if (!store.values.has("pingan_carowner.profile.mainv1")) throw new Error("profile missing");
  if (!notifications.length) throw new Error("capture notification missing");
  if (JSON.stringify(doneValue) !== "{}") throw new Error("request was not continued");
}

function runDailyTest() {
  const auth = JSON.stringify({ accessToken: "token", aopsId: "123", headers: { "User-Agent": "UA" } });
  const store = createStore({ "pingan_carowner.auth": auth });
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

runCaptureTest();
runDailyTest();
runNullRequestCronTest();
console.log("pingan_carowner tests passed");
