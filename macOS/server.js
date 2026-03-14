import express from 'express';
import { WebSocketServer } from 'ws';
import http from 'http';
import os from 'os';
import WebSocket from 'ws';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';
import { execSync, execFileSync, spawnSync, spawn } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// --- State ---
let cdpTargets = [];
let activeTargetUrl = null;        // Persistent lock: survives target list refresh
let lastFullText = '';             // Used to detect new lines (diff-based append)
let targetCount = 0;
const bridgeStartTime = Date.now();

// ─── CDP Discovery ────────────────────────────────────────────────────────────
async function refreshTargets() {
    return new Promise((resolve) => {
        http.get('http://127.0.0.1:9222/json/list', (r) => {
            let d = '';
            r.on('data', c => d += c);
            r.on('end', () => {
                try {
                    const all = JSON.parse(d).filter(t => t.webSocketDebuggerUrl && !t.url.includes('extension'));
                    cdpTargets = all;
                    targetCount = all.length;

                    // Persistent lock: keep activeTargetUrl if the target still exists
                    if (activeTargetUrl && !cdpTargets.find(t => t.webSocketDebuggerUrl === activeTargetUrl)) {
                        // Previously locked target is gone — fall back to best guess
                        activeTargetUrl = null;
                    }
                    resolve(true);
                } catch (e) { resolve(false); }
            });
        }).on('error', () => resolve(false)).end();
    });
}

// ─── Choose Active Target ─────────────────────────────────────────────────────
// Prefer the 'Agent Manager' window: a workbench with no open file tab in its title.
// Clean:   "OnPoint — Antigravity"           (ends with " — Antigravity")
// Dirty:   "OnPoint — Antigravity — file.js" (has content after last " — Antigravity")
//          "Antigravity — server.js"          (starts with Antigravity but has file suffix)
function isAgentManagerWindow(t) {
    if (!t.url.includes('workbench.html')) return false;
    const title = (t.title || '').trim();
    if (!title || title.startsWith('vscode-file://')) return false;
    // A clean manager window title ends with exactly " — Antigravity" or is just "Antigravity"
    if (title === 'Antigravity') return true;
    if (title.endsWith(' - Antigravity') || title.endsWith(' — Antigravity')) return true;
    // Anything else has an open file in the title
    return false;
}

function pickTarget() {
    if (activeTargetUrl) {
        return cdpTargets.find(t => t.webSocketDebuggerUrl === activeTargetUrl) || null;
    }
    return pickManagerTarget() || cdpTargets.find(t => t.url.includes('workbench.html')) || null;
}

// Always returns the cleanest workbench window (Agent Manager / main chat window)
function pickManagerTarget() {
    // 1. Prefer a window that looks like 'WorkspaceName - Antigravity' (no file tab)
    const clean = cdpTargets.find(t => isAgentManagerWindow(t));
    if (clean) return clean;
    // 2. Fallback: any workbench page that isn't Launchpad
    return cdpTargets.find(t => t.url.includes('workbench.html') && !t.title.includes('Launchpad')) || null;
}

// ─── Stream Loop ──────────────────────────────────────────────────────────────
// Persistent single CDP WebSocket — avoids saturating Antigravity's connection limit.
// One connection stays open; we re-evaluate every 2s rather than open/close each tick.
let cdpWs = null;
let cdpConnectedUrl = null;
let cdpPendingEval = false;
let skipPollWhileSending = false;  // pause stream during send (DOM in flux)
let lastWinningSelector = null;    // cache the selector that matched last tick

// Build the stream script dynamically so we can try a cached selector first
function buildStreamScript(cachedSelector) {
    const cachedTry = cachedSelector ? `
        // Try cached winning selector first (avoids iterating all selectors every tick)
        try {
            const cached = document.querySelector(${JSON.stringify(cachedSelector)});
            if (cached && cached.innerText && cached.innerText.trim().length > 80) {
                cached.scrollTop = cached.scrollHeight;
                return { text: cached.innerText, title: document.title || 'Antigravity', source: 'cached:${cachedSelector}' };
            }
        } catch(_){}
    ` : '';

    return `(() => {
    try {
        ${cachedTry}
        // Priority 1: Antigravity AI chat/agent side panel — live conversation
        const chatSelectors = [
            '.antigravity-agent-side-panel',
            '.bg-ide-chat-background',
            '[class*="aideditorsidepanel"]',
            '[class*="aide-chat"]',
            '[class*="chat-panel"]',
            '[class*="ChatView"]',
            '[class*="chatViewContainer"]',
            '[class*="conversation"]',
            '[class*="copilot"]',
            '[id*="chat"]',
            'div[data-keybinding-context] [class*="chat"]',
        ];
        for (const sel of chatSelectors) {
            try {
                const el = document.querySelector(sel);
                if (el && el.innerText && el.innerText.trim().length > 80) {
                    el.scrollTop = el.scrollHeight;
                    return { text: el.innerText, title: document.title || 'Antigravity', source: 'chat:' + sel };
                }
            } catch(_){}
        }
        // Priority 2: jetski custom editor pane (Antigravity-specific)
        const editorPane = document.querySelector('.jetski-custom-editor-pane');
        if (editorPane && editorPane.innerText.length > 100) {
            return { text: editorPane.innerText, title: document.title || 'Antigravity', source: 'editor' };
        }
        // Fallback: full body text
        window.scrollTo(0, document.body.scrollHeight);
        return { text: document.body.innerText || '', title: document.title || 'Antigravity', source: 'body' };
    } catch(e) { return { text: '', title: 'Antigravity', source: 'error:'+e.message }; }
})()`;
}

function connectCDP(wsUrl) {
    if (cdpWs) { try { cdpWs.terminate(); } catch (_) {} cdpWs = null; }
    cdpConnectedUrl = wsUrl;
    cdpPendingEval = false;

    const ws = new WebSocket(wsUrl);
    cdpWs = ws;

    ws.on('open', () => { cdpPendingEval = false; });

    ws.on('message', (raw) => {
        cdpPendingEval = false;
        try {
            const data = JSON.parse(raw);
            if (data.id !== 1) return;

            const val = data?.result?.result?.value;
            if (!val) return;

            const newText = val.text || '';
            const title = val.title || 'OnPoint';

            // Cache the winning selector so next tick tries it first
            const src = val.source || '';
            if (src.startsWith('chat:')) lastWinningSelector = src.slice(5);
            else if (src.startsWith('cached:')) { /* already cached, keep it */ }
            else lastWinningSelector = null; // editor/body fallback — don't cache

            let delta = '';
            if (newText.startsWith(lastFullText)) {
                delta = newText.slice(lastFullText.length).trimStart();
            } else {
                delta = null;
            }
            lastFullText = newText;

            const payload = delta === null
                ? { type: 'reset', text: newText, title }
                : { type: 'append', text: delta, title };

            wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(JSON.stringify(payload)); });
        } catch (_) {}
    });

    ws.on('error', () => { cdpWs = null; cdpConnectedUrl = null; cdpPendingEval = false; });
    ws.on('close', () => { if (cdpWs === ws) { cdpWs = null; cdpConnectedUrl = null; cdpPendingEval = false; } });
}

