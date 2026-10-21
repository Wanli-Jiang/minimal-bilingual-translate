# Minimal Bilingual Translate

[简体中文](README.zh-CN.md)

A small Chrome extension (about 40 KB, no build step, no dependencies) that uses **your own OpenAI-compatible LLM API** to:

- **Translate a web page bilingually**: each paragraph keeps its original text, with the Simplified Chinese translation shown under it. Click again to switch back to the original.
- **Translate a selection**: select text, then right-click → "翻译选中文字" or press **Alt+S**. The translation is shown in a small bubble next to the selection. Foreign text is translated into Simplified Chinese; Chinese text is translated into English.

It has only two settings: **LLM provider** (API URL + model) and **API key**. There are no accounts, analytics, remote configuration or cloud sync. The only network requests it makes go to the API URL you configure.

> The user interface is in Chinese. Page translation always targets Simplified Chinese.

| Page translation | Selection translation |
|---|---|
| ![Page translation](docs/screenshot-page.png) | ![Selection translation](docs/screenshot-selection.png) |

<sub>These screenshots come from the offline test suite. The "translations" are placeholders returned by the mock API.</sub>

## Install

The extension is not published in the Chrome Web Store. Load it as an unpacked extension (Chrome or another Chromium-based browser, version 116 or later):

1. Get the code. Either:
   - clone this repository, or
   - download `minimal-bilingual-translate-<version>.zip` from Releases and unzip it.

   Keep the folder in a **permanent location**. Chrome loads the extension from that folder every time it starts.
2. Open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and select the **`extension`** folder (the one that contains `manifest.json`).
4. Optional: pin the icon to the toolbar (puzzle icon → pin).

**Upgrading:** replace the files in the same `extension` folder, then click **Reload** on the extension's card in `chrome://extensions`. Your settings and key are kept, because an unpacked extension's ID is derived from its folder path.

## Configure

The first time you click the icon, the settings page opens. You can also open it later: right-click the icon → **Options**.

| Field | What to enter |
|---|---|
| 服务商 (Provider) | A preset, or 自定义 (Custom) |
| API 地址 (API URL) | An OpenAI-compatible base URL, up to `/v1` or the provider's root URL. `/chat/completions` is appended automatically. A full URL ending in `/chat/completions` also works. |
| 模型 (Model) | The model name, as given by your provider |
| API Key | Your key. It can be left empty for local servers that need no key. |

Presets:

| Preset | API URL | Default model |
|---|---|---|
| DeepSeek | `https://api.deepseek.com` | `deepseek-flash` |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` |
| OpenRouter | `https://openrouter.ai/api/v1` | (fill in) |
| Ollama (local) | `http://localhost:11434/v1` | (fill in) |

Any other endpoint that implements `POST /chat/completions` (vLLM, llama.cpp server, LM Studio, other providers) works through **Custom**.

Click **保存 (Save)**. Chrome then asks for permission to access **the host of your API URL only**; choose **Allow**. Click **测试连接 (Test connection)**: a success message and a Chinese sentence mean everything works.

Provider notes:

- **DeepSeek:** thinking mode is on by default for DeepSeek's V4 models. The extension turns it off for `api.deepseek.com` (`"thinking": {"type": "disabled"}`), because translation does not need it and it adds latency and output tokens. Other providers do not get this field.
- **Ollama:** Ollama rejects requests from extension origins unless it is started with `OLLAMA_ORIGINS=chrome-extension://*`.
- **Reasoning models:** `<think>…</think>` blocks and Markdown code fences in the reply are stripped before parsing.

## Use

| Action | How |
|---|---|
| Translate the page | Click the toolbar icon, or press **Alt+A** |
| Hide / show the translations | Click the icon again (or Alt+A) |
| Translate selected text | Right-click → 翻译选中文字, or press **Alt+S** |
| Close the bubble | 关闭 button, **Esc**, or click outside it. 复制 copies the translation. |

