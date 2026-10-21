// End-to-end test of the minimal extension in headless Chromium, fully offline.
// usage: node cdp_test.mjs <chrome> <extDir> <outJson>   (normally started by run.sh)
// Needs mock_openai.py on 127.0.0.1:18080 and site/ served on 127.0.0.1:18081.
// Screenshots are written next to <outJson>.
import { spawn } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const [chrome, extSource, outJson] = process.argv.slice(2);
const work = mkdtempSync(join(tmpdir(), "mt-test-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Test-only copy: pre-grant 127.0.0.1 so no permission prompt is needed (the real build asks per API origin).
const extDir = join(work, "ext");
cpSync(extSource, extDir, { recursive: true });
const manifest = JSON.parse(readFileSync(join(extDir, "manifest.json"), "utf8"));
manifest.host_permissions = ["http://127.0.0.1/*"];
writeFileSync(join(extDir, "manifest.json"), JSON.stringify(manifest));

const proc = spawn(chrome, [
  "--headless=new", "--no-sandbox", "--no-first-run", "--no-default-browser-check", "--disable-gpu",
  `--user-data-dir=${join(work, "profile")}`, "--remote-debugging-port=0", "--window-size=1280,800",
  `--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`,
  "--proxy-server=direct://", // ignore HTTPS_PROXY so the resolver rules below really cut the network
  "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost",
  "about:blank",
], { stdio: ["ignore", "ignore", "pipe"] });

const wsUrl = await new Promise((resolve, reject) => {
  let buf = "";
  proc.stderr.on("data", (d) => {
    buf += d;
    const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
    if (m) resolve(m[1]);
  });
  setTimeout(() => reject(new Error("chrome did not start")), 20000);
});

const ws = new WebSocket(wsUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let nextId = 1;
const pending = new Map();
const sessions = new Map(); // sessionId -> {type, url}
const requests = [];
const send = (method, params = {}, sessionId) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });

ws.addEventListener("message", ({ data }) => {
  const msg = JSON.parse(data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    return;
  }
  const { method, params, sessionId } = msg;
  if (method === "Target.attachedToTarget") {
    sessions.set(params.sessionId, { type: params.targetInfo.type, url: params.targetInfo.url });
    send("Network.enable", {}, params.sessionId).catch(() => {});
    send("Runtime.runIfWaitingForDebugger", {}, params.sessionId).catch(() => {});
  } else if (method === "Network.requestWillBeSent") {
    requests.push({ url: params.request.url, target: sessions.get(sessionId)?.type });
  }
});

await send("Target.setDiscoverTargets", { discover: true });
await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
const attachAll = async () => {
  const { targetInfos } = await send("Target.getTargets");
  for (const t of targetInfos) {
    if (t.attached || !["service_worker", "page"].includes(t.type)) continue;
    try { await send("Target.attachToTarget", { targetId: t.targetId, flatten: true }); } catch {}
  }
  return targetInfos;
};
const sessionFor = async (predicate) => {
  for (let i = 0; i < 40; i++) {
    const infos = await attachAll();
    for (const [sid, s] of sessions) {
      const info = infos.find((t) => t.url === s.url) ?? s;
      if (predicate({ ...s, url: info.url })) return sid;
    }
    await sleep(250);
  }
  throw new Error("target not found");
};
const evalIn = async (sid, expression, userGesture = false) => {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture }, sid);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result?.value;
};

const shotDir = dirname(outJson);
const shoot = async (sid, name) => {
  const { data } = await send("Page.captureScreenshot", { format: "png" }, sid);
  writeFileSync(join(shotDir, name), Buffer.from(data, "base64"));
};

