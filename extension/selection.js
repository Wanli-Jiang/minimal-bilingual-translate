// Injected on demand (context menu "翻译选中文字" / Alt+S). Shows the translation of the
// current selection in a bubble next to it. Chinese selections are translated into English.
(() => {
  if (window.__minimalSelection) return;

  const MAX_CHARS = 5000;
  const HAN = /\p{Script=Han}/gu;
  let host = null;

  function close() {
    host?.remove();
    host = null;
    document.removeEventListener("keydown", onKey, true);
    document.removeEventListener("mousedown", onOutside, true);
  }
  const onKey = (event) => event.key === "Escape" && close();
  const onOutside = (event) => host && !event.composedPath().includes(host) && close();

  function anchorRect() {
    const selection = window.getSelection();
    if (selection?.rangeCount) {
      const rect = selection.getRangeAt(0).getBoundingClientRect();
      if (rect.width || rect.height) return rect;
    }
    return { left: innerWidth / 2 - 200, right: innerWidth / 2 + 200, top: 80, bottom: 80 };
  }

  // Shadow DOM keeps page CSS out of the bubble and the bubble out of page translation.
  function open(rect) {
    close();
    host = document.createElement("div");
    host.id = "mt-selection";
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `
      <style>
        :host { all: initial; }
        .box { position: fixed; z-index: 2147483647; box-sizing: border-box; width: max-content; max-width: min(420px, calc(100vw - 16px));
          max-height: 50vh; overflow: auto; padding: 10px 12px; border-radius: 10px; border: 1px solid #d0d7de;
          background: #fff; color: #1f2328; font: 14px/1.55 system-ui, sans-serif; box-shadow: 0 6px 24px #0000002e; }
        .text { white-space: pre-wrap; word-break: break-word; }
        .muted { color: #656d76; }
        .error { color: #cf222e; }
        .bar { display: flex; gap: 6px; justify-content: flex-end; margin-top: 8px; }
        button { font: 12px system-ui, sans-serif; padding: 2px 10px; border-radius: 6px; border: 1px solid #d0d7de;
          background: transparent; color: inherit; cursor: pointer; }
        @media (prefers-color-scheme: dark) {
          .box { background: #161b22; color: #e6edf3; border-color: #30363d; }
          .muted { color: #9198a1; } .error { color: #f85149; } button { border-color: #30363d; }
        }
      </style>
      <div class="box" role="dialog" aria-label="划词翻译">
        <div class="text muted">翻译中…</div>
        <div class="bar"><button class="copy" hidden>复制</button><button class="close">关闭</button></div>
      </div>`;
    root.querySelector(".close").addEventListener("click", close);
    document.documentElement.append(host);
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("mousedown", onOutside, true);
    place(root.querySelector(".box"), rect);
    return root;
  }

  // Below the selection when it fits, otherwise above; always inside the viewport.
  function place(box, rect) {
    const { width, height } = box.getBoundingClientRect();
    const left = Math.min(Math.max(8, rect.left), innerWidth - width - 8);
    const below = rect.bottom + 8;
    const top = below + height <= innerHeight - 8 ? below : Math.max(8, rect.top - height - 8);
    box.style.left = `${left}px`;
    box.style.top = `${top}px`;
  }

  function render(root, rect, text, kind) {
    const node = root.querySelector(".text");
    node.className = `text ${kind}`;
    node.textContent = text; // never parsed as HTML
    place(root.querySelector(".box"), rect);
  }

  async function show(givenText) {
    const rect = anchorRect();
    const root = open(rect);
    let text = (givenText || window.getSelection()?.toString() || "").trim();
    if (!text) return render(root, rect, "请先选中要翻译的文字", "muted");
    if (text.length > MAX_CHARS) text = text.slice(0, MAX_CHARS);
    const han = text.match(HAN)?.length ?? 0;
    const target = han / text.replace(/\s/g, "").length >= 0.3 ? "en" : "zh";
    let response;
    try {
      response = await chrome.runtime.sendMessage({ type: "translate", texts: [text], target });
    } catch (error) {
      response = { ok: false, error: String(error?.message ?? error) };
    }
    if (!root.isConnected) return; // bubble was closed while waiting
    if (!response?.ok) return render(root, rect, `翻译失败：${response?.error ?? "未知错误"}`, "error");
    render(root, rect, response.translations[0], "");
    const copy = root.querySelector(".copy");
    copy.hidden = false;
    copy.addEventListener("click", () => navigator.clipboard.writeText(response.translations[0]).then(() => (copy.textContent = "已复制")));
  }

  window.__minimalSelection = { show };
})();