- Paragraphs are translated as they come near the viewport. Content the page adds later is also translated.
- Code blocks, form fields, editable areas, paragraphs that are already Chinese, and elements marked `translate="no"` or `.notranslate` are skipped.
- If a request fails, a red message appears at the top right (for example, `HTTP 401` means the key was rejected). After fixing the settings, click the icon twice to retry.
- **Shortcuts:** change them at `chrome://extensions/shortcuts`. If Alt+S does nothing after an upgrade, assign it there; Chrome does not always assign shortcuts that a new version adds. If another extension also uses Alt+A, give one of them a different key.
- Chrome does not allow extensions to run on `chrome://` pages or the Chrome Web Store.

## Privacy and permissions

| Permission | Why |
|---|---|
| `activeTab` + `scripting` | Inject the translator only into the tab where you click the icon, use the context menu or press a shortcut. Nothing runs on other pages. |
| `storage` | Store the settings and key in `chrome.storage.local` (not synced to your Google account) |
| `contextMenus` | The "翻译选中文字" menu item |
| Optional host permission | Requested for your API's host only, when you save or test the settings |

- The key is sent only as `Authorization: Bearer <key>` to the API URL you configured.
- The extension sends the page text it translates to that API. Choose a provider you trust with that content.
- The extension has no content scripts that run automatically, and requests no access to all websites.

## How it works

```
extension/
├── manifest.json   MV3 manifest
├── background.js   service worker: injects scripts on demand; the only fetch() call (to your API); cache and concurrency limit
├── content.js      page translation: finds text blocks, translates them lazily in batches, inserts translations
├── selection.js    selection bubble (Shadow DOM)
├── options.html/js settings page
└── icons/
```

- `content.js` walks the page's text nodes, groups them by their nearest block element, and queues blocks as an `IntersectionObserver` sees them approach the viewport. Batches hold up to 16 blocks / 3000 characters. A `MutationObserver` picks up content added later. Translations are inserted with `textContent` (never parsed as HTML) into `<font class="mt-tr">` elements. Toggling adds or removes a class on `<html>`.
- `background.js` sends each batch as a JSON array in the user message and asks the model for a JSON array of the same length. If the reply does not follow that format, each string is retried on its own. At most 4 requests run at a time, and up to 3000 translations are cached in memory, keyed by API URL, model, target language and text.
- The service worker accepts translation requests only from the extension's own scripts. Only the settings page can test a configuration that has not been saved yet; scripts running in web pages always use the saved one.

## Development

There is no build step: edit the files under `extension/` and click **Reload** in `chrome://extensions`.

### Tests

`test/run.sh` runs an offline end-to-end test (23 checks) in headless Chrome. It starts a mock OpenAI-compatible API (`test/mock_openai.py`) and a static test site (`test/site/`), then drives the browser through the Chrome DevTools Protocol. Its checks include page translation and toggling, lazy translation, selection translation, the fallback to per-string requests, error display, the settings page, provider-specific request fields, and that **no request leaves the machine**.

Requirements: Python 3, Node.js 22 or later (for the built-in `WebSocket`), and **Chrome for Testing or Chromium**. Branded Google Chrome 137 and later ignores `--load-extension`, so it cannot be used here.

```bash
# for example, with Chrome for Testing installed by Playwright:
test/run.sh ~/.cache/ms-playwright/chromium-*/chrome-linux64/chrome
```

Results and screenshots are written to `test/out/`. The script exits with 0 when all checks pass. Ports 18080 and 18081 on 127.0.0.1 must be free. The test launches Chrome with `--no-sandbox` so that it also works in containers. The tests use a mock API only; they do not test any real provider.

### Packaging

```bash
scripts/package.sh   # -> dist/minimal-bilingual-translate-<version>.zip and .sha256
```

### Icons

`tools/make_icons.py` renders `extension/icons/*.png` with Pillow and Noto Sans CJK: `python3 tools/make_icons.py extension/icons [font.ttc]`.

## Limitations

- The UI is Chinese only. Page translation always targets Simplified Chinese; selected Chinese text is always translated into English.
- Page translation does not enter iframes or Shadow DOM.
- When an element has both its own text and child paragraphs, the element's own text is not translated.
- Translation quality and speed depend on the model you choose.

## License

[MIT](LICENSE)
