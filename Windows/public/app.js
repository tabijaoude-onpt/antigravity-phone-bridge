// ── State ──────────────────────────────────────────────────────────────────────
let currentMode      = 'browser';   // 'browser' | 'commander' | 'director' | 'runtime'
let userScrolledUp   = false;
let statsOpen        = false;
let lastDialogKey    = '';
let dialogCollapsed  = false;

// ── Mode Switching ─────────────────────────────────────────────────────────────
function setMode(mode) {
    currentMode = mode;
    document.body.className = 'mode-' + mode;

    const pillBrowser    = document.getElementById('pill-browser');
    const pillCommander  = document.getElementById('pill-commander');
    const pillDirector   = document.getElementById('pill-director');
    const pillRuntime    = document.getElementById('pill-runtime');
    const winList        = document.getElementById('winList');
    const txt            = document.getElementById('txt');
    const modeLabel      = document.getElementById('modeLabel');

    pillBrowser.className   = 'target-pill' + (mode === 'browser'    ? ' active-browser'    : '');
    pillCommander.className = 'target-pill' + (mode === 'commander'  ? ' active-commander'  : '');
    if (pillDirector)
        pillDirector.className = 'target-pill' + (mode === 'director' ? ' active-director' : '');
    if (pillRuntime)
        pillRuntime.className = 'target-pill' + (mode === 'runtime'  ? ' active-runtime'    : '');

    winList.style.display = (mode === 'browser') ? '' : 'none';

    if (mode === 'director') {
        txt.placeholder = 'Send a task to Antigravity Director…';
        modeLabel.textContent = 'Director';
    } else if (mode === 'commander') {
        txt.placeholder = 'Ask AI-Director anything…';
        modeLabel.textContent = 'AI-Director';
    } else if (mode === 'runtime') {
        modeLabel.textContent = 'Agents';
    } else {
        txt.placeholder = 'Send a message…';
        modeLabel.textContent = 'Antigravity';
    }

    snapToBottom();
}


// ── WebSocket (CDP stream from server) ────────────────────────────────────────
const streamEl = document.getElementById('stream');
let lastStreamText = '';     // tracks last full text so we can detect real changes
let streamResetCount = 0;    // how many resets occurred (for separator label)

function streamSeparator(label) {
    return `\n\n────── ${label} ──────\n\n`;
}