async function stream() {
    // Skip polling when no clients are connected (saves CPU when bridge UI is closed)
    if (wss.clients.size === 0) return;
    // Skip polling while a send is in-flight (DOM is in flux, innerText is unreliable)
    if (skipPollWhileSending) return;

    await refreshTargets();
    const target = pickTarget();
    if (!target) return;

    if (!activeTargetUrl) activeTargetUrl = target.webSocketDebuggerUrl;
    const wsUrl = target.webSocketDebuggerUrl;

    if (!cdpWs || cdpWs.readyState !== WebSocket.OPEN || cdpConnectedUrl !== wsUrl) {
        connectCDP(wsUrl);
        return;
    }

    if (cdpPendingEval) return;
    cdpPendingEval = true;
    const script = buildStreamScript(lastWinningSelector);
    cdpWs.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: script, returnByValue: true } }));
    setTimeout(() => { cdpPendingEval = false; }, 3000); // safety reset
}

// ── Auth-state detection helpers ─────────────────────────────────────────────
function detectAuthState(text) {
    if (!text || text.length < 10) return { authenticated: false, reason: 'empty screen' };
    if (/sign in|log in|unauthenticated|authentication required|please sign in/i.test(text)) {
        return { authenticated: false, reason: 'auth required' };
    }
    if (/onboarding|installing extensions/i.test(text)) {
        return { authenticated: false, reason: 'onboarding' };
    }
    return { authenticated: true };
}

// ── Send via pbcopy + osascript (OS-level clipboard paste) ───────────────────────
// This is the ONLY reliable way to inject text into VS Code / Electron React inputs.
// Input.insertText only works on native <input>/<textarea>, not Monaco contenteditable.
const PBCOPY_BIN   = '/usr/bin/pbcopy';
const OSASCRIPT_BIN = '/usr/bin/osascript';

function xdotoolSend(text) {
    return new Promise((resolve) => {
        try {
            // Get all window names of the Electron process (Antigravity on Mac)
            const winResult = spawnSync(OSASCRIPT_BIN, ['-e', 'tell application "System Events" to get name of every window of process "Electron"'], {
                encoding: 'utf8', timeout: 3000,
            });
            const winNames = (winResult.stdout || '').trim().split(', ');
            if (!winNames.length || winNames[0] === '') throw new Error('No Antigravity windows found by osascript search');

            // Find the best window:
            let targetTitle = null;

            // Get title of active CDP target so we can match it
            const activeTarget = cdpTargets.find(t => t.webSocketDebuggerUrl === activeTargetUrl);
            const activeTitle  = activeTarget?.title || '';

            for (const title of winNames) {
                // Skip tiny helper processes or undefined
                if (!title || title === 'missing value') continue;

                // Prefer the window that matches our active CDP target title
                if (activeTitle && title.includes(activeTitle.replace(/ (?:-|—) Antigravity.*$/, '').trim())) {
                    targetTitle = title;
                    break;
                }

                // Otherwise take the first real window found (not a generic modal)
                if (!targetTitle) targetTitle = title;
            }

            if (!targetTitle) throw new Error('No valid Antigravity window found');

            // Focus the window first so keystrokes land in the right place
            spawnSync(OSASCRIPT_BIN, ['-e', `
                tell application "System Events"
                    tell process "Electron"
                        set frontmost to true
                        perform action "AXRaise" of window "${targetTitle}"
                    end tell
                end tell
            `], { encoding: 'utf8', timeout: 3000 });
            
            // Write to clipboard
            spawnSync(PBCOPY_BIN, [], {
                input: text, encoding: 'utf8', timeout: 3000,
            });
            
            // Paste (Cmd+V) and Return
            spawnSync(OSASCRIPT_BIN, ['-e', `
                tell application "System Events"
                    delay 0.1
                    keystroke "v" using command down
                    delay 0.05
                    key code 36
                end tell
            `], { encoding: 'utf8', timeout: 3000 });

            resolve({ success: true, method: 'pbcopy-paste', title: targetTitle });
        } catch (e) {
            resolve({ success: false, error: e.message, method: 'osascript-type' });
        }
    });
}

// Adaptive polling: 3s when clients are present, essentially free when none are connected.
// The stream() function itself guards against polling with 0 clients.
setInterval(stream, 3000);

// ── Director-specific send ────────────────────────────────────────────────────
// Uses CDP to get the chat input bounding box, clicks precisely on the input
// (though CDP + JS handles focus better without coordinate clicking on Mac).
// Falls back to Cmd+L to focus the chat input in Antigravity.
async function directorSend(text, chatWsUrl) {
    // Find the right window name (title-based)
    const winResult = spawnSync(OSASCRIPT_BIN, ['-e', 'tell application "System Events" to get name of every window of process "Electron"'], {
        encoding: 'utf8', timeout: 3000,
    });
    const winNames = (winResult.stdout || '').trim().split(', ').filter(n => n && n !== 'missing value');
    if (!winNames.length) return { success: false, error: 'No real Antigravity windows found' };

    let targetTitle = null;
    if (chatWsUrl) {
        const cdpTarget = cdpTargets.find(t => t.webSocketDebuggerUrl === chatWsUrl);
        if (cdpTarget) {
            const cleanTitle = (cdpTarget.title || '').replace(/ (?:-|—) Antigravity.*$/, '').trim();
            targetTitle = winNames.find(w => w.includes(cleanTitle));
        }
    }
    if (!targetTitle) targetTitle = winNames[0];

    console.log(`[/director] osascript window: "${targetTitle}"`);

    try {
        // We'll skip absolute clicking on Mac for now, as Antigravity usually focuses
        // the input if we just use the Cmd+L hotkey to focus chat.
        // Or we can rely on CDP to focus it directly before we paste.
        if (chatWsUrl) {
           try {
               const FOCUS_SCRIPT = `(() => {
                   const SELS = ['.inputarea','[contenteditable="true"]','textarea','.chat-input textarea'];
                   for (const sel of SELS) {
                       const el = document.querySelector(sel);
                       if (el && el.getBoundingClientRect().height > 5) {
                           el.focus();
                           return true;
                       }
                   }
                   return false;
               })()`;
               await new Promise((res) => {
                   const ws = new WebSocket(chatWsUrl);
                   const t = setTimeout(() => { ws.close(); res(null); }, 2000);
                   ws.on('open', () => ws.send(JSON.stringify({id:1, method:'Runtime.evaluate', params:{expression:FOCUS_SCRIPT,returnByValue:true}})));
                   ws.on('message', () => { clearTimeout(t); ws.close(); res(null); });
                   ws.on('error', () => { clearTimeout(t); res(null); });
               });
           } catch (_) {}
        }

        // Focus window
        spawnSync(OSASCRIPT_BIN, ['-e', `
            tell application "System Events"
                tell process "Electron"
                    set frontmost to true
                    perform action "AXRaise" of window "${targetTitle}"
                end tell
            end tell
        `], { encoding: 'utf8', timeout: 3000 });
        
        // Use Cmd+L (Chat: Focus) or Cmd+I (Inline Chat) if CDP focus failed
        // We'll use Cmd+L for side panel chat focus as it's common
        spawnSync(OSASCRIPT_BIN, ['-e', `
            tell application "System Events"
                delay 0.2
                -- keystroke "l" using command down
                delay 0.1
            end tell
        `], { encoding: 'utf8', timeout: 3000 });

        // Write to clipboard then paste
        spawnSync(PBCOPY_BIN, [], {
            input: text, encoding: 'utf8', timeout: 3000,
        });
        
        spawnSync(OSASCRIPT_BIN, ['-e', `
            tell application "System Events"
                keystroke "v" using command down
                delay 0.05
                key code 36
            end tell
        `], { encoding: 'utf8', timeout: 3000 });

        return { success: true, method: 'director-pbcopy-paste', title: targetTitle };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

// ─── Ollama On-Demand Lifecycle ───────────────────────────────────────────────
// Ollama is started only when the Director or /ai endpoint is invoked,
// and automatically stopped after OLLAMA_IDLE_MS of inactivity (default 5 min).
// This keeps RAM/CPU free when just bridging direct messages to Antigravity.

const OLLAMA_IDLE_MS = 5 * 60 * 1000; // 5 minutes idle → stop
let ollamaIdleTimer  = null;

function isOllamaRunning() {
    try {
        const r = spawnSync('curl', ['-s', 'http://127.0.0.1:11434/api/tags'], { encoding: 'utf8', timeout: 3000 });
        return r.status === 0;
    } catch (_) { return false; }
}

async function ensureOllamaUp() {
    if (isOllamaRunning()) {
        scheduleOllamaShutdown(); // reset idle timer
        return true;
    }
    console.log('[ollama] Starting Ollama on-demand (macOS)…');
    const start = spawn('ollama', ['serve'], { detached: true, stdio: 'ignore', env: { ...process.env, PATH: '/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin' } });
    start.unref();

    // Wait up to 15s for Ollama to become ready
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 800));
        try {
            if (isOllamaRunning()) { console.log('[ollama] Ready ✓'); scheduleOllamaShutdown(); return true; }
        } catch (_) {}
    }
    console.warn('[ollama] Timed out waiting for ready — continuing anyway');
    scheduleOllamaShutdown();
    return false;
}

