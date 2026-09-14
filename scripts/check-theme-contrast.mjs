#!/usr/bin/env node
/** Render production UI fixtures in an isolated Chrome and check actual CSS contrast.
 * Usage: node scripts/check-theme-contrast.mjs [--fixture name] [--screenshots /tmp/directory] [--report /tmp/report.json]
 * CHROME_BIN may select an existing Chrome/Chromium executable. No downloads or app API calls.
 */
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createServer } from "vite";

const projectRoot = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
let fixtureFilter = "";
let screenshotDirectory;
let reportPath;
for (let index = 0; index < args.length; index++) {
  const option = args[index];
  const value = args[++index];
  if (!value || !["--fixture", "--screenshots", "--report"].includes(option)) {
    throw new Error("Usage: node scripts/check-theme-contrast.mjs [--fixture name] [--screenshots directory] [--report file.json]");
  }
  if (option === "--fixture") fixtureFilter = value.toLowerCase();
  else if (option === "--screenshots") screenshotDirectory = resolve(value);
  else reportPath = resolve(value);
}

const pause = (milliseconds) => new Promise((resolvePause) => setTimeout(resolvePause, milliseconds));
async function chromeExecutable() {
  const candidates = process.env.CHROME_BIN ? [process.env.CHROME_BIN] : [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser",
  ];
  for (const candidate of candidates) {
    try { await access(candidate, constants.X_OK); return candidate; } catch { /* Try the next installed browser. */ }
  }
  throw new Error("Chrome was not found. Set CHROME_BIN to an installed Chrome or Chromium executable.");
}

class ChromeProtocol {
  nextId = 1;
  pending = new Map();
  constructor(socket) {
    this.socket = socket;
    socket.addEventListener("message", ({ data }) => {
      const message = JSON.parse(String(data));
      const request = this.pending.get(message.id);
      if (!request) return;
      this.pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.error) request.reject(new Error(message.error.message));
      else request.resolve(message.result);
    });
    socket.addEventListener("close", () => {
      for (const request of this.pending.values()) {
        clearTimeout(request.timer);
        request.reject(new Error("Chrome debugging connection closed."));
      }
      this.pending.clear();
    });
  }
  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolveOpen, reject) => {
      const timeout = setTimeout(() => { socket.close(); reject(new Error("Chrome connection timed out.")); }, 15_000);
      socket.addEventListener("open", () => { clearTimeout(timeout); resolveOpen(); }, { once: true });
      socket.addEventListener("error", () => { clearTimeout(timeout); reject(new Error("Cannot connect to Chrome.")); }, { once: true });
    });
    return new ChromeProtocol(socket);
  }
  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolveRequest, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Chrome command timed out: ${method}`));
      }, 20_000);
      this.pending.set(id, { resolve: resolveRequest, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  }
}

const previewHtml = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' ws://127.0.0.1:*; font-src 'self' data:;">
<title>ShelfSend theme contrast audit</title></head><body><div id="fixture"></div><script type="module">
import '/client/src/styles.css';
import '/client/src/library-modern.css';
import '/client/src/library-health.css';
import '/client/src/library-transfer-modern.css';
import '/client/src/library-ux-polish.css';
import '/client/src/hardcover-series.css';
import { themeContrastFixtures } from '/tests/fixtures/theme-contrast.ts';
window.__themeFixturesReady = Promise.resolve(themeContrastFixtures()).then(fixtures => {
  window.__themeFixtures = fixtures;
  return fixtures.map(({name}, index) => ({name, index}));
});
window.__renderThemeFixture = async (index, theme) => {
  document.documentElement.style.colorScheme = theme;
  document.getElementById('fixture').innerHTML = window.__themeFixtures[index].html;
  // Include collapsed settings, diagnostics, menus and technical details in the audit.
  document.querySelectorAll('details').forEach(element => { element.open = true; });
  document.querySelectorAll('.settings-provider-body[hidden]').forEach(element => { element.hidden = false; });
  // Contrast describes stable UI states, not intermediate transition frames.
  const stableStyles = document.createElement('style');
  stableStyles.textContent = '#fixture *, #fixture *::before, #fixture *::after { transition: none !important; animation: none !important; }';
  document.getElementById('fixture').append(stableStyles);
  await document.fonts.ready;
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
};
</script></body></html>`;

