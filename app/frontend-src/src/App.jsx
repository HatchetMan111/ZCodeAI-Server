import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { marked } from 'marked';
import { api, streamMessage } from './api.js';

marked.setOptions({ breaks: true, gfm: true });

// HTML vorher escapen → LLM-Ausgabe kann keine Skripte einschleusen
const escapeHtml = (s) =>
    String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const mdToHtml = (text) => ({ __html: marked.parse(escapeHtml(text || '')) });

const TOOL_ICONS = {
    list_dir: '📂', read_file: '📖', write_file: '✏️',
    edit_file: '🩹', run_command: '⌨️', finish: '🏁',
};

const BASE_PRESETS = [
    { label: 'Z.ai Coding-Plan', url: 'https://api.z.ai/api/coding/paas/v4' },
    { label: 'Z.ai Pay-as-you-go', url: 'https://api.z.ai/api/paas/v4' },
    { label: 'OpenRouter', url: 'https://openrouter.ai/api/v1' },
    { label: 'Ollama (lokal)', url: 'http://<host>:11434/v1' },
];

// ── Markdown-Bubble ──────────────────────────────────────────────────────────
function Bubble({ item }) {
    return (
        <div className={`bubble ${item.kind}`}>
            {item.kind === 'user' ? <span>{item.text}</span> : <div className="md" dangerouslySetInnerHTML={mdToHtml(item.text)} />}
        </div>
    );
}

// ── Diff-Ansicht ─────────────────────────────────────────────────────────────
function DiffView({ diff }) {
    if (!diff || diff.length === 0) return null;
    return (
        <div className="diff mono">
            {diff.map((l, i) => (
                <div key={i} className={`dl ${l.t === '+' ? 'add' : l.t === '-' ? 'del' : 'ctx'}`}>
                    <span className="dlt">{l.t}</span><span>{l.text}</span>
                </div>
            ))}
        </div>
    );
}

// ── Tool-Karte ───────────────────────────────────────────────────────────────
function ToolCard({ item, defaultOpen }) {
    const [open, setOpen] = useState(defaultOpen || false);
    const preview = item.command ? `$ ${item.command}` :
        item.path ? item.path :
        (item.content || '').split('\n')[0]?.slice(0, 90) || '';
    const stateCls = item.ok === true ? 'ok' : item.ok === false ? 'err' : 'wait';
    const stateIcon = item.ok === true ? '✔' : item.ok === false ? '✘' : '⏳';
    return (
        <div className={`toolcard ${stateCls}`}>
            <button className="tc-head" onClick={() => setOpen(o => !o)}>
                <span className="tc-state">{stateIcon}</span>
                <span className="tc-icon">{TOOL_ICONS[item.name] || '🔧'}</span>
                <span className="tc-name">{item.name}</span>
                <span className="tc-preview mono">{preview}</span>
                {item.durationMs ? <span className="tc-dur">{(item.durationMs / 1000).toFixed(1)} s</span> : null}
                <span className="tc-arrow">{open ? '▾' : '▸'}</span>
            </button>
            {open && (
                <div className="tc-body">
                    {item.diff && item.diff.length > 0 && <DiffView diff={item.diff} />}
                    {item.content && (!item.diff || item.name !== 'write_file' && item.name !== 'edit_file') && (
                        <pre className="mono">{item.content.length > 8000 ? item.content.slice(0, 8000) + '\n… [gekürzt]' : item.content}</pre>
                    )}
                </div>
            )}
        </div>
    );
}

// ── Bestätigungs-Banner („Ask before changes") ───────────────────────────────
function ConfirmBanner({ confirm, onResolve, busy }) {
    return (
        <div className="confirm-banner">
            <div className="cb-title">⚠️ Befehl freigeben? (Bestätigungsmodus aktiv)</div>
            <pre className="mono cb-cmd">{confirm.command}</pre>
            <div className="cb-actions">
                <button className="btn primary" disabled={busy} onClick={() => onResolve(true)}>✔ Ausführen</button>
                <button className="btn danger-ghost" disabled={busy} onClick={() => onResolve(false)}>✘ Ablehnen</button>
            </div>
        </div>
    );
}