function scheduleOllamaShutdown() {
    if (ollamaIdleTimer) clearTimeout(ollamaIdleTimer);
    ollamaIdleTimer = setTimeout(() => {
        if (!isOllamaRunning()) return;
        console.log('[ollama] Idle timeout reached — stopping Ollama to free resources');
        spawnSync('pkill', ['-f', 'ollama serve'], { encoding: 'utf8', timeout: 10000 });
        ollamaIdleTimer = null;
    }, OLLAMA_IDLE_MS);
}

// ─── REST API ─────────────────────────────────────────────────────────────────

app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

// ── Agent Manager: always returns the best 'clean' window and locks to it ──────
app.get('/manager', (req, res) => {
    const mgr = pickManagerTarget();
    if (!mgr) return res.json({ found: false, message: 'No Antigravity windows on :9222 yet' });

    // Clean the title for display
    const raw = mgr.title || '';
    let label = raw
        .replace(/^vscode-file:\/\/vscode-app.*/, 'Antigravity')
        .replace(/^(.+?) (?:-|—) Antigravity (?:-|—) .+$/, '$1')   // "OnPoint - Antigravity - file" → "OnPoint"
        .replace(/ (?:-|—) Antigravity$/, '')                  // "OnPoint - Antigravity" → "OnPoint"
        .trim() || 'Antigravity';

    return res.json({
        found: true,
        wsUrl: mgr.webSocketDebuggerUrl,
        title: label,
        rawTitle: raw,
        isActive: mgr.webSocketDebuggerUrl === activeTargetUrl,
    });
});

// POST /lock-manager — locks the bridge to the Agent Manager window
app.post('/lock-manager', (req, res) => {
    const mgr = pickManagerTarget();
    if (!mgr) return res.json({ success: false, error: 'No manager window found' });
    activeTargetUrl = mgr.webSocketDebuggerUrl;
    lastFullText = ''; // reset diff
    const raw = mgr.title || '';
    const label = raw.replace(/^(.+?) (?:-|—) Antigravity (?:-|—) .+$/, '$1').replace(/ (?:-|—) Antigravity$/, '').trim() || 'Antigravity';
    res.json({ success: true, wsUrl: activeTargetUrl, title: label });
});

// Status: target count + active target info
// Debug: expose the xdotoolSend result to identify failure
app.post('/debug-send', async (req, res) => {
    const msg = String(req.body.message || 'debug-test');
    const result = await xdotoolSend(msg);
    res.json(result);
});

// Favicon
app.get('/favicon.ico', (req, res) => res.redirect('/favicon.svg'));
app.get('/favicon.svg', (req, res) => res.sendFile(join(__dirname, 'public', 'favicon.svg')));

// Live process monitor (htop equivalent)
app.get('/htop', (req, res) => {
    try {
        // BSD / macOS ps: use -aux -O %cpu -r
        // Getting top 20 processes
        const out = execSync("ps -axo user,pid,%cpu,%mem,vsz,rss,stat,time,command -r | head -21").toString();
        const lines = out.split('\n').filter(Boolean);
        const headers = lines[0].trim().split(/\s+/);
        
        const processes = lines.slice(1).map(line => {
            const parts = line.trim().split(/\s+/);
            if (parts.length < 9) return null;
            return {
                user: parts[0],
                pid: parts[1],
                cpu: parts[2],
                mem: parts[3],
                vsz: Math.round(parseInt(parts[4])/1024) + 'M',
                rss: Math.round(parseInt(parts[5])/1024) + 'M',
                stat: parts[6],
                time: parts[7],
                command: parts.slice(8).join(' ').slice(0, 100)
            };
        }).filter(Boolean);

        // Get system load and memory
        const load = os.loadavg();
        const totalMem = os.totalmem();
        const freeMem = os.freemem();
        
        res.json({
            processes,
            system: {
                load: load.map(l => l.toFixed(2)),
                memTotal: Math.round(totalMem / 1024 / 1024),
                memUsed: Math.round((totalMem - freeMem) / 1024 / 1024),
                cpus: os.cpus()
            }
        });
    } catch(e) {
        res.json({ error: e.message });
    }
});

// Per-PID process stats — directly queries specific PIDs (not top-N limited)
// GET /agent-proc-stats?pids=1234,5678
app.get('/agent-proc-stats', (req, res) => {
    const pidStr = String(req.query.pids || '').replace(/[^0-9,]/g, '');
    if (!pidStr) return res.json({ procs: [] });
    try {
        const out = execSync(`ps -p ${pidStr} -o pid=,pcpu=,pmem=,stat=,comm= 2>/dev/null || true`).toString();
        const procs = out.split('\n').filter(Boolean).map(line => {
            const parts = line.trim().split(/\s+/);
            if (parts.length < 4) return null;
            return { pid: parts[0], cpu: parts[1], mem: parts[2], stat: parts[3], comm: parts.slice(4).join(' ') };
        }).filter(Boolean);
        res.json({ procs });
    } catch(e) {
        res.json({ procs: [], error: e.message });
    }
});

