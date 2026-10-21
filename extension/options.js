const PRESETS = [
  { id: "deepseek", name: "DeepSeek", apiUrl: "https://api.deepseek.com", model: "deepseek-flash" },
  { id: "openai", name: "OpenAI", apiUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" },
  { id: "openrouter", name: "OpenRouter", apiUrl: "https://openrouter.ai/api/v1", model: "" },
  { id: "ollama", name: "Ollama（本机）", apiUrl: "http://localhost:11434/v1", model: "" },
  { id: "custom", name: "自定义", apiUrl: "", model: "" },
];

const $ = (id) => document.getElementById(id);
const fields = { preset: $("preset"), apiUrl: $("apiUrl"), model: $("model"), apiKey: $("apiKey") };

function setStatus(text, kind = "") {
  $("status").textContent = text;
  $("status").className = kind;
}

function readForm() {
  return { apiUrl: fields.apiUrl.value.trim(), model: fields.model.value.trim(), apiKey: fields.apiKey.value.trim() };
}

function matchPreset(apiUrl) {
  return PRESETS.find((p) => p.apiUrl && p.apiUrl === apiUrl.replace(/\/+$/, ""))?.id ?? "custom";
}

// Host access is granted per API origin only, at the moment the user saves or tests.
function requestHostAccess(apiUrl) {
  let origin;
  try {
    const url = new URL(apiUrl);
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error();
    origin = `${url.protocol}//${url.hostname}/*`;
  } catch {
    return Promise.reject(new Error("API 地址不是有效的 http(s) 地址"));
  }
  return chrome.permissions.request({ origins: [origin] }).then((granted) => {
    if (!granted) throw new Error(`没有获得访问 ${origin} 的权限`);
  });
}

for (const preset of PRESETS) fields.preset.add(new Option(preset.name, preset.id));

fields.preset.addEventListener("change", () => {
  const preset = PRESETS.find((p) => p.id === fields.preset.value);
  if (preset.id === "custom") return;
  fields.apiUrl.value = preset.apiUrl;
  fields.model.value = preset.model;
  fields.model.placeholder = preset.model ? "" : "填写模型名";
});
fields.apiUrl.addEventListener("input", () => (fields.preset.value = matchPreset(fields.apiUrl.value)));

$("reveal").addEventListener("click", () => {
  const hidden = fields.apiKey.type === "password";
  fields.apiKey.type = hidden ? "text" : "password";
  $("reveal").textContent = hidden ? "隐藏" : "显示";
});

$("save").addEventListener("click", () => {
  const cfg = readForm();
  if (!cfg.apiUrl || !cfg.model) return setStatus("请填写 API 地址和模型", "err");
  requestHostAccess(cfg.apiUrl)
    .then(() => chrome.storage.local.set(cfg))
    .then(() => setStatus("已保存", "ok"))
    .catch((error) => setStatus(String(error.message ?? error), "err"));
});

$("test").addEventListener("click", () => {
  const cfg = readForm();
  if (!cfg.apiUrl || !cfg.model) return setStatus("请填写 API 地址和模型", "err");
  setStatus("测试中…");
  const started = performance.now();
  requestHostAccess(cfg.apiUrl)
    .then(() => chrome.runtime.sendMessage({ type: "translate", texts: ["The quick brown fox jumps over the lazy dog."], config: cfg }))
    .then((response) => {
      if (!response?.ok) throw new Error(response?.error ?? "未知错误");
      setStatus(`连接成功（${Math.round(performance.now() - started)} ms）：${response.translations[0]}`, "ok");
    })
    .catch((error) => setStatus(`连接失败：${error.message ?? error}`, "err"));
});

chrome.storage.local.get(["apiUrl", "model", "apiKey"]).then((saved) => {
  const initial = saved.apiUrl ? saved : PRESETS[0];
  fields.apiUrl.value = initial.apiUrl ?? "";
  fields.model.value = initial.model ?? "";
  fields.apiKey.value = saved.apiKey ?? "";
  fields.preset.value = matchPreset(fields.apiUrl.value);
});