// ── Einstellungs-Modal ───────────────────────────────────────────────────────
function SettingsModal({ initial, onClose, onSaved }) {
    const [baseUrl, setBaseUrl] = useState(initial.baseUrl);
    const [apiKey, setApiKey] = useState('');
    const [model, setModel] = useState(initial.model);
    const [confirmMode, setConfirmMode] = useState(initial.confirmMode);
    const [models, setModels] = useState([]);
    const [testResult, setTestResult] = useState(null);
    const [busy, setBusy] = useState(false);
    const [err, setErr] = useState('');

    const doTest = async () => {
        setBusy(true); setTestResult(null); setErr('');
        try {
            await api.putSettings({ baseUrl, model, confirmMode, ...(apiKey ? { apiKey } : {}) });
            const r = await api.testConnection();
            setTestResult(r);
        } catch (e) { setErr(e.message); }
        setBusy(false);
    };
    const doModels = async () => {
        setBusy(true); setErr('');
        try {
            await api.putSettings({ baseUrl, ...(apiKey ? { apiKey } : {}) });
            const r = await api.loadModels();
            if (r.ok) setModels(r.models); else setErr(r.error || `HTTP ${r.status}: ${(r.body || '').slice(0, 200)}`);
        } catch (e) { setErr(e.message); }
        setBusy(false);
    };
    const doSave = async () => {
        setBusy(true); setErr('');
        try {
            await api.putSettings({ baseUrl, model, confirmMode, ...(apiKey ? { apiKey } : {}) });
            onSaved(); onClose();
        } catch (e) { setErr(e.message); }
        setBusy(false);
    };

    return (
        <div className="modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
            <div className="modal">
                <h2>⚙️ Einstellungen</h2>
                <label>API-Endpoint (OpenAI-kompatible Base-URL)</label>
                <div className="presets">
                    {BASE_PRESETS.map(p => (
                        <button key={p.url} className={`chip ${baseUrl === p.url ? 'active' : ''}`}
                            onClick={() => setBaseUrl(p.url)}>{p.label}</button>
                    ))}
                </div>
                <input className="mono" value={baseUrl} onChange={e => setBaseUrl(e.target.value)}
                    placeholder="https://api.z.ai/api/coding/paas/v4" />
                <label>API-Key {initial.hasKey && <span className="muted">(gespeichert – leer lassen = unverändert)</span>}</label>
                <input type="password" value={apiKey} onChange={e => setApiKey(e.target.value)}
                    placeholder={initial.hasKey ? '••••••••••' : 'z.B. Z.ai-Key aus z.ai-manage → API-Keys'} />
                <label>Modell</label>
                <div className="model-row">
                    <input className="mono" value={model} onChange={e => setModel(e.target.value)} list="model-list" />
                    <datalist id="model-list">{models.map(m => <option key={m} value={m} />)}</datalist>
                    <button className="btn ghost" disabled={busy} onClick={doModels}>Modelle laden</button>
                </div>
                <label className="check">
                    <input type="checkbox" checked={confirmMode} onChange={e => setConfirmMode(e.target.checked)} />
                    Bestätigungsmodus – Bash-Befehle vor Ausführung freigeben („Ask before changes")
                </label>
                {testResult && (
                    <div className={testResult.ok ? 'test-ok' : 'test-err'}>
                        {testResult.ok
                            ? `✔ Verbunden (${testResult.latencyMs} ms): ${testResult.reply}`
                            : `✘ Fehler: ${testResult.error || `HTTP ${testResult.status}: ${(testResult.body || '').slice(0, 300)}`}`}
                    </div>
                )}
                {err && <div className="test-err">✘ {err}</div>}
                <div className="modal-actions">
                    <button className="btn ghost" disabled={busy} onClick={doTest}>Verbindung testen</button>
                    <button className="btn primary" disabled={busy} onClick={doSave}>Speichern</button>
                    <button className="btn ghost" onClick={onClose}>Abbrechen</button>
                </div>
            </div>
        </div>
    );
}

// ── Haupt-App ────────────────────────────────────────────────────────────────
export default function App() {
    const [health, setHealth] = useState(null);
    const [workspaces, setWorkspaces] = useState([]);
    const [ws, setWs] = useState(() => localStorage.getItem('zc.ws') || '');
    const [newWs, setNewWs] = useState('');
    const [sessions, setSessions] = useState([]);
    const [sessId, setSessId] = useState(null);
    const [items, setItems] = useState([]);
    const [running, setRunning] = useState(false);
    const [statusText, setStatusText] = useState('');
    const [confirm, setConfirm] = useState(null);
    const [settings, setSettings] = useState(null);
    const [showSettings, setShowSettings] = useState(false);
    const [toast, setToast] = useState('');
    const [input, setInput] = useState('');

    const abortRef = useRef(null);
    const chatEndRef = useRef(null);
    const inputRef = useRef(null);

    const showToast = useCallback((msg) => {
        setToast(msg);
        setTimeout(() => setToast(''), 5000);
    }, []);

    // Initial laden
    useEffect(() => {
        api.health().then(h => setHealth(h)).catch(e => showToast('Server nicht erreichbar: ' + e.message));
        api.getSettings().then(setSettings).catch(() => {});
    }, [showToast]);

    useEffect(() => {
        api.listWorkspaces().then(r => {
            setWorkspaces(r.workspaces);
            if (!ws && r.workspaces.length > 0) setWs(r.workspaces[0]);
        }).catch(() => {});
    }, [ws]); // eslint-disable-line

    useEffect(() => {
        if (localStorage.getItem('zc.ws') !== ws) localStorage.setItem('zc.ws', ws);
        setSessions([]); setSessId(null); setItems([]); setConfirm(null);
        if (ws) {
            api.listSessions(ws).then(r => setSessions(r.sessions)).catch(() => {});
        }
    }, [ws]);

    useEffect(() => {
        chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [items, statusText, confirm]);

    // ── Session laden & Stored-Messages → Anzeige-Items ──
    const openSession = async (id) => {
        if (running) return;
        try {
            const s = await api.getSession(id);
            setSessId(id);
            setConfirm(null);
            const mapped = [];
            const openCards = []; // noch nicht befüllte Tool-Karten (aus tool_calls)
            for (const msg of s.messages || []) {
                if (msg.role === 'user') {
                    mapped.push({ kind: 'user', text: msg.content });
                } else if (msg.role === 'assistant') {
                    if (msg.content) mapped.push({ kind: 'assistant', text: msg.content });
                    for (const tc of msg.tool_calls || []) {
                        let args = {};
                        try { args = JSON.parse(tc.function.arguments || '{}'); } catch { /* egal */ }
                        const card = {
                            kind: 'tool', name: tc.function.name, ok: null,
                            command: args.command, path: args.path,
                            content: args.summary ? `Zusammenfassung: ${args.summary}` : '',
                            diff: null,
                        };
                        mapped.push(card);
                        openCards.push({ id: tc.id, card });
                    }
                } else if (msg.role === 'tool') {
                    const hit = openCards.find(o => o.id === msg.tool_call_id);
                    const card = hit ? hit.card : { kind: 'tool', name: msg.name };
                    card.content = msg.content;
                    if (!hit) mapped.push(card);
                }
            }
            setItems(mapped);
        } catch (e) { showToast('Session laden fehlgeschlagen: ' + e.message); }
    };

    // ── SSE-Events → Anzeige-Items ──
    const handleEvent = (ev) => {
        setItems(prev => {
            const next = [...prev];
            switch (ev.type) {
                case 'delta': {
                    const last = next[next.length - 1];
                    if (last && last.kind === 'assistant' && last.streaming) {
                        next[next.length - 1] = { ...last, text: last.text + ev.text };
                    } else {
                        next.push({ kind: 'assistant', text: ev.text, streaming: true });
                    }
                    break;
                }
                case 'status': setStatusText(ev.text); break;
                case 'tool_result': {
                    // laufende Assistant-Bubble abschließen
                    const last = next[next.length - 1];
                    if (last && last.streaming) next[next.length - 1] = { ...last, streaming: false };
                    next.push({
                        kind: 'tool', name: ev.name, ok: ev.ok, content: ev.content,
                        diff: ev.diff, path: ev.path, command: ev.command,
                        durationMs: ev.durationMs, open: !ev.ok,
                    });
                    break;
                }
                case 'confirm_required': setConfirm({ pendingId: ev.pendingId, command: ev.command }); break;
                case 'error': {
                    const last = next[next.length - 1];
                    if (last && last.streaming) next[next.length - 1] = { ...last, streaming: false };
                    next.push({ kind: 'error', text: ev.message });
                    break;
                }
                case 'done': {
                    const last = next[next.length - 1];
                    if (last && last.streaming) next[next.length - 1] = { ...last, streaming: false };
                    setStatusText('');
                    break;
                }
                default: break;
            }
            return next;
        });
    };

    // ── Senden ──
    const send = async () => {
        const content = input.trim();
        if (!content || running) return;
        if (!ws) { showToast('Erst einen Workspace anlegen/wählen.'); return; }
        if (settings && !settings.hasKey) { showToast('Kein API-Key gesetzt – Einstellungen öffnen.'); setShowSettings(true); return; }
        setInput('');
        setItems(prev => [...prev, { kind: 'user', text: content }]);
        setRunning(true); setStatusText('…');

        try {
            let id = sessId;
            if (!id) {
                const s = await api.createSession(ws);
                id = s.id; setSessId(id);
                api.listSessions(ws).then(r => setSessions(r.sessions)).catch(() => {});
            }
            const ctrl = new AbortController();
            abortRef.current = ctrl;
            await streamMessage(id, content, handleEvent, ctrl.signal);
            api.listSessions(ws).then(r => setSessions(r.sessions)).catch(() => {});
        } catch (e) {
            if (e.name !== 'AbortError') {
                setItems(prev => [...prev, { kind: 'error', text: e.message }]);
            }
        } finally {
            setRunning(false); setStatusText(''); setConfirm(null);
            abortRef.current = null;
            inputRef.current?.focus();
        }
    };

    const stop = async () => {
        abortRef.current?.abort();
        if (sessId) { try { await api.stop(sessId); } catch { /* egal */ } }
    };

    const resolveConfirm = async (approved) => {
        if (!confirm || !sessId) return;
        const { pendingId } = confirm;
        setConfirm(null);
        try { await api.confirm(sessId, pendingId, approved); }
        catch (e) { showToast('Bestätigung fehlgeschlagen: ' + e.message); }
    };

    const addWorkspace = async () => {
        const name = newWs.trim();
        if (!name) return;
        try {
            const r = await api.createWorkspace(name);
            setWorkspaces(r.workspaces); setWs(name); setNewWs('');
        } catch (e) { showToast(e.message); }
    };

    const removeSession = async (id, e) => {
        e.stopPropagation();
        if (!window.confirm('Session löschen?')) return;
        await api.deleteSession(id).catch(() => {});
        if (id === sessId) { setSessId(null); setItems([]); }
        api.listSessions(ws).then(r => setSessions(r.sessions)).catch(() => {});
    };

    const keyMissing = settings && !settings.hasKey;

    return (
        <div className="app">
            {/* Sidebar */}
            <aside className="sidebar">
                <div className="logo"><span className="logo-dot" /> ZCode-Server</div>
                <div className="ws-box">
                    <select value={ws} onChange={e => setWs(e.target.value)}>
                        <option value="" disabled>Workspace wählen…</option>
                        {workspaces.map(w => <option key={w} value={w}>{w}</option>)}
                    </select>
                    <div className="ws-new">
                        <input placeholder="neuer-workspace" value={newWs}
                            onChange={e => setNewWs(e.target.value)}
                            onKeyDown={e => { if (e.key === 'Enter') addWorkspace(); }} />
                        <button className="btn ghost small" onClick={addWorkspace}>+</button>
                    </div>
                </div>
                <button className="btn ghost block" onClick={async () => {
                    if (!ws) return;
                    const s = await api.createSession(ws).catch(e2 => { showToast(e2.message); return null; });
                    if (s) { setSessId(s.id); setItems([]); setConfirm(null);
                        api.listSessions(ws).then(r => setSessions(r.sessions)).catch(() => {});
                    }
                }}>＋ Neue Session</button>
                <div className="session-list">
                    {sessions.map(s => (
                        <div key={s.id} className={`sess ${s.id === sessId ? 'active' : ''}`}
                            onClick={() => openSession(s.id)}>
                            <span className="sess-title">{s.title}</span>
                            <button className="sess-del" onClick={(e) => removeSession(s.id, e)}>×</button>
                        </div>
                    ))}
                    {sessions.length === 0 && <div className="muted small-note">Noch keine Sessions in „{ws || '—'}".</div>}
                </div>
                <div className="sidebar-foot">
                    <button className="btn ghost block" onClick={() => setShowSettings(true)}>⚙️ Einstellungen{keyMissing ? ' 🔑' : ''}</button>
                    <div className="muted tiny">
                        v{health?.version || '?'} · {settings?.model || health?.model || '—'}{confirmModeBadge(settings)}
                    </div>
                </div>
            </aside>

            {/* Hauptbereich */}
            <main className="main">
                <header className="topbar">
                    <div className="topbar-title">
                        {sessId ? sessions.find(s => s.id === sessId)?.title || 'Session' : 'ZCode-Server'}
                        <span className="ws-badge">{ws || 'kein Workspace'}</span>
                    </div>
                    {running && <span className="status">⟳ {statusText || 'läuft…'}</span>}
                </header>

                <div className="chat">
                    {items.length === 0 && (
                        <div className="hero">
                            <div className="hero-logo">⚡</div>
                            <h1>ZCode-Server</h1>
                            <p>Lokaler Coding-Agent im Stil von zcode.z.ai – Agent-Chat mit Datei-Tools, Diffs und Bash im Workspace.</p>
                            {keyMissing && (
                                <p className="hint-warn">🔑 Noch kein API-Key – <button className="linklike" onClick={() => setShowSettings(true)}>Einstellungen öffnen</button> und Z.ai-Key hinterlegen.</p>
                            )}
                            {!ws && <p className="hint-warn">📂 Links einen Workspace anlegen oder wählen.</p>}
                        </div>
                    )}
                    {items.map((it, i) => {
                        if (it.kind === 'user' || it.kind === 'assistant') return <Bubble key={i} item={it} />;
                        if (it.kind === 'tool') return <ToolCard key={i} item={it} defaultOpen={it.open} />;
                        if (it.kind === 'error') return <div key={i} className="errbox mono">{it.text}</div>;
                        return null;
                    })}
                    {confirm && <ConfirmBanner confirm={confirm} onResolve={resolveConfirm} busy={false} />}
                    <div ref={chatEndRef} />
                </div>

                <div className="composer">
                    <textarea
                        ref={inputRef}
                        value={input}
                        placeholder={ws ? 'Aufgabe beschreiben… (Enter = senden, Shift+Enter = Zeilenumbruch)' : 'Zuerst links einen Workspace wählen/anlegen'}
                        onChange={e => setInput(e.target.value)}
                        onKeyDown={e => {
                            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
                        }}
                        disabled={running}
                        rows={2}
                    />
                    {running
                        ? <button className="btn danger" onClick={stop}>■ Stop</button>
                        : <button className="btn primary" onClick={send} disabled={!input.trim() || !ws}>➤ Senden</button>}
                </div>
            </main>

            {showSettings && settings && (
                <SettingsModal
                    initial={settings}
                    onClose={() => setShowSettings(false)}
                    onSaved={async () => {
                        const s = await api.getSettings().catch(() => null);
                        if (s) setSettings(s);
                        api.health().then(setHealth).catch(() => {});
                        showToast('Einstellungen gespeichert.');
                    }}
                />
            )}
            {toast && <div className="toast">{toast}</div>}
        </div>
    );
}

function confirmModeBadge(settings) {
    if (!settings) return '';
    return settings.confirmMode ? ' · Bestätigungsmodus' : '';
}