// All Antigravity windows — merges CDP targets (streamable) + osascript scan (visible-only)
app.get('/all-windows', (req, res) => {
    const results = [];

    // 1. CDP windows (streamable) — already known
    const cdpWins = cdpTargets.filter(t =>
        t.type === 'page' &&
        t.url.includes('workbench.html') &&
        !t.url.includes('jetski-agent')
    );
    for (const t of cdpWins) {
        const cleanT = t.title
            .replace(/ (?:-|—) Antigravity$/, '')
            .replace(/^(.+?) (?:-|—) Antigravity (?:-|—) /, '')
            .trim() || 'Antigravity';
        results.push({
            id: t.webSocketDebuggerUrl,
            title: cleanT,
            rawTitle: t.title,
            display: ':0', // display doesn't matter on Mac
            cdpReady: true,
            wsUrl: t.webSocketDebuggerUrl,
            active: t.webSocketDebuggerUrl === activeTargetUrl,
        });
    }

    // 2. Osascript scan of real desktop (Electron windows)
    try {
        const widsRaw = execSync(
            `/usr/bin/osascript -e 'tell application "System Events" to get name of every window of process "Electron"' 2>/dev/null || true`,
            { timeout: 3000, encoding: 'utf8' }
        ).trim();
        
        if (widsRaw) {
            const wids = widsRaw.split(', ').filter(n => n && n !== 'missing value');
            for (let i = 0; i < wids.length; i++) {
                const title = wids[i];
                // Skip tiny utility windows
                if (!title || title === 'antigravity') continue;
                // Skip if already in CDP list
                const cleanT = title.replace(/ (?:-|—) Antigravity$/, '').trim();
                if (results.find(r => r.rawTitle === title || r.title === cleanT)) continue;
                results.push({
                    id: `osascript:${i}`,
                    title: cleanT,
                    rawTitle: title,
                    display: ':0',
                    cdpReady: false,
                    wid: title, // use name as ID for Mac
                    active: false,
                });
            }
        }
    } catch (_) {}

    res.json({ windows: results, cdpCount: cdpWins.length, totalCount: results.length });
});

// Focus a specific window (using title on Mac)
app.post('/focus-window', (req, res) => {
    const { wid } = req.body || {};
    if (!wid) return res.json({ success: false, error: 'No window ID' });
    try {
        execSync(`/usr/bin/osascript -e 'tell application "System Events" to tell process "Electron" to perform action "AXRaise" of window "${wid}"'`, { timeout: 3000 });
        execSync(`/usr/bin/osascript -e 'tell application "System Events" to tell process "Electron" to set frontmost to true'`, { timeout: 3000 });
        res.json({ success: true });
    } catch(e) {
        res.json({ success: false, error: e.message });
    }
});


// Security / CISO report HTML viewer
app.get('/report', (req, res) => res.sendFile(join(__dirname, 'public', 'report.html')));

// Open a workspace as a NEW Antigravity window so it gets its own CDP target
app.post('/open-workspace', (req, res) => {
    const path = req.body?.path;
    if (!path) return res.json({ success: false, error: 'No path provided' });
    try {
        // macOS: Use Electron wrapper directly to spawn a new window
        const child = spawn('/Applications/Antigravity.app/Contents/MacOS/Electron',
            ['--new-window', '--no-sandbox', '--disable-gpu', path],
            {
                detached: true, stdio: 'ignore',
                env: {
                    ...process.env,
                    HOME: '/Users/tony',
                    PATH: '/usr/local/bin:/usr/bin:/bin'
                }
            }
        );
        child.unref();
        res.json({ success: true, message: `Opening ${path} as new Antigravity window (PID ${child.pid}). Refresh window list in ~8s.` });
    } catch(e) {
        res.json({ success: false, error: e.message });
    }
});

app.get('/app-state', (req, res) => {
    function cleanTitle(raw) {
        if (!raw) return 'Antigravity';
        // Strip common Antigravity boilerplate: "<workspace> - Antigravity - <tab>"
        // Keep: "<workspace>" or "<tab>" — whichever is most useful
        let t = raw
            .replace(/ (?:-|—) Antigravity$/, '')      // trailing " - Antigravity"
            .replace(/^(.+?) (?:-|—) Antigravity (?:-|—) /, '') // "workspace - Antigravity - tabname" -> "tabname"
            .replace(/^vscode-file:.*/, 'Antigravity') // raw URL fallback
            .trim();
        return t || 'Antigravity';
    }
    res.json({
        targetCount,
        activeTarget: activeTargetUrl,
        targets: cdpTargets.map(t => ({ title: cleanTitle(t.title), rawTitle: t.title, url: t.url, wsUrl: t.webSocketDebuggerUrl }))
    });
});

// Active conversation/context — reads from known CDP targets directly (no WS timeout)
app.get('/ag-context', (req, res) => {
    // Fast path: look up active target in already-known list, clean and return its title
    const active = activeTargetUrl
        ? cdpTargets.find(t => t.webSocketDebuggerUrl === activeTargetUrl)
        : null;
    const fallback = active || pickTarget();
    if (!fallback) return res.json({ title: null, context: 'No active window' });

    const raw = fallback.title || '';
    // Clean: "OnPoint-Flutter - Antigravity - server.js" → "server.js"
    //        "Antigravity - server.js"                  → "server.js"
    let clean = raw
        .replace(/^vscode-file:\/\/vscode-app.*/, 'Antigravity')
        .replace(/^(.+?) (?:-|—) Antigravity (?:-|—) /, '')  // "workspace - Antigravity - tab" → "tab"
        .replace(/ (?:-|—) Antigravity$/, '')           // trailing " - Antigravity"
        .trim();
    if (!clean || clean.startsWith('vscode-file')) clean = 'Antigravity';
    res.json({ title: clean, type: 'window', context: clean });
});

// Current full snapshot (for initial page load)
app.get('/snapshot', (req, res) => {
    res.json({ text: lastFullText, title: 'OnPoint' });
});

// Available workspaces
app.get('/workspaces', async (req, res) => {
    try {
        const dirs = [
            '/Users/tony/OnPoint-Flutter',
            '/Users/tony/OnPoint',
            '/Users/tony/Antigravity',
            '/Users/tony/Antigravity Phone bridge',
            '/Users/tony/Old-AG-Bridge',
            '/Users/tony/Desktop/AI-Projects',
        ];
        const existing = [];
        for (const dir of dirs) {
            if (fs.existsSync(dir)) {
                existing.push({ name: dir.split('/').pop(), path: dir });
            }
        }
        res.json({ workspaces: existing });
    } catch (e) {
        res.json({ workspaces: [] });
    }
});

// Bridge + system stats
app.get('/stats', (req, res) => {
    const mem = process.memoryUsage();
    const load = os.loadavg();
    const activeTarget = cdpTargets.find(t => t.webSocketDebuggerUrl === activeTargetUrl);
    res.json({
        uptime: Math.floor((Date.now() - bridgeStartTime) / 1000),
        targetCount,
        activeTitle: activeTarget?.title || (activeTargetUrl ? 'Connected' : 'None'),
        memRss: mem.rss,
        heapUsed: mem.heapUsed,
        heapTotal: mem.heapTotal,
        loadAvg: load[0].toFixed(2)
    });
});

// Click a button in Antigravity by its visible text label (partial, case-insensitive)
app.post('/click', (req, res) => {
    if (!activeTargetUrl) return res.json({ success: false, error: 'No active target' });
    const label = req.body.label || '';

    const ws = new WebSocket(activeTargetUrl);
    ws.on('error', () => res.json({ success: false, error: 'WebSocket error' }));
    ws.on('open', () => {
        const script = `(() => {
            const needle = ${JSON.stringify(label.toLowerCase())};
            // Search all clickable elements: buttons, links, [role=button], divs with click handlers
            const candidates = [
                ...document.querySelectorAll('button'),
                ...document.querySelectorAll('[role="button"]'),
                ...document.querySelectorAll('a')
            ];
            const target = candidates.find(el => {
                const t = (el.innerText || el.textContent || '').trim().toLowerCase();
                return t.includes(needle) && el.offsetParent !== null; // visible only
            });
            if (target) { target.click(); return { clicked: true, text: target.innerText.trim() }; }
            return { clicked: false };
        })()`;
        ws.send(JSON.stringify({ id: 10, method: 'Runtime.evaluate', params: { expression: script, returnByValue: true } }));
    });
    ws.on('message', (raw) => {
        try {
            const val = JSON.parse(raw)?.result?.result?.value;
            res.json(val || { clicked: false });
        } catch { res.json({ clicked: false }); }
        ws.close();
    });
});