const checks = [];
const check = (name, ok, detail) => {
  checks.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail === undefined ? "" : `  ${JSON.stringify(detail)}`}`);
};

const pageState = `(() => {
  const tr = (id) => document.getElementById(id)?.querySelector('.mt-tr')?.textContent ?? null;
  const all = [...document.querySelectorAll('.mt-tr')];
  return {
    translated: all.length,
    visible: all.filter((n) => n.offsetParent !== null).length,
    off: document.documentElement.classList.contains('mt-off'),
    h1: document.querySelector('h1 .mt-tr')?.textContent ?? null,
    mixed: tr('mixed'), li1: tr('li1'), dynamic: tr('dynamic'), last: tr('last'),
    code: document.querySelector('#code .mt-tr') !== null, zh: tr('zh'), skip: tr('skip'), edit: tr('edit'),
    toast: document.getElementById('mt-toast')?.textContent ?? null,
  };
})()`;

const result = { checks };
try {
  // Chromium ships component extensions with their own background.js; pick ours by manifest name.
  let sw;
  for (let i = 0; i < 40 && !sw; i++) {
    await attachAll();
    for (const [sid, s] of sessions) {
      if (s.type !== "service_worker") continue;
      const name = await evalIn(sid, "chrome.runtime.getManifest().name").catch(() => null);
      if (name === manifest.name) sw = sid;
    }
    if (!sw) await sleep(250);
  }
  if (!sw) throw new Error("extension service worker not found");
  const extId = new URL(sessions.get(sw).url).host;
  for (let i = 0; i < 40 && !(await evalIn(sw, "typeof chrome.storage?.local === 'object' && typeof translateTab === 'function'")); i++) await sleep(250);
  const setConfig = (apiUrl) =>
    evalIn(sw, `chrome.storage.local.set(${JSON.stringify({ apiUrl, model: "mock", apiKey: "test-key" })}).then(() => true)`);
  const openAndTranslate = async (query) => {
    const url = `http://127.0.0.1:18081/index.html?${query}`;
    await send("Target.createTarget", { url });
    const page = await sessionFor((s) => s.type === "page" && s.url === url);
    await sleep(2000); // let the page's own script add #dynamic
    const click = () => evalIn(sw, `chrome.tabs.query({url: ${JSON.stringify(url)}}).then(([tab]) => translateTab(tab)).then(() => true)`);
    await click();
    return { page, click };
  };

  // 1. Normal mode: bilingual output, lazy loading, skips, toggling.
  await setConfig("http://127.0.0.1:18080/v1");
  const normal = await openAndTranslate("normal");
  await sleep(3000);
  const first = await evalIn(normal.page, pageState);
  await shoot(normal.page, "screenshot-page.png");
  check("heading and mixed inline paragraph translated", first.h1 && first.mixed?.startsWith("【译】Lighthouses use a Fresnel lens"), { h1: first.h1, mixed: first.mixed });
  check("list item translated inline", first.li1 === "【译】Automated lights");
  check("content added later by the page is translated", first.dynamic?.startsWith("【译】This paragraph"));
  check("code, Chinese, .notranslate and contenteditable skipped", !first.code && !first.zh && !first.skip && !first.edit);
  // 800px viewport + 600px preload margin covers roughly half of the 67 text blocks.
  check("only paragraphs near the viewport translated first", first.translated < 50 && first.last === null, { translated: first.translated });
  await evalIn(normal.page, "window.scrollTo(0, document.body.scrollHeight)");
  await sleep(2500);
  const scrolled = await evalIn(normal.page, pageState);
  check("scrolling translates the rest", scrolled.last?.startsWith("【译】The final") && scrolled.translated > first.translated, { before: first.translated, after: scrolled.translated });
  await normal.click();
  const off = await evalIn(normal.page, pageState);
  check("second click hides translations", off.off && off.visible === 0);
  await normal.click();
  const on = await evalIn(normal.page, pageState);
  check("third click shows them again", !on.off && on.visible > 0);

  // 1b. Selection translation. The Alt+S path reads the page selection; the context-menu path passes the text.
  const selUrl = "http://127.0.0.1:18081/index.html?selection";
  await send("Target.createTarget", { url: selUrl });
  const selPage = await sessionFor((s) => s.type === "page" && s.url === selUrl);
  await sleep(500);
  const translateSel = (text) =>
    evalIn(sw, `chrome.tabs.query({url: ${JSON.stringify(selUrl)}}).then(([tab]) => translateSelection(tab, ${JSON.stringify(text)}, 0)).then(() => true)`);
  const bubble = `(() => {
    const host = document.getElementById('mt-selection');
    if (!host) return null;
    const r = host.shadowRoot.querySelector('.box').getBoundingClientRect();
    return { text: host.shadowRoot.querySelector('.text').textContent, copy: !host.shadowRoot.querySelector('.copy').hidden,
      inView: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight, inBody: document.body.contains(host),
      pageTranslations: document.querySelectorAll('.mt-tr').length };
  })()`;
  await evalIn(selPage, "{ const r = document.createRange(); r.selectNodeContents(document.getElementById('mixed')); getSelection().removeAllRanges(); getSelection().addRange(r); true }");
  await translateSel("");
  const selEn = await evalIn(selPage, bubble);
  check("Alt+S: selected English shown in a Chinese bubble next to it", selEn?.text.startsWith("【译】Lighthouses use a Fresnel lens") && selEn.copy && selEn.inView, selEn);
  check("selection bubble lives outside the page body and does not trigger page translation", selEn && !selEn.inBody && selEn.pageTranslations === 0);
  await evalIn(selPage, "document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape'})); true");
  check("Escape closes the bubble", (await evalIn(selPage, bubble)) === null);
  await translateSel("这一段已经是中文了，不应该再被翻译。");
  const selZh = await evalIn(selPage, bubble);
  check("context menu: selected Chinese is translated into English", selZh?.text === "[EN]这一段已经是中文了，不应该再被翻译。", selZh?.text);
  await shoot(selPage, "screenshot-selection.png");
  await evalIn(selPage, "getSelection().removeAllRanges(); true");
  await translateSel("");
  const menu = await evalIn(sw, "chrome.contextMenus.update('translate-selection', {}).then(() => 'registered', (e) => String(e))");
  check("context menu item is registered", menu === "registered", menu);
  check("Alt+S without a selection shows a hint", (await evalIn(selPage, bubble))?.text === "请先选中要翻译的文字");

  // 2. Model breaks the JSON-array contract: per-item fallback still fills every paragraph.
  await setConfig("http://127.0.0.1:18080/bad/v1");
  const bad = await openAndTranslate("bad");
  await sleep(4000);
  const badState = await evalIn(bad.page, pageState);
  check("non-JSON batch reply falls back to per-item requests", badState.h1 === "【译】The quiet history of lighthouses" && badState.translated > 5, { translated: badState.translated });

  // 3. Rejected key: user sees an error toast, nothing is inserted.
  await setConfig("http://127.0.0.1:18080/deny/v1");
  const deny = await openAndTranslate("deny");
  await sleep(2500);
  const denyState = await evalIn(deny.page, pageState);
  check("HTTP 401 shows an error toast", denyState.toast?.includes("HTTP 401") && denyState.translated === 0, { toast: denyState.toast });

  // 4. Options page: loads saved values and the test button reaches the API.
  await setConfig("http://127.0.0.1:18080/v1");
  await send("Target.createTarget", { url: `chrome-extension://${extId}/options.html` });
  const options = await sessionFor((s) => s.type === "page" && s.url.endsWith("/options.html"));
  await sleep(800);
  const form = await evalIn(options, `({apiUrl: apiUrl.value, model: model.value, key: apiKey.value.length, keyType: apiKey.type, preset: preset.value,
    inputs: document.querySelectorAll('input,select').length})`);
  check("options show only provider (preset, URL, model) and API key", form.inputs === 4 && form.apiUrl.endsWith("/v1") && form.keyType === "password", form);
  await evalIn(options, "document.getElementById('test').click()", true);
  await sleep(1500);
  await shoot(options, "screenshot-options.png");
  const status = await evalIn(options, "document.getElementById('status').textContent");
  check("test-connection button succeeds", status.startsWith("连接成功"), status);
  await evalIn(options, "preset.value = 'openai'; preset.dispatchEvent(new Event('change')); [apiUrl.value, model.value]").then((v) =>
    check("OpenAI preset fills URL and model", v[0] === "https://api.openai.com/v1" && v[1] === "gpt-4o-mini", v));
  await evalIn(options, "preset.value = 'deepseek'; preset.dispatchEvent(new Event('change')); [apiUrl.value, model.value]").then((v) =>
    check("DeepSeek preset fills URL and model", v[0] === "https://api.deepseek.com" && v[1] === "deepseek-flash", v));

  // 5. Provider-specific request fields: DeepSeek gets thinking disabled, nobody else gets the field.
  const deepseek = await evalIn(sw, `buildRequest(["x"], {apiUrl: "https://api.deepseek.com", model: "deepseek-flash"})`);
  check("DeepSeek request goes to /chat/completions with thinking disabled",
    deepseek.endpoint === "https://api.deepseek.com/chat/completions" && deepseek.body.thinking?.type === "disabled", deepseek.endpoint);
  const others = await evalIn(sw, `["https://api.openai.com/v1", "https://openrouter.ai/api/v1", "http://127.0.0.1:18080/v1"]
    .map((apiUrl) => buildRequest(["x"], {apiUrl, model: "m"}).body).filter((b) => "thinking" in b).length`);
  check("other providers' requests carry no thinking field", others === 0);

  // 6. Network: the extension and test pages talked to nothing but the two local servers.
  const external = requests.filter((r) => !/^(https?:\/\/(127\.0\.0\.1|localhost)[:/]|chrome-extension:|data:|about:)/.test(r.url));
  check("no request left the machine", external.length === 0, external.slice(0, 5));
} catch (error) {
  check("test harness", false, String(error));
}

result.passed = checks.filter((c) => c.ok).length;
result.failed = checks.filter((c) => !c.ok).length;
result.requests = requests.length;
writeFileSync(outJson, JSON.stringify(result, null, 2));
ws.close();
proc.kill("SIGTERM");
await sleep(1000);
rmSync(work, { recursive: true, force: true });
console.log(`${result.passed} passed, ${result.failed} failed -> ${outJson}`);
process.exit(result.failed ? 1 : 0);