function connectSocket() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}`);

    ws.onmessage = ({ data }) => {
        try {
            const msg = JSON.parse(data);
            if (msg.type === 'reset') {
                const newText = msg.text || '';
                // Only act on meaningful content (not empty/blank resets)
                if (!newText.trim()) return;
                // If text is completely new (not a continuation), add a separator
                if (lastStreamText && newText !== lastStreamText && !newText.startsWith(lastStreamText.slice(-200))) {
                    const ts = new Date().toLocaleTimeString();
                    streamEl.textContent += streamSeparator(`Live — ${ts}`);
                }
                // If the entire new text is already shown, skip
                const currentText = streamEl.textContent;
                if (currentText.endsWith(newText)) {
                    lastStreamText = newText;
                    return;
                }
                // Show just the new content (not re-display everything already shown)
                if (newText.startsWith(lastStreamText) && lastStreamText.length > 50) {
                    streamEl.textContent += newText.slice(lastStreamText.length);
                } else {
                    streamEl.textContent += newText;
                }
                lastStreamText = newText;
            } else if (msg.type === 'append' && msg.text) {
                streamEl.textContent += msg.text;
                lastStreamText += msg.text;
            }
            if (!userScrolledUp) snapToBottom();
        } catch (_) {}
    };

    ws.onclose = () => setTimeout(connectSocket, 2000);
    ws.onerror = () => ws.close();
}

function clearStream() {
    streamEl.textContent = '';
    lastStreamText = '';
    userScrolledUp = false;
    snapToBottom();
}

// ── Scroll helpers ─────────────────────────────────────────────────────────────
const content   = document.getElementById('content');
const scrollBtn = document.getElementById('scrollBtn');

function snapToBottom() {
    content.scrollTop = content.scrollHeight;
    scrollBtn.style.display = 'none';
    userScrolledUp = false;
}

content.addEventListener('scroll', () => {
    const atBottom = content.scrollHeight - content.scrollTop - content.clientHeight < 60;
    userScrolledUp = !atBottom;
    scrollBtn.style.display = atBottom ? 'none' : 'block';
});

// ── Agent Manager: always-pinned top window ────────────────────────────────────
let managerWsUrl = null;

let hasAutoLockedManager = false;

async function refreshManagerPill() {
    try {
        const mgr = await fetch('/manager').then(r => r.json());
        const pill = document.getElementById('managerPill');
        const managerStatus = document.getElementById('managerStatus');

        if (!mgr.found) {
            if (pill) { pill.textContent = '⚠ No Antigravity Window'; pill.className = 'manager-pill offline'; }
            if (managerStatus) managerStatus.textContent = 'offline';
            return;
        }

        managerWsUrl = mgr.wsUrl;
        // Auto-lock on first load or if not yet locked to manager
        if (!hasAutoLockedManager && !mgr.isActive) {
            await fetch('/lock-manager', { method: 'POST' });
            hasAutoLockedManager = true;
        }

        if (pill) {
            pill.textContent = '🤖 ' + mgr.title;
            pill.className = 'manager-pill' + (mgr.isActive ? ' active' : '');
        }
        if (managerStatus) {
            managerStatus.textContent = mgr.isActive ? '● LIVE' : 'switch to agent';
        }
    } catch (_) {}
}

async function lockToManager() {
    hasAutoLockedManager = true;
    try {
        const result = await fetch('/lock-manager', { method: 'POST' }).then(r => r.json());
        if (result.success) {
            clearStream();
            const ready = document.createElement('div');
            ready.style.cssText = 'padding:20px;color:#22c55e;font-size:13px;opacity:0.8;text-align:center;';
            ready.textContent = '🤖 Locked to ' + (result.title || 'Antigravity') + ' — Type your message below ↓';
            streamEl.appendChild(ready);
            userScrolledUp = false;
            snapToBottom();
        }
        await refreshManagerPill();
        await refreshWindowList();
    } catch (_) {}
}

// ── Window list (other windows + workspaces) ───────────────────────────────────
async function refreshWindowList() {
    try {
        const [winRes, wsRes] = await Promise.all([
            fetch('/all-windows').then(r => r.json()).catch(() => ({ windows: [] })),
            fetch('/workspaces').then(r => r.json()).catch(() => ({ workspaces: [] }))
        ]);
        const windows = winRes.windows || [];
        const workspaces = wsRes.workspaces || [];
        const winList = document.getElementById('winList');
        if (!winList) return;

        let allOptions = '<option value="" disabled>Select a window...</option>';

        // Other open windows
        const otherWindows = windows.filter(w => w.wsUrl !== managerWsUrl);
        if (otherWindows.length > 0) {
            allOptions += '<optgroup label="Open Windows">';
            otherWindows.forEach(w => {
                const label = w.title.length > 40 ? w.title.slice(0, 38) + '\u2026' : w.title;
                if (w.cdpReady) {
                    const safe = (w.wsUrl || '').replace(/"/g, '&quot;');
                    allOptions += `<option value="${safe}" ${w.active ? 'selected' : ''}>${escHtml(label)}</option>`;
                } else {
                    const safeWid = (w.wid || '').replace(/"/g, '&quot;');
                    const safeDsp = (w.display || ':10.0').replace(/"/g, '&quot;');
                    allOptions += `<option value="wid:${safeWid}||${safeDsp}">${escHtml(label)} (Desktop)</option>`;
                }
            });
            allOptions += '</optgroup>';
        }

        // Workspace options
        const openNames = new Set(windows.map(w => w.title.toLowerCase()));
        const availableWs = workspaces.filter(w => !openNames.has(w.name.toLowerCase()));
        if (availableWs.length > 0) {
            allOptions += '<optgroup label="Open Workspace...">';
            availableWs.forEach(w => {
                const label = w.name.length > 30 ? w.name.slice(0, 28) + '\u2026' : w.name;
                const safePath = (w.path || '').replace(/"/g, '&quot;');
                allOptions += `<option value="workspace:${safePath}">+ ${escHtml(label)}</option>`;
            });
            allOptions += '</optgroup>';
        }

        winList.innerHTML = allOptions;
    } catch (_) {}
}

async function openProject(path) {
    const winList = document.getElementById('winList');
    const oldHtml = winList ? winList.innerHTML : '';
    if (winList) winList.innerHTML = '<option>Opening project...</option>';
    
    try {
        await fetch('/open-workspace', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path })
        });
        // Allow time for new window to spawn, then refresh list
        setTimeout(refreshWindowList, 3000);
    } catch (e) {
        alert('Failed to open project: ' + e.message);
        if (winList) winList.innerHTML = oldHtml;
        refreshWindowList();
    }
}

async function handleDropdownChange(val) {
    if (!val) return;
    if (val.startsWith('workspace:')) {
        openProject(val.replace('workspace:', ''));
        setTimeout(refreshWindowList, 500);
    } else if (val.startsWith('wid:')) {
        const parts = val.replace('wid:', '').split('||');
        focusDesktopWin(parts[0], parts[1] || ':0');
    } else {
        changeWin(val);
    }
}

async function createNewConversation() {
    const path = prompt("Start new conversation in workspace (leave blank for general):", "/Users/tony/Desktop/AI-Projects");
    if (path) openProject(path);
}

async function focusDesktopWin(wid, display) {
    try {
        await fetch('/focus-window', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ wid, display })
        });
    } catch (_) {}
}



function escHtml(str) {
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

async function changeWin(wsUrl) {
    clearStream();
    await fetch('/select', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wsUrl })
    });
    userScrolledUp = false;
}

// ── Main send dispatcher ───────────────────────────────────────────────────────
async function sendMsg() {
    const txt  = document.getElementById('txt');
    const msg  = txt.value.trim();
    if (!msg && currentMode !== 'director') return;

    if (currentMode === 'director') {
        await sendDirector(msg || null, null);
        return;
    } else if (currentMode === 'commander') {
        await sendToCommander(msg, 'quick');
    } else {
        await sendToBrowser(msg);
    }
    txt.value = '';
}

// ── Browser send (existing CDP inject) ────────────────────────────────────────
async function sendToBrowser(message) {
    const btn = document.getElementById('sendBtn');
    btn.disabled = true;
    btn.textContent = '…';
    try {
        await fetch('/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message })
        });
    } finally {
        btn.disabled = false;
        btn.textContent = '▶';
    }
}

// ── Commander send (POST /ai) ──────────────────────────────────────────────────
async function sendToCommander(message, type = 'quick') {
    const btn    = document.getElementById('sendBtn');
    
    btn.disabled = true;
    btn.textContent = '…';

    try {
        await fetch('/ai', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message, type })
        });
        // Polling will handle drawing the bubbles
        await loadAiHistory();
    } catch (e) {
        console.error('Network error:', e.message);
    } finally {
        btn.disabled = false;
        btn.textContent = '▶';
        snapToBottom();
    }
}

function appendBubble(container, role, text, label) {
    const div = document.createElement('div');
    div.className = role === 'user' ? 'bubble bubble-user' : 'bubble bubble-ai';
    if (role === 'ai' && label) {
        const lbl = document.createElement('strong');
        lbl.textContent = label;
        div.appendChild(lbl);
    }
    const span = document.createElement('span');
    span.textContent = text;
    div.appendChild(span);
    container.appendChild(div);
}

// AI quick-prompt shortcut
async function aiQuickSend(type, message) {
    const txt = document.getElementById('txt');
    txt.value = message;
    await sendToCommander(message, type);
    txt.value = '';
}

// ── AI Persistence ─────────────────────────────────────────────────────────────
let aiHistoryInitialized = false;

async function loadAiHistory() {
    try {
        const res = await fetch('/ai-history');
        const data = await res.json();
        renderAiHistory(data.history || []);
    } catch(e) {}
}

function renderAiHistory(history) {
    const aiChat = document.getElementById('aiChat');
    const isAtBottom = typeof aiChat.scrollHeight === 'number' && (Math.abs(aiChat.scrollHeight - aiChat.clientHeight - aiChat.scrollTop) < 15);
    
    const historyIds = new Set(history.map(h => h.id));
    Array.from(aiChat.children).forEach(child => {
        if (child.id && !historyIds.has(child.id)) {
            child.remove();
        }
    });

    history.forEach(item => {
        let el = document.getElementById(item.id);
        if (!el) {
            el = document.createElement('div');
            el.id = item.id;
            aiChat.appendChild(el);
        }
        
        el.className = item.role === 'user' ? 'bubble bubble-user' : (item.pending ? 'bubble bubble-thinking' : 'bubble bubble-ai');
        el.innerHTML = '';
        if (item.label && item.role === 'ai') {
            const lbl = document.createElement('strong');
            lbl.textContent = item.label;
            el.appendChild(lbl);
        }
        const span = document.createElement('span');
        span.textContent = item.text;
        el.appendChild(span);
    });
    
    if (!aiHistoryInitialized || isAtBottom) {
        snapToBottom();
        aiHistoryInitialized = true;
    }
}

async function aiClearHistory() {
    if (!confirm('Clear all AI-Director history?')) return;
    await fetch('/ai-clear', { method: 'POST' });
    document.getElementById('aiChat').innerHTML = '';
    await loadAiHistory();
}

setInterval(() => {
    if (document.body.classList.contains('mode-commander')) {
        loadAiHistory();
    }
}, 3000);

// ── Browser quick-action (existing) ───────────────────────────────────────────
async function quickSend(message) {
    const btn = event.target;
    btn.style.background = 'var(--orange-dim)';
    btn.style.color = 'var(--orange)';
    try {
        await fetch('/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message })
        });
    } finally {
        setTimeout(() => { btn.style.background = ''; btn.style.color = ''; }, 600);
    }
}

// ── CDP button click (existing) ────────────────────────────────────────────────
async function quickClick(label) {
    const btn = event ? event.target : null;
    if (btn) { btn.style.background = '#ff6a00'; btn.style.color = '#000'; btn.textContent = '⏳'; }
    try {
        const res    = await fetch('/click', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ label })
        });
        const result = await res.json();
        if (btn) btn.textContent = result.clicked ? '✓ ' + label : '✗ ' + label;
    } finally {
        setTimeout(() => {
            if (btn) { btn.style.background = ''; btn.style.color = ''; btn.textContent = label; }
        }, 1500);
    }
}

// ── File upload ────────────────────────────────────────────────────────────────
const fileInput = document.getElementById('fileInput');
const fileIcon  = document.getElementById('fileIcon');

fileInput.addEventListener('change', async () => {
    if (!fileInput.files.length) return;
    const btn = document.querySelector('.file-upload-btn');
    const orig = fileIcon.textContent;
    fileIcon.textContent = '⏳';
    btn.style.pointerEvents = 'none';

    try {
        for (const file of fileInput.files) {
            if (currentMode === 'director') {
                // Director handles its own file attach via dirFileInput — skip
                continue;
            } else if (currentMode === 'commander') {
                // Route to AI upload endpoint
                const promptText = document.getElementById('txt').value.trim() || 'Describe this file';
                document.getElementById('txt').value = '';
                const aiChat = document.getElementById('aiChat');
                appendBubble(aiChat, 'user', `📎 ${file.name}: ${promptText}`);

                const thinking = document.createElement('div');
                thinking.className = 'bubble bubble-thinking';
                thinking.textContent = '🎯 AI-Director is processing file…';
                aiChat.appendChild(thinking);
                snapToBottom();

                try {
                    const res = await fetch(
                        `/ai-upload?name=${encodeURIComponent(file.name)}&prompt=${encodeURIComponent(promptText)}&type=quick`,
                        {
                            method: 'POST',
                            headers: { 'Content-Type': file.type || 'application/octet-stream' },
                            body: file
                        }
                    );
                    const data = await res.json();
                    thinking.remove();
                    appendBubble(aiChat, 'ai', data.error ? '⚠️ ' + data.error : (data.response || '(no response)'), 'AI-Director');
                } catch (e) {
                    thinking.remove();
                    appendBubble(aiChat, 'ai', '⚠️ Upload error: ' + e.message, 'AI-Director');
                }
                snapToBottom();
            } else {
                // Existing CDP file inject
                const res = await fetch(`/upload?name=${encodeURIComponent(file.name)}&type=${encodeURIComponent(file.type)}`, {
                    method: 'POST',
                    headers: { 'Content-Type': file.type || 'application/octet-stream' },
                    body: file
                });
                const result = await res.json();
                if (!result.success) alert('Upload failed: ' + result.error);
            }
        }
    } catch (e) {
        alert('Upload error: ' + e.message);
    } finally {
        fileIcon.textContent = orig;
        btn.style.pointerEvents = 'auto';
        fileInput.value = '';
    }
});

// Drag and drop
document.body.addEventListener('dragover', e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
document.body.addEventListener('drop', e => {
    e.preventDefault();
    if (e.dataTransfer.files.length) {
        fileInput.files = e.dataTransfer.files;
        fileInput.dispatchEvent(new Event('change'));
    }
});

// ── Dialog scanner (CDP browser mode only) ─────────────────────────────────────
async function scanDialogActions() {
    try {
        const r    = await (await fetch('/scan-actions')).json();
        const btns = r.buttons || [];
        const key  = btns.join('|');
        if (key === lastDialogKey) return;
        lastDialogKey = key;

        const bar    = document.getElementById('dialogBar');
        const body   = document.getElementById('dialogBody');
        const icon   = document.getElementById('dialogCollapseIcon');
        const prompt = document.getElementById('dialogPrompt');
        const wrap   = document.getElementById('dialogBtns');

        if (!btns.length) {
            if (bar) bar.style.display = 'none';
            dialogCollapsed = false;
            return;
        }

        dialogCollapsed = false;
        if (body) body.style.display = 'block';
        if (icon) icon.textContent = '▾';
        if (bar && currentMode !== 'commander') bar.style.display = 'block';
        if (prompt) prompt.textContent = r.prompt || '';

        if (wrap) {
            wrap.innerHTML = btns.map(t => {
                const safe = t.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
                return `<button class="dialog-btn" onclick="quickClick('${safe}')">${t}</button>`;
            }).join('');
        }
    } catch (_) {}
}

function toggleDialogBar() {
    dialogCollapsed = !dialogCollapsed;
    const body = document.getElementById('dialogBody');
    const icon = document.getElementById('dialogCollapseIcon');
    if (body) body.style.display = dialogCollapsed ? 'none' : 'block';
    if (icon) icon.textContent = dialogCollapsed ? '▸' : '▾';
}

// ── Stats modal ────────────────────────────────────────────────────────────────
function toggleStats() {
    const modal = document.getElementById('statsModal');
    statsOpen = !statsOpen;
    modal.classList.toggle('open', statsOpen);
    if (statsOpen) loadStats();
}

function fmt(bytes)    { return (bytes / 1024 / 1024).toFixed(1) + ' MB'; }
function fmtUptime(s)  {
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    return h > 0 ? `${h}h ${m}m` : `${m}m ${Math.floor(s % 60)}s`;
}

async function loadStats() {
    try {
        const d = await (await fetch('/stats')).json();
        document.getElementById('s-bridge').textContent  = '● Running';
        document.getElementById('s-targets').textContent = d.targetCount ?? '—';
        document.getElementById('s-active').textContent  = d.activeTitle ?? 'None';
        document.getElementById('s-uptime').textContent  = fmtUptime(d.uptime);
        document.getElementById('s-mem').textContent     = fmt(d.memRss);
        document.getElementById('s-cpu').textContent     = d.loadAvg + ' avg';
        document.getElementById('s-heap').textContent    = fmt(d.heapUsed) + ' / ' + fmt(d.heapTotal);
    } catch (_) {
        document.getElementById('s-bridge').textContent = '⚠ Offline';
    }
}

document.getElementById('statsModal').addEventListener('click', e => {
    if (e.target === e.currentTarget) toggleStats();
});

// ── Keyboard shortcut ──────────────────────────────────────────────────────────
document.getElementById('txt').addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') sendMsg();
});

// ── Init ───────────────────────────────────────────────────────────────────────
setMode('browser');
connectSocket();

// Agent Manager: auto-lock on load, refresh every 6s
refreshManagerPill();
setInterval(refreshManagerPill, 6000);

// Secondary window list
refreshWindowList();
setInterval(refreshWindowList, 8000);

// Restore initial snapshot (browser text)
(async () => {
    try {
        const snap = await (await fetch('/snapshot')).json();
        if (snap.text) { streamEl.textContent = snap.text; snapToBottom(); }
    } catch (_) {}
})();