// Scan Antigravity for visible interactive buttons (for dynamic action bar on phone)
app.get('/scan-actions', (req, res) => {
    if (!activeTargetUrl) return res.json({ buttons: [], prompt: '' });

    const ws = new WebSocket(activeTargetUrl);
    ws.on('error', () => res.json({ buttons: [], prompt: '' }));
    ws.on('open', () => {
        const script = `(() => {
            // Permission-intent keywords — ONLY these qualify
            const ALLOW = /^(allow|deny|approve|accept|yes|no|proceed|continue|cancel|dismiss|skip|permit|decline|ok|confirm|got it|got it!|done|close|ignore|block|trust|don.?t allow|allow this|allow once|allow always|never allow|keep|discard|replace|overwrite|save|don.?t save)/i;

            // 1. Prefer buttons inside a recognised dialog/modal/notification container
            const dialogContainers = [
                ...document.querySelectorAll('[role="dialog"], [role="alertdialog"], .dialog, .modal, .notification, .prompt, .permission, [class*="dialog"], [class*="modal"], [class*="permission"], [class*="confirm"], [class*="alert"]')
            ].filter(el => el.offsetParent !== null);

            const seen = new Set();
            const results = [];
            let prompt = '';

            for (const container of dialogContainers) {
                // Grab the question text from the container
                const label = container.querySelector('p, span, label, h1, h2, h3, div > strong');
                if (label) prompt = label.innerText.trim().slice(0, 120);

                const btns = [...container.querySelectorAll('button, [role="button"]')];
                for (const btn of btns) {
                    const text = (btn.innerText || btn.textContent || '').trim();
                    if (!text || text.length > 60 || seen.has(text)) continue;
                    seen.add(text);
                    results.push(text);
                }
                if (results.length) break; // Found a dialog — stop here
            }

            // 2. Fallback: scan ALL visible buttons but keyword-filter strictly
            if (!results.length) {
                const all = [...document.querySelectorAll('button, [role="button"]')];
                for (const btn of all) {
                    const text = (btn.innerText || btn.textContent || '').trim();
                    if (!text || text.length > 60) continue;
                    if (btn.offsetParent === null) continue;
                    if (!ALLOW.test(text)) continue;  // ← keyword gate
                    if (seen.has(text)) continue;
                    seen.add(text);
                    results.push(text);
                    if (results.length >= 6) break;
                }
            }

            return { buttons: results, prompt };
        })()`;
        ws.send(JSON.stringify({ id: 11, method: 'Runtime.evaluate', params: { expression: script, returnByValue: true } }));
    });
    ws.on('message', (raw) => {
        try {
            const val = JSON.parse(raw)?.result?.result?.value;
            res.json(val && Array.isArray(val.buttons) ? val : { buttons: [], prompt: '' });
        } catch { res.json({ buttons: [], prompt: '' }); }
        ws.close();
    });
});

// Switch window (persistent lock)
app.post('/select', (req, res) => {
    activeTargetUrl = req.body.wsUrl;
    lastFullText = ''; // Reset diff tracking on window switch
    res.json({ success: true });
});

// Inject text into active Antigravity window
// Strategy: xclip (clipboard) + xdotool (Ctrl+V + Enter) — works with any React input
app.post('/send', async (req, res) => {
    const msg = String(req.body.message || '').trim();
    if (!msg) return res.json({ success: false, error: 'Empty message' });

    // Pause the CDP stream loop while send is in-flight (DOM is changing, innerText is unreliable)
    skipPollWhileSending = true;
    const resumePoll = () => { skipPollWhileSending = false; };
    const pollResumeTimer = setTimeout(resumePoll, 3000); // safety: always re-enable after 3s

    // ── Try CDP first: fast and reliable for the active CDP window ────────────
    if (activeTargetUrl) {
        try {
            const result = await new Promise((resolve, reject) => {
                const ws = new WebSocket(activeTargetUrl);
                const timer = setTimeout(() => {
                    try { ws.terminate(); } catch (_) {}
                    reject(new Error('CDP send timeout'));
                }, 5000);

                ws.on('error', (e) => { clearTimeout(timer); reject(e); });
                ws.on('open', () => {
                    let msgId = 10;
                    // Focus the chat input
                    ws.send(JSON.stringify({ id: msgId++, method: 'Runtime.evaluate', params: {
                        expression: `(document.querySelector('.inputarea,[contenteditable="true"],textarea,input'))?.focus()`,
                        returnByValue: true,
                    }}));
                    setTimeout(() => {
                        ws.send(JSON.stringify({ id: msgId++, method: 'Input.insertText', params: { text: msg } }));
                        setTimeout(() => {
                            ws.send(JSON.stringify({ id: msgId++, method: 'Input.dispatchKeyEvent', params: {
                                type: 'keyDown', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, key: 'Enter', code: 'Enter'
                            }}));
                            ws.send(JSON.stringify({ id: msgId++, method: 'Input.dispatchKeyEvent', params: {
                                type: 'keyUp', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, key: 'Enter', code: 'Enter'
                            }}));
                            clearTimeout(timer);
                            setTimeout(() => { try { ws.close(); } catch (_) {} resolve({ success: true, method: 'cdp' }); }, 200);
                        }, 200);
                    }, 150);
                });
            });
            clearTimeout(pollResumeTimer); resumePoll();
            return res.json(result);
        } catch (cdpErr) {
            // CDP failed — fall through to xdotool
        }
    }

    // ── Fallback: xclip+xdotool ───────────────────────────────────────────────
    const xResult = await xdotoolSend(msg);
    clearTimeout(pollResumeTimer); resumePoll();
    if (xResult.success) return res.json({ success: true, method: 'xclip' });

    res.json({ success: false, error: `CDP unavailable and xdotool failed: ${xResult.error}` });
});

// ─── File Upload ──────────────────────────────────────────────────────────────
// Antigravity's Electron window has NO native <input type="file"> so we
// save the file to /tmp then inject the path as a text message.
app.post('/upload', express.raw({ type: '*/*', limit: '100mb' }), async (req, res) => {
    if (!req.body || !req.body.length) return res.json({ success: false, error: 'Empty file' });

    const fname   = req.query.name || 'upload.bin';
    const tempDir = join('/tmp', 'ag-bridge-uploads');
    fs.mkdirSync(tempDir, { recursive: true });
    const filepath = join(tempDir, Date.now() + '_' + fname.replace(/[^a-zA-Z0-9.-]/g, '_'));
    fs.writeFileSync(filepath, req.body);

    // Inject the file path as a message so Antigravity can read it
    const pathMsg = `@file:${filepath}`;
    const xResult = await xdotoolSend(pathMsg);

    if (xResult.success) {
        return res.json({ success: true, method: 'xclip+xdotool', path: filepath });
    }

    // CDP fallback
    if (!activeTargetUrl) return res.json({ success: false, error: `File saved to ${filepath} but could not inject: ${xResult.error}` });

    const ws = new WebSocket(activeTargetUrl);
    ws.on('error', () => res.json({ success: false, error: 'WebSocket error during file inject' }));
    ws.on('open', () => {
        let mid = 100;
        ws.send(JSON.stringify({ id: mid++, method: 'Runtime.evaluate', params: {
            expression: `(document.querySelector('.inputarea,[contenteditable],textarea,input'))?.focus()`,
            returnByValue: true,
        }}));
        setTimeout(() => {
            ws.send(JSON.stringify({ id: mid++, method: 'Input.insertText', params: { text: pathMsg } }));
            setTimeout(() => {
                ws.send(JSON.stringify({ id: mid++, method: 'Input.dispatchKeyEvent', params: { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 } }));
                ws.send(JSON.stringify({ id: mid++, method: 'Input.dispatchKeyEvent', params: { type: 'keyUp',  key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 } }));
                setTimeout(() => { ws.close(); res.json({ success: true, path: filepath, method: 'cdp-fallback' }); }, 300);
            }, 200);
        }, 300);
    });
});


