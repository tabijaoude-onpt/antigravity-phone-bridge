// ── Director Mode ──────────────────────────────────────────────────────────────
// Handles Director tab: sends messages to Antigravity via Bridge /director,
// streams response back via SSE, supports file attachments via /ai-upload.

let directorMode = 'auto';
let directorBusy = false;
let directorPendingFile = null;  // { file, name } — attached before send

function setDirMode(mode) {
    directorMode = mode;
    document.querySelectorAll('.dir-mode-btn').forEach(b => b.classList.remove('active'));
    const btn = document.getElementById('dirMode-' + mode);
    if (btn) btn.classList.add('active');
}

// Called by quick-action buttons and sendMsg() dispatcher
async function sendDirector(overrideMsg, overrideMode) {
    if (directorBusy) return;

    const txt   = document.getElementById('txt');
    const msg   = overrideMsg != null ? overrideMsg : (txt ? txt.value.trim() : '');
    const mode  = overrideMode != null ? overrideMode : directorMode;

    // Need at least a message OR a file
    if (!msg && !directorPendingFile) return;

    directorBusy = true;
    const sendBtn = document.getElementById('sendBtn');
    if (sendBtn) sendBtn.disabled = true;
    if (txt && overrideMsg == null) txt.value = '';

    const chat = document.getElementById('directorChat');

    // ── User bubble ──────────────────────────────────────────────────────────
    const userBubble = document.createElement('div');
    userBubble.className = 'dir-bubble-user';
    const displayMsg = directorPendingFile
        ? (msg ? `📎 ${directorPendingFile.name}: ${msg}` : `📎 ${directorPendingFile.name}`)
        : msg;
    userBubble.textContent = displayMsg;
    chat.appendChild(userBubble);

    const statusEl = document.createElement('div');
    statusEl.className = 'dir-bubble-status';
    statusEl.textContent = '⏳ Sending to Antigravity…';
    chat.appendChild(statusEl);
    chat.scrollTop = chat.scrollHeight;

    const agBubble = document.createElement('div');
    agBubble.className = 'dir-bubble-ag';
    agBubble.innerHTML = '<strong>🎯 Antigravity Director</strong><span class="dir-response-text"></span>';
    let responseEl = null;
    let accumulated = '';

    try {
        // ── If file attached, upload it first then include path in message ──
        let finalMsg = msg;
        if (directorPendingFile) {
            statusEl.textContent = '⏳ Uploading file…';
            const file = directorPendingFile.file;
            const uploadRes = await fetch(
                `/ai-upload?name=${encodeURIComponent(file.name)}&prompt=${encodeURIComponent(msg || 'Describe this file')}&type=${mode}`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': file.type || 'application/octet-stream' },
                    body: file
                }
            );
            const uploadData = await uploadRes.json();
            // For director mode we use the file path directly in message to Antigravity
            finalMsg = msg
                ? `${msg}\n\nAttached file saved at: ${uploadData.file || 'see /tmp'}`
                : `Please review the attached file: ${file.name}`;
            directorPendingFile = null;
            updateDirAttachBtn();
        }

        // ── Stream from /director ────────────────────────────────────────────
        statusEl.textContent = '⏳ Sending to Antigravity…';
        const resp = await fetch('/director', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
            body: JSON.stringify({ message: finalMsg, mode })
        });

        const reader = resp.body.getReader();
        const dec    = new TextDecoder();
        let buf = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            const lines = buf.split('\n');
            buf = lines.pop();

            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                try {
                    const obj = JSON.parse(line.slice(6));

                    if (obj.type === 'status') {
                        statusEl.textContent = '⏳ ' + obj.data;

                    } else if (obj.type === 'delta') {
                        if (!responseEl) {
                            statusEl.remove();
                            chat.appendChild(agBubble);
                            responseEl = agBubble.querySelector('.dir-response-text');
                        }
                        accumulated += obj.data;
                        responseEl.textContent = accumulated;
                        chat.scrollTop = chat.scrollHeight;

                    } else if (obj.type === 'done') {
                        if (!responseEl) {
                            statusEl.remove();
                            chat.appendChild(agBubble);
                            responseEl = agBubble.querySelector('.dir-response-text');
                        }
                        const finalText = (obj.data && obj.data.response) ? obj.data.response : accumulated;
                        responseEl.textContent = finalText || '(no response captured — is an Antigravity window open?)';
                        if (obj.data && obj.data.elapsed) {
                            const el = document.createElement('div');
                            el.style.cssText = 'font-size:10px;color:rgba(245,158,11,0.5);margin-top:6px;';
                            el.textContent = '⏱ ' + obj.data.elapsed + 's';
                            agBubble.appendChild(el);
                        }

                    } else if (obj.type === 'error') {
                        statusEl.textContent = '❌ ' + obj.data;
                        statusEl.style.color = '#ff4444';
                        statusEl.style.animation = 'none';
                    }
                } catch (_) {}
            }
        }

    } catch (e) {
        statusEl.textContent = '❌ ' + e.message;
        statusEl.style.color = '#ff4444';
        statusEl.style.animation = 'none';
    }

    chat.scrollTop = chat.scrollHeight;
    directorBusy = false;
    if (sendBtn) sendBtn.disabled = false;
}

// ── File attachment for Director mode ────────────────────────────────────────
function dirAttachFile(input) {
    if (!input.files.length) return;
    directorPendingFile = { file: input.files[0], name: input.files[0].name };
    updateDirAttachBtn();
    input.value = '';
}

function updateDirAttachBtn() {
    const btn = document.getElementById('dirAttachIcon');
    if (!btn) return;
    if (directorPendingFile) {
        btn.textContent = '✅';
        btn.title = directorPendingFile.name + ' — tap to remove';
    } else {
        btn.textContent = '📎';
        btn.title = 'Attach file';
    }
}

function dirClearAttach() {
    if (directorPendingFile) {
        directorPendingFile = null;
        updateDirAttachBtn();
    }
}