// Runs inside Chrome. Resolve CSS colors there, not with an incomplete CSS parser.
function auditRenderedText(includeBrokenImageAlt = true) {
  const root = document.getElementById("fixture");
  const results = [];
  const skipped = { invisible: 0, artwork: 0 };
  const parseColor = (value) => {
    const numbers = value.match(/[\d.]+/g)?.map(Number);
    if (!numbers || numbers.length < 3) throw new Error(`Unsupported computed color: ${value}`);
    return [...numbers.slice(0, 3).map(number => number / 255), numbers[3] ?? 1];
  };
  const over = (front, back) => {
    const alpha = front[3] + back[3] * (1 - front[3]);
    if (!alpha) return [0, 0, 0, 0];
    return [0, 1, 2].map(index => (front[index] * front[3] + back[index] * back[3] * (1 - front[3])) / alpha).concat(alpha);
  };
  const luminance = (color) => color.slice(0, 3).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4)
    .reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
  const hex = color => `#${color.slice(0, 3).map(value => Math.round(value * 255).toString(16).padStart(2, "0")).join("")}`;
  const selector = element => {
    const pieces = [];
    for (let current = element; current && current !== root && pieces.length < 3; current = current.parentElement) {
      pieces.unshift(current.localName + (current.id ? `#${current.id}` : [...current.classList].slice(0, 3).map(name => `.${name}`).join("")));
    }
    return pieces.join(" > ");
  };
  const check = (element, text, pseudo = null) => {
    if (!text.trim()) return;
    if (!element.getClientRects().length || element.closest("[hidden], .sr-only, svg, script, style, template, option, optgroup")) { skipped.invisible++; return; }
    const style = getComputedStyle(element, pseudo);
    let foreground = parseColor(style.color);
    let background = [0, 0, 0, 0];
    let disabled = Boolean(element.closest(":disabled, [aria-disabled='true']"));
    if (pseudo) foreground[3] *= Number(style.opacity);
    for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) {
      const ancestorStyle = getComputedStyle(ancestor);
      const opacity = Number(ancestorStyle.opacity);
      if (ancestorStyle.display === "none" || ancestorStyle.visibility !== "visible" || opacity === 0) { skipped.invisible++; return; }
      // A display:contents element has no painted box, even when its computed
      // style retains a background from an older layout rule.
      if (ancestorStyle.display === "contents") continue;
      const realCoverImage = ancestor.matches(".library-cover, .book-details-cover")
        && [...ancestor.querySelectorAll("img")].some(image => image.complete && image.naturalWidth > 0);
      if (ancestor.matches("[data-contrast-ignore]") || realCoverImage || ancestorStyle.backgroundImage !== "none") { skipped.artwork++; return; }
      const surface = parseColor(ancestorStyle.backgroundColor);
      foreground = over(foreground, surface);
      background = over(background, surface);
      foreground[3] *= opacity;
      background[3] *= opacity;
    }
    const canvas = document.documentElement.style.colorScheme === "dark" ? [0, 0, 0, 1] : [1, 1, 1, 1];
    foreground = over(foreground, canvas);
    background = over(background, canvas);
    const bright = luminance(foreground);
    const dark = luminance(background);
    const ratio = (Math.max(bright, dark) + .05) / (Math.min(bright, dark) + .05);
    const size = parseFloat(style.fontSize);
    const weight = Number(style.fontWeight) || (style.fontWeight === "bold" ? 700 : 400);
    const minimum = size >= 24 || (size >= 18.6667 && weight >= 700) ? 3 : 4.5;
    results.push({ selector: selector(element) + (pseudo ?? ""), text: text.trim().replace(/\s+/g, " ").slice(0, 130), foreground: hex(foreground), background: hex(background), ratio: Number(ratio.toFixed(3)), minimum, disabled, pass: ratio + .001 >= minimum });
  };
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (node.parentElement) check(node.parentElement, node.textContent ?? "");
  }
  for (const element of root.querySelectorAll("input, textarea, select")) {
    if (element.matches("input[type='hidden'], input[type='checkbox'], input[type='radio'], input[type='range'], input[type='file']")) continue;
    const value = element instanceof HTMLSelectElement ? element.selectedOptions[0]?.textContent ?? "" : element.value;
    if (value) check(element, element.type === "password" ? "••••••••" : value);
    else if (element.placeholder) check(element, element.placeholder, "::placeholder");
  }
  // A failed image can paint its alt text directly inside the image box. Check
  // that fallback only; image/cover pixels themselves are not text contrast.
  if (includeBrokenImageAlt) {
    for (const image of root.querySelectorAll("img[alt]")) {
      if (image.complete && image.naturalWidth === 0) check(image, image.alt);
    }
  }
  return { results, skipped };
}