// \u2500\u2500\u2500 AI Runtime \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

// ─── AG Telemetry Proxy ───────────────────────────────────────────────────────
// GET /ag-telemetry — proxies :2625 + enriches with memory stats
app.get('/ag-telemetry', (req, res) => {
    const fetchJson = (url) => new Promise((resolve) => {
        http.get(url, { timeout: 2000 }, (r) => {
            let d = '';
            r.on('data', c => d += c);
            r.on('end', () => { try { resolve(JSON.parse(d)); } catch (_) { resolve(null); } });
        }).on('error', () => resolve(null));
    });
    Promise.all([
        fetchJson('http://127.0.0.1:2625/status'),
        fetchJson('http://127.0.0.1:2625/tasks'),
    ]).then(([status, tasks]) => {
        let memoryTotal = 0;
        const memBase = '/ai-data/runtime/memory';
        try {
            for (const cat of ['fixes', 'architecture', 'solutions', 'decisions']) {
                const dir = `${memBase}/${cat}`;
                if (fs.existsSync(dir)) memoryTotal += fs.readdirSync(dir).filter(f => f.endsWith('.json')).length;
            }
        } catch (_) {}
        res.json({
            telemetry:   status  || { error: 'telemetry server offline (port 2625)' },
            tasks:       tasks   || { error: 'no task data' },
            memoryTotal,
            timestamp:   new Date().toISOString(),
        });
    });
});

// ─── AG Memory Feed ───────────────────────────────────────────────────────────
// GET /ag-memory[?category=solutions&limit=10]
app.get('/ag-memory', (req, res) => {
    const category = req.query.category || null;
    const limit    = Math.min(parseInt(req.query.limit || '10', 10), 50);
    const memBase  = '/ai-data/runtime/memory';
    const cats     = category ? [category] : ['fixes', 'architecture', 'solutions', 'decisions'];
    const records  = [];
    for (const cat of cats) {
        const dir = `${memBase}/${cat}`;
        if (!fs.existsSync(dir)) continue;
        const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
        for (const file of files) {
            try { records.push(JSON.parse(fs.readFileSync(`${dir}/${file}`, 'utf8'))); } catch (_) {}
        }
    }
    const sorted = records
        .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
        .slice(0, limit)
        .map(r => ({
            id: r.id, category: r.category,
            task:       (r.task     || '').slice(0, 120),
            solution:   (r.solution || '').slice(0, 200),
            agentsUsed: r.agentsUsed || [],
            timestamp:  r.timestamp,
        }));
    res.json({ records: sorted, total: records.length });
});

// --- AI-Director Chat Persistence ---
const AI_HISTORY_FILE = join('/ai-data', 'runtime', 'chat-history.json');

function getAiHistory() {
    try {
        if (!fs.existsSync(AI_HISTORY_FILE)) return [];
        return JSON.parse(fs.readFileSync(AI_HISTORY_FILE, 'utf8'));
    } catch (e) {
        return [];
    }
}

function saveAiHistory(history) {
    try {
        fs.writeFileSync(AI_HISTORY_FILE, JSON.stringify(history, null, 2));
    } catch (e) {
        console.error('Failed to save AI history', e);
    }
}

app.get('/ai-history', (req, res) => {
    res.json({ history: getAiHistory() });
});

app.post('/ai-clear', (req, res) => {
    saveAiHistory([]);
    res.json({ success: true });
});

// POST /ai

// Executes ag-commander run <type> <message> and returns the response as JSON.
// Supports optional "type" field (default: "quick") for model routing.
app.post('/ai', async (req, res) => {
    const message = (req.body && req.body.message) ? String(req.body.message).trim() : '';
    const taskType = (req.body && req.body.type)    ? String(req.body.type).trim()    : 'quick';

    if (!message) {
        return res.status(400).json({ error: 'message is required' });
    }

    // Ensure Ollama is running (starts it on-demand if stopped)
    await ensureOllamaUp();

    const { spawn } = await import('child_process');
    const TIMEOUT_MS = ['planning','devops'].includes(taskType) ? 300_000 : (['coding','code'].includes(taskType) ? 180_000 : 150_000);

    // Save user message immediately
    const history = getAiHistory();
    const taskId = `ai-${Date.now()}`;
    
    history.push({ role: 'user', text: message, id: `user-${Date.now()}` });
    // Add a placeholder thinking bubble
    history.push({ role: 'ai', text: '🎯 AI-Director is thinking…', id: taskId, pending: true });
    saveAiHistory(history);

    // Return immediately to the client so the browser fetch doesn't timeout
    res.json({ success: true, taskId });

    // --- Background Execution ---
    let stdout = '';
    let stderr = '';
    let finished = false;

    const child = spawn('ag-commander', ['run', taskType, message], {
        env: { ...process.env, PATH: '/usr/local/bin:/usr/bin:/bin' },
        timeout: TIMEOUT_MS,
    });

    const timer = setTimeout(() => {
        if (!finished) {
            child.kill('SIGTERM');
            finished = true;
            updateAiHistory(taskId, `⚠️ AI runtime timed out after ${Math.round(TIMEOUT_MS/1000)}s`, 'AI-Director (Timeout)', false);
        }
    }, TIMEOUT_MS);

    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    child.on('close', (code) => {
        clearTimeout(timer);
        if (finished) return;
        finished = true;

        const response = stdout.trim();
        let modelUsed = 'Auto-routing';
        const modelMatch = stderr.match(/model=([^\\s]+)/);
        if (modelMatch) modelUsed = modelMatch[1];
        
        const label = `AI-Director (${modelUsed})`;

        if (code !== 0 && !response) {
            console.error(`[/ai] commander exited ${code}: ${stderr.trim()}`);
            updateAiHistory(taskId, '⚠️ AI runtime error: ' + stderr.trim().slice(0, 300), label, false);
            return;
        }

        updateAiHistory(taskId, response || '(no response)', label, false);
    });

    child.on('error', (err) => {
        clearTimeout(timer);
        if (finished) return;
        finished = true;
        console.error('[/ai] spawn error:', err.message);
        updateAiHistory(taskId, '⚠️ Failed to start AI runtime: ' + err.message, 'AI-Director (Error)', false);
    });
    
    function updateAiHistory(id, text, label, pending) {
        const h = getAiHistory();
        const idx = h.findIndex(b => b.id === id);
        if (idx !== -1) {
            h[idx].text = text;
            h[idx].label = label;
            if (!pending) delete h[idx].pending;
            saveAiHistory(h);
        }
    }
});


