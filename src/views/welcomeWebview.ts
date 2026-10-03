import * as vscode from 'vscode';
import * as crypto from 'crypto';

/**
 * Opens the CodeAtlas Welcome webview panel.
 * Primary purpose: direct users to the standalone browser UI on localhost.
 * Also shows quick-start steps and key commands.
 */
let currentPanel: vscode.WebviewPanel | undefined;
let browserPort: number = 7742;

export function setBrowserPort(port: number): void {
    browserPort = port;
}

export function openWelcomeWebview(context: vscode.ExtensionContext): void {
    if (currentPanel) {
        currentPanel.reveal(vscode.ViewColumn.One);
        return;
    }

    currentPanel = vscode.window.createWebviewPanel(
        'codeatlas.welcome',
        'CodeAtlas',
        vscode.ViewColumn.One,
        {
            enableScripts: true,
            retainContextWhenHidden: false,
        },
    );

    currentPanel.webview.html = getWelcomeHtml(currentPanel.webview);

    currentPanel.webview.onDidReceiveMessage((msg: { command: string }) => {
        if (msg.command) {
            vscode.commands.executeCommand(msg.command);
        }
    });

    currentPanel.onDidDispose(() => {
        currentPanel = undefined;
    });
}

function getWelcomeHtml(webview: vscode.Webview): string {
    const nonce = crypto.randomBytes(16).toString('hex');
    const url = `http://localhost:${browserPort}`;

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<style nonce="${nonce}">
:root {
  --bg: #0d1117; --bg2: #161b22; --bg3: #1a1e28;
  --text: #c9d1d9; --muted: #8b949e; --dim: #484f58;
  --accent: #7aa2f7; --teal: #73daca; --green: #4ec9b0;
  --font: 'Inter', 'SF Pro Display', system-ui, sans-serif;
}
* { margin: 0; padding: 0; box-sizing: border-box; }
body { background: var(--bg); color: var(--text); font-family: var(--font); padding: 32px; max-width: 700px; margin: 0 auto; line-height: 1.6; }
h1 { font-size: 28px; font-weight: 800; margin-bottom: 4px; }
h1 span { color: var(--accent); }
.subtitle { font-size: 14px; color: var(--muted); margin-bottom: 32px; }

/* Hero CTA */
.hero { background: var(--bg2); border: 1px solid var(--bg3); border-radius: 16px; padding: 32px; text-align: center; margin-bottom: 32px; }
.hero-title { font-size: 18px; font-weight: 700; margin-bottom: 8px; }
.hero-desc { font-size: 13px; color: var(--muted); margin-bottom: 20px; }
.hero-btn {
  display: inline-flex; align-items: center; gap: 10px;
  padding: 14px 32px; font-size: 15px; font-weight: 700;
  background: var(--accent); color: #0d1117; border: none; border-radius: 10px;
  cursor: pointer; transition: opacity 0.15s; text-decoration: none;
}
.hero-btn:hover { opacity: 0.9; }
.hero-url {
  margin-top: 12px; font-size: 12px; color: var(--muted);
  font-family: 'SF Mono', 'Fira Code', monospace;
  padding: 6px 14px; background: var(--bg); border-radius: 6px; display: inline-block;
  cursor: pointer; user-select: all;
}
.hero-url:hover { color: var(--accent); }
.hero-note { font-size: 11px; color: var(--dim); margin-top: 12px; }

/* Steps */
.steps { display: flex; gap: 12px; margin-bottom: 24px; }
.step { flex: 1; background: var(--bg2); border: 1px solid var(--bg3); border-radius: 12px; padding: 16px; cursor: pointer; transition: border-color 0.15s; }
.step:hover { border-color: var(--accent); }
.step-num { font-size: 11px; font-weight: 700; color: var(--accent); margin-bottom: 4px; }
.step-title { font-size: 13px; font-weight: 700; }
.step-desc { font-size: 11px; color: var(--muted); margin-top: 2px; }
.step-check { color: var(--green); }

/* Section */
h2 { font-size: 16px; font-weight: 700; margin: 24px 0 12px; color: var(--text); }

/* Features */
.features { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 24px; }
.feat { background: var(--bg2); border-radius: 10px; padding: 12px; }
.feat-title { font-size: 12px; font-weight: 700; margin-bottom: 2px; }
.feat-desc { font-size: 10px; color: var(--muted); }

.footer { margin-top: 32px; padding-top: 16px; border-top: 1px solid var(--bg3); font-size: 11px; color: var(--dim); text-align: center; }
.footer-link { cursor: pointer; color: var(--accent); }
.footer-link:hover { text-decoration: underline; }
[data-command] { cursor: pointer; }
</style>
</head>
<body>

<h1>Welcome to <span>CodeAtlas</span></h1>
<div class="subtitle">Zoomable architecture diagrams with live diff — like Google Maps for code</div>

<!-- Primary CTA: Open in Browser -->
<div class="hero">
  <div class="hero-title">View Diagrams in Your Browser</div>
  <div class="hero-desc">CodeAtlas renders your architecture diagrams in a standalone browser tab with full interactivity.</div>
  <button class="hero-btn" data-command="codeatlas.openInBrowser">
    Open CodeAtlas in Browser
  </button>
  <div class="hero-url" title="Click to copy">${url}</div>
  <div class="hero-note">Diagrams auto-initialize on extension load. Browser updates live when you save files.</div>
</div>

<!-- Quick Start -->
<h2>How It Works</h2>
<div class="steps">
  <div class="step">
    <div class="step-num"><span class="step-check">&#10003;</span> Automatic</div>
    <div class="step-title">Diagrams Build</div>
    <div class="step-desc">Extension scans your workspace on load</div>
  </div>
  <div class="step" data-command="codeatlas.openInBrowser">
    <div class="step-num">Step 1</div>
    <div class="step-title">Open Browser</div>
    <div class="step-desc">Click the button above or use the command palette &mdash; no sign-in required</div>
  </div>
</div>

<!-- Features -->
<h2>What You Get</h2>
<div class="features">
  <div class="feat"><div class="feat-title">L1 System Design</div><div class="feat-desc">Services, databases, caches, queues, inter-service edges</div></div>
  <div class="feat"><div class="feat-title">L2 Feature Areas + APIs</div><div class="feat-desc">Auto-detected clusters, 30+ framework APIs, mobile screens</div></div>
  <div class="feat"><div class="feat-title">L3 Sequence Diagrams</div><div class="feat-desc">Cross-file call flow with swimlane participants</div></div>
  <div class="feat"><div class="feat-title">L4 File + Class Diagrams</div><div class="feat-desc">Imports, functions, variables, class hierarchy</div></div>
  <div class="feat"><div class="feat-title">L5 Function Flow</div><div class="feat-desc">If/else diamonds, loops, try/catch branches</div></div>
  <div class="feat"><div class="feat-title">Live Diff</div><div class="feat-desc">3-channel colorblind-safe diff on every file save</div></div>
  <div class="feat"><div class="feat-title">Git Commit Diff</div><div class="feat-desc">Compare any two commits across all layers</div></div>
  <div class="feat"><div class="feat-title">Health Dashboard</div><div class="feat-desc">Dead code, god files, coupling, cycles</div></div>
</div>

<div class="footer">
  CodeAtlas &middot; Your code stays local &middot; Diagrams at <span class="footer-link" data-command="codeatlas.openInBrowser">${url}</span>
</div>

<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
document.addEventListener('click', function(e) {
    const el = e.target.closest('[data-command]');
    if (el) {
        vscode.postMessage({ command: el.getAttribute('data-command') });
    }
});
</script>
</body>
</html>`;
}