let server;
let chrome;
let profileDirectory;
let protocol;
let cleanupPromise;
function cleanup() {
  if (cleanupPromise) return cleanupPromise;
  cleanupPromise = (async () => {
    protocol?.socket.close();
    if (chrome && chrome.exitCode === null && chrome.signalCode === null) {
      chrome.kill("SIGTERM");
      await Promise.race([new Promise(resolveExit => chrome.once("exit", resolveExit)), pause(3_000)]);
      if (chrome.exitCode === null && chrome.signalCode === null) {
        chrome.kill("SIGKILL");
        await Promise.race([new Promise(resolveExit => chrome.once("exit", resolveExit)), pause(2_000)]);
      }
    }
    await server?.close();
    // This is the exact private directory returned by mkdtemp, never user input.
    if (profileDirectory) await rm(profileDirectory, { recursive: true, force: true });
  })();
  return cleanupPromise;
}
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { void cleanup().finally(() => process.exit(130)); });

try {
  const executable = await chromeExecutable();
  server = await createServer({
    configFile: false, root: projectRoot, appType: "custom", logLevel: "error",
    server: { host: "127.0.0.1", port: 0, strictPort: false, fs: { allow: [projectRoot] }, hmr: false },
    plugins: [{ name: "theme-contrast-preview", configureServer(vite) {
      vite.middlewares.use((request, response, next) => {
        if (request.url !== "/") return next();
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        response.end(previewHtml);
      });
    } }],
  });
  await server.listen();
  const previewAddress = server.httpServer.address();
  if (!previewAddress || typeof previewAddress === "string") throw new Error("Cannot determine preview port.");
  profileDirectory = await mkdtemp(join(tmpdir(), "shelfsend-contrast-chrome-"));
  chrome = spawn(executable, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profileDirectory}`, "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-component-update", "--disable-sync", "--disable-extensions", "--disable-dev-shm-usage", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  let chromeError = "";
  chrome.stderr.on("data", data => { chromeError = (chromeError + String(data)).slice(-4_000); });
  chrome.on("error", error => { chromeError = error.message; });
  let debuggingPort;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { debuggingPort = Number((await readFile(join(profileDirectory, "DevToolsActivePort"), "utf8")).split("\n")[0]); if (debuggingPort) break; } catch { /* Chrome is still starting. */ }
    if (chrome.exitCode !== null) throw new Error(`Chrome exited before startup: ${chromeError}`);
    await pause(200);
  }
  if (!debuggingPort) throw new Error(`Chrome did not start: ${chromeError}`);
  const targetResponse = await fetch(`http://127.0.0.1:${debuggingPort}/json/new?about:blank`, { method: "PUT", signal: AbortSignal.timeout(10_000) });
  if (!targetResponse.ok) throw new Error(`Cannot create audit tab: ${targetResponse.status}`);
  protocol = await ChromeProtocol.connect((await targetResponse.json()).webSocketDebuggerUrl);
  await Promise.all([protocol.send("Page.enable"), protocol.send("Runtime.enable"), protocol.send("DOM.enable")]);
  await protocol.send("CSS.enable");
  await protocol.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
  await protocol.send("Page.navigate", { url: `http://127.0.0.1:${previewAddress.port}/` });
  let fixtures;
  for (let attempt = 0; attempt < 100; attempt++) {
    fixtures = await protocol.evaluate("window.__themeFixturesReady ? window.__themeFixturesReady : null");
    if (fixtures) break;
    await pause(100);
  }
  if (!fixtures) throw new Error("Theme fixture module did not load.");
  fixtures = fixtures.filter(fixture => fixture.name.toLowerCase().includes(fixtureFilter));
  if (!fixtures.length) throw new Error(`No fixture matched ${JSON.stringify(fixtureFilter)}.`);
  if (screenshotDirectory) await mkdir(screenshotDirectory, { recursive: true });
  let checked = 0;
  const failures = new Map();
  const disabledAdvisories = new Map();
  for (const theme of ["light", "dark"]) {
    await protocol.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }, { name: "prefers-reduced-motion", value: "reduce" }] });
    for (const fixture of fixtures) {
      await protocol.evaluate(`window.__renderThemeFixture(${fixture.index}, ${JSON.stringify(theme)})`);
      const document = await protocol.send("DOM.getDocument");
      const controls = await protocol.send("DOM.querySelectorAll", { nodeId: document.root.nodeId, selector: "#fixture button, #fixture input, #fixture textarea, #fixture select, #fixture summary, #fixture a[href], #fixture [role='button']" });
      let fixtureFailures = 0;
      let fixtureChecked = 0;
      for (const state of ["default", "hover", "focus-visible"]) {
        if (state !== "default") await Promise.all(controls.nodeIds.map(nodeId => protocol.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: state === "hover" ? ["hover"] : ["focus", "focus-visible"] })));
        await protocol.evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
        const audit = await protocol.evaluate(`(${auditRenderedText.toString()})()`);
        checked += audit.results.length;
        fixtureChecked += audit.results.length;
        for (const finding of audit.results) {
          if (finding.pass) continue;
          const key = JSON.stringify([fixture.name, theme, finding.selector, finding.text, finding.foreground, finding.background]);
          const collection = finding.disabled ? disabledAdvisories : failures;
          const existing = collection.get(key);
          if (existing) {
            if (!existing.states.includes(state)) existing.states.push(state);
          } else collection.set(key, { fixture: fixture.name, theme, states: [state], ...finding });
          if (!finding.disabled) fixtureFailures++;
        }
        if (state !== "default") {
          await Promise.all(controls.nodeIds.map(nodeId => protocol.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: [] })));
          await protocol.evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
        }
      }
      console.log(`${theme.padEnd(5)} ${fixture.name}: ${fixtureChecked} text checks, ${fixtureFailures} failing state checks`);
      if (screenshotDirectory) {
        const capture = await protocol.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
        const filename = `${String(fixture.index + 1).padStart(2, "0")}-${fixture.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-${theme}.png`;
        await writeFile(join(screenshotDirectory, filename), Buffer.from(capture.data, "base64"));
      }
    }
  }
  const printGroupedFindings = (collection) => {
    const groups = new Map();
    for (const finding of collection.values()) {
      const key = JSON.stringify([finding.theme, finding.selector, finding.text, finding.foreground, finding.background, finding.minimum]);
      const group = groups.get(key);
      if (group) {
        group.fixtures.add(finding.fixture);
        for (const state of finding.states) group.states.add(state);
      } else groups.set(key, { ...finding, fixtures: new Set([finding.fixture]), states: new Set(finding.states) });
    }
    for (const finding of groups.values()) {
      const names = [...finding.fixtures];
      const label = names.slice(0, 2).join(", ") + (names.length > 2 ? ` (+${names.length - 2} fixtures)` : "");
      console.log(`  ${finding.theme} / ${label} / ${[...finding.states].join(", ")}\n    ${finding.selector}\n    ${JSON.stringify(finding.text)}: ${finding.foreground} on ${finding.background} = ${finding.ratio.toFixed(2)}:1 (needs ${finding.minimum}:1)`);
    }
  };
  console.log(`\n${checked} text/state checks; ${failures.size} unique contrast failures; ${disabledAdvisories.size} disabled-control advisories.`);
  if (failures.size) { console.log("Contrast failures (identical findings grouped across fixtures):"); printGroupedFindings(failures); }
  if (disabledAdvisories.size) { console.log("Disabled controls (advisory only):"); printGroupedFindings(disabledAdvisories); }
  if (reportPath) {
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, JSON.stringify({ checked, fixtures: fixtures.map(({ name }) => name), failures: [...failures.values()], disabledAdvisories: [...disabledAdvisories.values()] }, null, 2) + "\n");
    console.log(`Full report: ${reportPath}`);
  }
  if (screenshotDirectory) console.log(`Screenshots: ${screenshotDirectory}`);
  process.exitCode = failures.size ? 1 : 0;
} catch (error) {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
} finally {
  await cleanup();
}