// ─── Director Endpoint ────────────────────────────────────────────────────────
// POST /director  { message, mode?: "auto|code|plan|ops|quick" }
// Routes message through ag-commander (proven working) and streams response
// back to the Director tab via SSE. Mode maps to ag-commander task types.
app.post('/director', async (req, res) => {
    const message = String(req.body?.message || '').trim();
    const mode    = String(req.body?.mode || 'auto').trim();
    if (!message) return res.status(400).json({ error: 'message is required' });

    // Map director mode to ag-commander task type
    const modeMap = { auto: 'quick', code: 'coding', plan: 'planning', ops: 'devops', quick: 'quick' };
    const taskType = modeMap[mode] || 'quick';

    const useSSE = (req.headers.accept || '').includes('text/event-stream');
    if (useSSE) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();
    }
    const sendSSE = (type, data) => {
        if (useSSE) res.write(`data: ${JSON.stringify({ type, data })}\n\n`);
    };

    // Ensure Ollama is running before spawning ag-commander
    if (!isOllamaRunning()) {
        sendSSE('status', 'Starting AI engine… (first request takes ~10s)');
        await ensureOllamaUp();
    } else {
        scheduleOllamaShutdown(); // reset idle timer
    }

    const TIMEOUT_MS = taskType === 'planning' ? 300_000 : (taskType === 'coding' ? 180_000 : 120_000);
    const startTime  = Date.now();

    sendSSE('status', `Running ${mode} task via AI-Director…`);

    const { spawn } = await import('child_process');
    const fullPrompt = `[DIRECTOR:${mode.toUpperCase()}] ${message}`;

    let stdout  = '';
    let stderr  = '';
    let settled = false;

    const child = spawn('ag-commander', ['run', taskType, fullPrompt], {
        env: { ...process.env, PATH: '/usr/local/bin:/usr/bin:/bin' },
    });

    // Stream progress updates every 5s while waiting
    const progressTimer = setInterval(() => {
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        sendSSE('status', `AI-Director working… (${elapsed}s)`);
    }, 5000);

    const killTimer = setTimeout(() => {
        if (!settled) {
            child.kill('SIGTERM');
            settled = true;
            clearInterval(progressTimer);
            const partial = stdout.trim() || '(timed out with no response)';
            sendSSE('done', { response: partial, elapsed: Math.round((Date.now() - startTime) / 1000) });
            if (useSSE) res.end();
            else res.json({ response: partial });
        }
    }, TIMEOUT_MS);

    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(killTimer);
        clearInterval(progressTimer);

        const response = stdout.trim() || (stderr.trim() ? `⚠️ ${stderr.trim()}` : '(no response)');
        const elapsed  = Math.round((Date.now() - startTime) / 1000);

        if (useSSE) { sendSSE('done', { response, elapsed }); res.end(); }
        else res.json({ response, elapsed, mode });
    });

    child.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(killTimer);
        clearInterval(progressTimer);
        const errMsg = `ag-commander error: ${err.message}`;
        if (useSSE) { sendSSE('error', errMsg); res.end(); }
        else res.status(500).json({ error: errMsg });
    });

    req.on('close', () => {
        if (!settled) { child.kill('SIGTERM'); }
    });
});


// ─── AI Upload ─────────────────────────────────────────────────────────────────────────────────
// POST /ai-upload
// Accepts a file (multipart or raw), saves it, then calls ag-commander with the
// file path appended to the prompt so the model can reference it.
app.post('/ai-upload', express.raw({ type: '*/*', limit: '50mb' }), async (req, res) => {
    if (!req.body || !req.body.length) {
        return res.status(400).json({ error: 'Empty file body' });
    }

    const fname    = req.query.name    || 'upload.bin';
    const prompt   = req.query.prompt  || 'Describe this file';
    const taskType = req.query.type    || 'quick';

    const tempDir  = join(os.tmpdir(), 'ag-bridge-ai-uploads');
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

    const safeName = Date.now() + '_' + fname.replace(/[^a-zA-Z0-9._-]/g, '_');
    const filepath = join(tempDir, safeName);
    fs.writeFileSync(filepath, req.body);

    const fullPrompt = `${prompt}\nFile saved at: ${filepath}`;

    const { spawn } = await import('child_process');
    const TIMEOUT_MS = 90_000;
    let stdout = '', stderr = '', finished = false;

    const child = spawn('ag-commander', ['run', taskType, fullPrompt], {
        env: { ...process.env, PATH: '/usr/local/bin:/usr/bin:/bin' },
        timeout: TIMEOUT_MS,
    });

    const timer = setTimeout(() => {
        if (!finished) { child.kill('SIGTERM'); finished = true; res.status(504).json({ error: 'Timed out' }); }
    }, TIMEOUT_MS);

    child.stdout.on('data', c => stdout += c.toString());
    child.stderr.on('data', c => stderr += c.toString());

    child.on('close', code => {
        clearTimeout(timer);
        if (finished) return;
        finished = true;
        const response = stdout.trim();
        if (code !== 0 && !response) return res.status(500).json({ error: 'AI runtime error', detail: stderr.trim().slice(0, 300) });
        res.json({ response, file: safeName });
    });

    child.on('error', err => {
        clearTimeout(timer);
        if (finished) return;
        finished = true;
        res.status(500).json({ error: 'Failed to start AI runtime', detail: err.message });
    });
});

// ─── Security Endpoints ───────────────────────────────────────────────────────
const SECURITY_REPORTS_DIR = '/ai-data/runtime/security-reports';

function readJsonSafe(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (_) { return null; }
}

// GET /ag-security — latest security scan summary
app.get('/ag-security', (req, res) => {
  const latest = readJsonSafe(`${SECURITY_REPORTS_DIR}/latest.json`);
  if (!latest) return res.json({ error: 'No security scan found. Run pipeline or security scanner.' });
  res.json({
    repo:        latest.repo,
    timestamp:   latest.timestamp,
    score:       latest.score,
    posture:     latest.posture,
    summary:     latest.summary,
    secrets:     { count: latest.secrets?.count ?? 0 },
    sast:        { count: latest.sast?.count ?? 0 },
    dependencies: { total: latest.dependencies?.total ?? 0, critical: latest.dependencies?.critical ?? 0, summary: latest.dependencies?.summary },
    infrastructure: { count: latest.infrastructure?.count ?? 0 },
    topFindings: (latest.allFindings || []).filter(f => ['CRITICAL','HIGH'].includes(f.severity)).slice(0, 10),
  });
});

// GET /ag-vulnerabilities — detailed findings list
app.get('/ag-vulnerabilities', (req, res) => {
  const latest = readJsonSafe(`${SECURITY_REPORTS_DIR}/latest.json`);
  if (!latest) return res.json({ error: 'No security scan found.' });
  const severity = req.query.severity;
  let findings = latest.allFindings || [];
  if (severity) findings = findings.filter(f => f.severity === severity.toUpperCase());
  res.json({ total: findings.length, findings: findings.slice(0, 100), scan: { repo: latest.repo, timestamp: latest.timestamp } });
});

// GET /ag-security-report/latest — full CISO report (JSON)
app.get('/ag-security-report/latest', (req, res) => {
  const latest = readJsonSafe(`${SECURITY_REPORTS_DIR}/ciso-latest.json`);
  if (!latest) return res.json({ error: 'No CISO report generated yet. POST to /ag-ciso-report/run first.' });
  res.json(latest);
});

