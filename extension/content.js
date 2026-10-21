// Injected on demand (icon click / Alt+A). First injection starts bilingual translation;
// later injections toggle between bilingual and original-only views.
(() => {
  if (window.__minimalTranslate) {
    window.__minimalTranslate.toggle();
    return;
  }

  const MARK = "mt-tr";
  const MAX_BATCH_ITEMS = 16;
  const MAX_BATCH_CHARS = 3000;
  const SKIP_SELECTOR =
    "script,style,noscript,template,textarea,input,select,option,button,code,pre,kbd,samp,var," +
    "svg,math,canvas,iframe,[contenteditable=''],[contenteditable='true'],[translate='no'],.notranslate," +
    `.${MARK}`;
  const HAN = /\p{Script=Han}/gu;
  const LETTER = /\p{L}/u;

  const tracked = new WeakSet(); // blocks already queued, translated or failed
  const failed = new Set();
  const queue = [];
  let enabled = true;
  let flushTimer = 0;
  let lastError = "";

  const style = document.createElement("style");
  style.textContent = `
    .${MARK}{display:block;margin:.25em 0 0;opacity:.82;font-weight:inherit}
    .${MARK}.mt-inline{display:inline;margin:0 0 0 .5em}
    html.mt-off .${MARK}{display:none!important}
    #mt-toast{position:fixed;top:12px;right:12px;z-index:2147483647;max-width:360px;padding:10px 14px;
      border-radius:8px;background:#b42318;color:#fff;font:13px/1.4 system-ui,sans-serif;box-shadow:0 4px 16px #0003}`;
  document.documentElement.append(style);

  function toast(text) {
    let node = document.getElementById("mt-toast");
    if (!node) {
      node = document.createElement("div");
      node.id = "mt-toast";
      node.addEventListener("click", () => node.remove());
      document.documentElement.append(node);
    }
    node.textContent = text;
    clearTimeout(node.timer);
    node.timer = setTimeout(() => node.remove(), 8000);
  }

  const blockCache = new WeakMap();
  function nearestBlock(node) {
    for (let el = node.parentElement; el && el !== document.body; el = el.parentElement) {
      if (blockCache.has(el)) return blockCache.get(el);
      const display = getComputedStyle(el).display;
      if (display !== "inline" && display !== "contents" && display !== "inline-block") {
        blockCache.set(el, el);
        return el;
      }
    }
    return null;
  }

  function wantsTranslation(text) {
    if (text.length < 2 || !LETTER.test(text)) return false;
    const han = text.match(HAN)?.length ?? 0;
    return han / text.replace(/\s/g, "").length < 0.3; // already mostly Chinese
  }

  function scan(root) {
    const candidates = new Set();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) =>
        n.nodeValue.trim() && !n.parentElement?.closest(SKIP_SELECTOR) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT,
    });
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const block = nearestBlock(n);
      if (block && !tracked.has(block)) candidates.add(block);
    }
    for (const block of candidates) {
      // Prefer the innermost blocks so text is not translated twice.
      if ([...candidates].some((other) => other !== block && block.contains(other))) continue;
      tracked.add(block);
      visibility.observe(block);
    }
  }

  const visibility = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        visibility.unobserve(entry.target);
        const text = entry.target.innerText.trim();
        if (wantsTranslation(text)) queue.push({ block: entry.target, text });
      }
      if (queue.length) {
        clearTimeout(flushTimer);
        flushTimer = setTimeout(flush, 150);
      }
    },
    { rootMargin: "600px 0px" },
  );

  function insert(block, text, translation) {
    const node = document.createElement("font");
    node.className = MARK;
    if (text.length < 40 && !text.includes("\n")) node.classList.add("mt-inline");
    node.lang = "zh-CN";
    node.textContent = translation; // never parsed as HTML
    block.append(node);
  }

  async function send(batch) {
    let response;
    try {
      response = await chrome.runtime.sendMessage({ type: "translate", texts: batch.map((item) => item.text) });
    } catch (error) {
      response = { ok: false, error: String(error?.message ?? error) };
    }
    if (response?.ok) {
      batch.forEach((item, i) => item.block.isConnected && insert(item.block, item.text, response.translations[i]));
      return;
    }
    batch.forEach((item) => failed.add(item.block));
    const message = `翻译失败：${response?.error ?? "未知错误"}（修正后再按两次图标重试）`;
    if (message !== lastError) toast(message);
    lastError = message;
  }

  function flush() {
    while (queue.length) {
      const batch = [];
      let chars = 0;
      while (queue.length && batch.length < MAX_BATCH_ITEMS && (batch.length === 0 || chars + queue[0].text.length <= MAX_BATCH_CHARS)) {
        const item = queue.shift();
        chars += item.text.length;
        batch.push(item);
      }
      send(batch);
    }
  }

  let rescanTimer = 0;
  const mutations = new MutationObserver((records) => {
    if (!enabled) return;
    const added = records.some((r) => [...r.addedNodes].some((n) => !(n instanceof Element && n.classList.contains(MARK))));
    if (!added) return;
    clearTimeout(rescanTimer);
    rescanTimer = setTimeout(() => scan(document.body), 500);
  });

  function toggle() {
    enabled = !enabled;
    document.documentElement.classList.toggle("mt-off", !enabled);
    if (!enabled) return;
    lastError = "";
    for (const block of failed) visibility.observe(block);
    failed.clear();
    scan(document.body);
  }

  window.__minimalTranslate = { toggle };
  scan(document.body);
  mutations.observe(document.body, { childList: true, subtree: true });
})();
