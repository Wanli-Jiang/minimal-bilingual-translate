// Service worker: injects the page or selection translator when the user asks (icon, context
// menu, shortcuts) and calls the configured OpenAI-compatible chat completions endpoint.
// Nothing else leaves the browser.

// Pages are translated into Chinese; selected Chinese text is translated into English.
const TARGET_LANGUAGES = { zh: "Simplified Chinese (zh-CN)", en: "English" };
const systemPrompt = (target) =>
  `You are a translation engine. Translate every string in the user's JSON array into ${TARGET_LANGUAGES[target]}. ` +
  "Reply with ONLY a JSON array of strings: same length, same order, one translation per input string. " +
  "Keep URLs, code, numbers and names that are normally left untranslated as they are. " +
  "If a string is already in the target language, return it unchanged.";
const SELECTION_MENU_ID = "translate-selection";
const REQUEST_TIMEOUT_MS = 90_000;
const MAX_CONCURRENT_REQUESTS = 4;
const CACHE_LIMIT = 3000;
// Provider-specific request fields, keyed by API hostname. DeepSeek V4 thinks by default,
// which only adds latency and output tokens to translation.
const PROVIDER_EXTRAS = {
  "api.deepseek.com": { thinking: { type: "disabled" } },
};

const cache = new Map(); // `${apiUrl}\n${model}\n${target}\n${text}` -> translation (insertion-ordered for eviction)
let active = 0;
const waiting = [];

async function getConfig() {
  const { apiUrl = "", model = "", apiKey = "" } = await chrome.storage.local.get(["apiUrl", "model", "apiKey"]);
  return { apiUrl: apiUrl.trim(), model: model.trim(), apiKey: apiKey.trim() };
}

function endpointOf(apiUrl) {
  const url = apiUrl.replace(/\/+$/, "");
  return /\/chat\/completions$/.test(url) ? url : `${url}/chat/completions`;
}

async function withSlot(task) {
  if (active >= MAX_CONCURRENT_REQUESTS) await new Promise((resolve) => waiting.push(resolve));
  active++;
  try {
    return await task();
  } finally {
    active--;
    waiting.shift()?.();
  }
}

// Model replies may carry reasoning blocks or Markdown fences around the JSON array.
function parseArray(content, length) {
  if (typeof content !== "string") return null;
  const text = content.replace(/<think>[\s\S]*?<\/think>/g, "");
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end <= start) return null;
  try {
    const value = JSON.parse(text.slice(start, end + 1));
    return Array.isArray(value) && value.length === length && value.every((v) => typeof v === "string") ? value : null;
  } catch {
    return null;
  }
}

function buildRequest(texts, cfg, target = "zh") {
  const endpoint = endpointOf(cfg.apiUrl);
  return {
    endpoint,
    body: {
      model: cfg.model,
      messages: [
        { role: "system", content: systemPrompt(target) },
        { role: "user", content: JSON.stringify(texts) },
      ],
      ...PROVIDER_EXTRAS[new URL(endpoint).hostname],
    },
  };
}
globalThis.buildRequest = buildRequest; // inspected by the automated test

async function complete(texts, cfg, target) {
  const { endpoint, body } = buildRequest(texts, cfg, target);
  const response = await withSlot(() =>
    fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }),
  );
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 200);
    throw new Error(`HTTP ${response.status} ${detail}`.trim());
  }
  const data = await response.json();
  return data?.choices?.[0]?.message?.content;
}

async function translateUncached(texts, cfg, target) {
  const content = await complete(texts, cfg, target);
  const parsed = parseArray(content, texts.length);
  if (parsed) return parsed;
  if (texts.length === 1) {
    const plain = String(content ?? "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
    if (!plain) throw new Error("接口返回了空内容");
    return [plain];
  }
  // The model broke the array contract: retry each string on its own.
  return Promise.all(texts.map((text) => translateUncached([text], cfg, target).then(([t]) => t)));
}

async function translate(texts, cfg, target) {
  if (!cfg.apiUrl || !cfg.model) throw new Error("还没有配置 API 地址和模型");
  const keyOf = (text) => `${cfg.apiUrl}\n${cfg.model}\n${target}\n${text}`;
  const missing = [...new Set(texts.filter((text) => !cache.has(keyOf(text))))];
  if (missing.length > 0) {
    const results = await translateUncached(missing, cfg, target);
    missing.forEach((text, i) => cache.set(keyOf(text), results[i]));
    while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
  }
  return texts.map((text) => cache.get(keyOf(text)));
}

async function configured() {
  const cfg = await getConfig();
  if (cfg.apiUrl && cfg.model) return true;
  await chrome.runtime.openOptionsPage();
  return false;
}

async function translateTab(tab) {
  if (!(await configured())) return;
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
}

// selectionText comes from the context menu; the shortcut lets the page read its own selection.
async function translateSelection(tab, selectionText = "", frameId = 0) {
  if (!(await configured())) return;
  const run = async (target) => {
    await chrome.scripting.executeScript({ target, files: ["selection.js"] });
    await chrome.scripting.executeScript({ target, func: (text) => window.__minimalSelection.show(text), args: [selectionText] });
  };
  try {
    await run({ tabId: tab.id, frameIds: [frameId] });
  } catch (error) {
    // activeTab does not cover cross-origin iframes; show the bubble in the top frame instead.
    if (frameId === 0 || !selectionText) throw error;
    await run({ tabId: tab.id, frameIds: [0] });
  }
}
globalThis.translateTab = translateTab; // both are also used by the automated test
globalThis.translateSelection = translateSelection;

const report = (what) => (error) => console.warn(`${what} failed:`, error);

chrome.action.onClicked.addListener((tab) => translateTab(tab).catch(report("translate tab")));

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === "translate-selection" && tab) translateSelection(tab).catch(report("translate selection"));
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() =>
    chrome.contextMenus.create({ id: SELECTION_MENU_ID, title: "翻译选中文字", contexts: ["selection"] }),
  );
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === SELECTION_MENU_ID && tab) {
    translateSelection(tab, info.selectionText, info.frameId ?? 0).catch(report("translate selection"));
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "translate" || sender.id !== chrome.runtime.id) return false;
  // Only the options page may test an unsaved configuration; pages always use the saved one.
  const fromOptions = sender.url === chrome.runtime.getURL("options.html");
  const cfgPromise = fromOptions && message.config ? Promise.resolve(message.config) : getConfig();
  const target = message.target === "en" ? "en" : "zh";
  cfgPromise
    .then((cfg) => translate(message.texts, cfg, target))
    .then((translations) => sendResponse({ ok: true, translations }))
    .catch((error) => sendResponse({ ok: false, error: String(error?.message ?? error) }));
  return true;
});