// GET /ag-security-report/latest.md — CISO report as Markdown download
app.get('/ag-security-report/latest.md', (req, res) => {
  const mdPath = `${SECURITY_REPORTS_DIR}/ciso-latest.md`;
  if (!fs.existsSync(mdPath)) return res.status(404).send('No CISO report markdown found.');
  res.setHeader('Content-Type', 'text/markdown');
  res.setHeader('Content-Disposition', 'attachment; filename="ciso-security-report.md"');
  res.send(fs.readFileSync(mdPath, 'utf8'));
});

// GET /ag-security-report/history — list of historical reports
app.get('/ag-security-report/history', (req, res) => {
  const histDir = `${SECURITY_REPORTS_DIR}/history`;
  if (!fs.existsSync(histDir)) return res.json({ reports: [] });
  const files = fs.readdirSync(histDir)
    .filter(f => f.endsWith('.json'))
    .sort().reverse()
    .slice(0, 20)
    .map(f => {
      try {
        const r = JSON.parse(fs.readFileSync(`${histDir}/${f}`, 'utf8'));
        return { id: r.meta?.id || f, name: r.meta?.name, timestamp: r.meta?.timestamp, score: r.scan?.score, posture: r.scan?.posture };
      } catch (_) { return { id: f }; }
    });
  res.json({ reports: files });
});

// GET /ag-threat-model/latest — latest threat model
app.get('/ag-threat-model/latest', (req, res) => {
  const latest = readJsonSafe(`${SECURITY_REPORTS_DIR}/threat-model-latest.json`);
  if (!latest) return res.json({ error: 'No threat model found. Run threat-model engine.' });
  res.json(latest);
});

// POST /ag-ciso-report/run — trigger full security pipeline + CISO report
app.post('/ag-ciso-report/run', (req, res) => {
  const repo = req.body?.repo || '/Users/tony/OnPoint-Flutter';
  const name = req.body?.name || 'OnPoint-Flutter';
  const child = spawn('node', [
    '/ai-data/runtime/security-reports/index.js',
    '--run', '--repo', repo, '--name', name,
  ], {
    stdio: 'ignore',
    detached: true,
    env: { ...process.env, PATH: '/usr/local/bin:/usr/bin:/bin' },
  });
  child.unref();
  res.json({ success: true, message: `CISO report generation started (PID=${child.pid}). Check /ag-security-report/latest in ~60s.`, repo, name });
});

// ─── Architecture Endpoints ───────────────────────────────────────────────────
const ARCH_MONITOR_DIR = '/ai-data/runtime/architecture-monitor';

// GET /ag-architecture — latest architecture analysis report
app.get('/ag-architecture', (req, res) => {
  const latest = readJsonSafe(`${ARCH_MONITOR_DIR}/latest.json`);
  if (!latest) return res.json({ error: 'No architecture analysis run yet. POST to /ag-architecture/run first.' });
  res.json(latest);
});

// GET /ag-risk-score — quick score summary across all repos
app.get('/ag-risk-score', (req, res) => {
  const latest = readJsonSafe(`${ARCH_MONITOR_DIR}/latest.json`);
  if (!latest) return res.json({ error: 'No architecture data available.' });
  const repoScores = (latest.repos || []).map(r => ({
    repo: r.repo, riskScore: r.riskScore, riskLevel: r.riskLevel,
    endpoints: r.endpoints?.count, authMechanisms: r.authMechanisms?.length,
    timestamp: r.timestamp,
  }));
  res.json({
    overallRisk:  latest.overallRisk,
    avgRiskScore: latest.avgRiskScore,
    timestamp:    latest.timestamp,
    repos: repoScores,
  });
});

// POST /ag-architecture/run — trigger architecture analysis
app.post('/ag-architecture/run', (req, res) => {
  const child = spawn('node', ['/ai-data/runtime/architecture-monitor/index.js', '--once'], {
    stdio: 'ignore', detached: true,
    env: { ...process.env, PATH: '/usr/local/bin:/usr/bin:/bin' },
  });
  child.unref();
  res.json({ success: true, message: `Architecture analysis started (PID=${child.pid}). Check /ag-architecture in ~60s.` });
});

// POST /ag-security-scan/run — trigger security scan for a specific repo
app.post('/ag-security-scan/run', (req, res) => {
  const repo = req.body?.repo || '/Users/tony/OnPoint-Flutter';
  const name = req.body?.name || 'OnPoint-Flutter';
  const child = spawn('node', ['/ai-data/runtime/security/index.js', '--repo', repo, '--name', name], {
    stdio: 'ignore', detached: true,
    env: { ...process.env, PATH: '/usr/local/bin:/usr/bin:/bin' },
  });
  child.unref();
  res.json({ success: true, message: `Security scan started (PID=${child.pid}). Check /ag-security in ~60s.`, repo, name });
});

// ─── System Reboot ────────────────────────────────────────────────────────────
// POST /system-reboot — triggers a full system reboot.
// Requires { confirmed: true } in JSON body to prevent accidental calls.
app.post('/system-reboot', (req, res) => {
    if (!req.body?.confirmed) {
        return res.status(400).json({ success: false, error: 'Missing confirmed:true in body' });
    }
    console.log('[/system-reboot] Reboot requested — rebooting in 2 seconds...');
    res.json({ success: true, message: 'Rebooting server now. Reconnect in ~30 seconds.' });
    // Delay slightly so the HTTP response can be sent before the machine goes down
    setTimeout(() => {
        // macOS: use sudo shutdown -r now (assumes passwordless sudo is configured, or use applescript)
        const child = spawn('osascript', ['-e', 'tell application "System Events" to restart'], {
            detached: true,
            stdio: 'ignore',
            env: { ...process.env, PATH: '/usr/local/bin:/usr/bin:/bin' },
        });
        child.unref();
    }, 1500);
});

// POST /restart-bridge — restarts just the onpoint-bridge service (faster recovery)
app.post('/restart-bridge', (req, res) => {
    console.log('[/restart-bridge] Restarting bridge service via launchctl...');
    res.json({ success: true, message: 'Bridge restart initiated. Reconnect in ~10 seconds.' });
    setTimeout(() => {
        // macOS: Launchctl restart sequence
        const plistPath = `${process.env.HOME}/Library/LaunchAgents/com.onpoint.bridge.plist`;
        execSync(`launchctl unload ${plistPath} 2>/dev/null || true`);
        const child = spawn('launchctl', ['load', '-w', plistPath], {
            detached: true,
            stdio: 'ignore',
            env: { ...process.env, PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/Users/tony' },
        });
        child.unref();
    }, 500);
});

// ─── Start ────────────────────────────────────────────────────────────────────
server.listen(3000, '0.0.0.0', () => {
    const interfaces = os.networkInterfaces();
    let localIP = 'localhost';
    for (const iface of Object.values(interfaces)) {
        for (const alias of iface) {
            if (alias.family === 'IPv4' && !alias.internal) { localIP = alias.address; break; }
        }
    }
    console.log('');
    console.log('🚀  ONPOINT BRIDGE v5.0 — ACTIVE');
    console.log('─'.repeat(40));
    console.log(`📱  Phone URL  : http://${localIP}:3000`);
    console.log(`💻  Local URL  : http://localhost:3000`);
    console.log(`🔌  CDP Port   : 9222`);
    console.log('─'.repeat(40));
    console.log('');
});
