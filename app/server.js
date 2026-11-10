#!/usr/bin/env node
// =============================================================================
//  ⚡ ZCode-Server – lokale KI-Agent-Web-App im Stil von zcode.z.ai
//  https://github.com/HatchetMan111/ZCodeAI-Server
//
//  Pure-Node-Backend (KEINE npm-Abhängigkeiten – läuft mit Debian-12-nodejs):
//   – statisches React-Frontend aus ./static
//   – Agent-Loop gegen jede OpenAI-kompatible Chat-API (Default: Z.ai
//     Coding-Plan https://api.z.ai/api/coding/paas/v4), SSE-Streaming
//   – Tools: list_dir, read_file, write_file, edit_file, run_command, finish
//   – Workspaces sandboxed unter ${ZCODE_HOME}/workspaces, Sessions als JSON
//
//  Umgebungsvariablen: ZCODE_PORT (8090), ZCODE_HOME (/opt/zcode-server)
// =============================================================================

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { exec } = require('child_process');

const VERSION = '1.0.0';
const PORT = parseInt(process.env.ZCODE_PORT || '8090', 10);
const HOME_DIR = process.env.ZCODE_HOME || '/opt/zcode-server';
const DATA_DIR = path.join(HOME_DIR, 'data');
const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');
const WORKSPACES_DIR = path.join(HOME_DIR, 'workspaces');
const STATIC_DIR = path.join(__dirname, 'static');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

const MAX_ITERATIONS = parseInt(process.env.ZCODE_MAX_ITER || '25', 10);
const READ_FILE_CAP = 100 * 1024;   // LLM liest max. 100 KB pro Datei
const TOOL_OUTPUT_CAP = 32 * 1024;  // LLM sieht max. 32 KB Tool-Output
const BODY_LIMIT = 2 * 1024 * 1024;
const CONFIRM_TIMEOUT_MS = 10 * 60 * 1000; // Bestätigungsmodus: 10 min warten

const DEFAULT_SETTINGS = {
    baseUrl: 'https://api.z.ai/api/coding/paas/v4',
    apiKey: '',
    model: 'glm-5.3',
    confirmMode: true,
};

// ── Mini-Logger ─────────────────────────────────────────────────────────────
function log(level, msg) {
    const line = `[${new Date().toISOString()}] [${level}] ${msg}`;
    if (level === 'ERROR') console.error(line); else console.log(line);
}

// ── Storage ─────────────────────────────────────────────────────────────────
function ensureDirs() {
    for (const d of [DATA_DIR, SESSIONS_DIR, WORKSPACES_DIR]) {
        try {
            fs.mkdirSync(d, { recursive: true });
        } catch (e) {
            console.error(`FEHLER: Verzeichnis ${d} nicht anlegbar (${e.code}) – ZCODE_HOME=${HOME_DIR} beschreibbar?`);
            process.exit(1);
        }
    }
}

function loadSettings() {
    try {
        const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
        return { ...DEFAULT_SETTINGS, ...raw };
    } catch {
        return { ...DEFAULT_SETTINGS };
    }
}

function saveSettings(s) {
    const tmp = SETTINGS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(s, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, SETTINGS_FILE);
    try { fs.chmodSync(SETTINGS_FILE, 0o600); } catch { /* unprivilegiert: egal */ }
}

function sessionFile(id) {
    return path.join(SESSIONS_DIR, id.replace(/[^a-zA-Z0-9_-]/g, '') + '.json');
}

function loadSession(id) {
    const f = sessionFile(id);
    if (!fs.existsSync(f)) return null;
    try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; }
}

function saveSession(sess) {
    sess.updatedAt = new Date().toISOString();
    const f = sessionFile(sess.id);
    const tmp = f + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(sess, null, 2));
    fs.renameSync(tmp, f);
}

function newId() {
    return crypto.randomBytes(8).toString('hex');
}

// Workspace-Namen strikt begrenzen (Pfad-Sandbox beginnt hier)
const WS_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

function listWorkspaces() {
    try {
        return fs.readdirSync(WORKSPACES_DIR, { withFileTypes: true })
            .filter(d => d.isDirectory())
            .map(d => d.name)
            .sort();
    } catch {
        return [];
    }
}

// ── Pfad-Sandbox: nie aus dem Workspace heraus ──────────────────────────────
function safePath(wsRoot, rel) {
    const p = path.resolve(wsRoot, rel || '.');
    const root = path.resolve(wsRoot);
    if (p === root || p.startsWith(root + path.sep)) return p;
    throw new Error(`Pfad "${rel}" verlässt den Workspace – nicht erlaubt.`);
}

// ── Einfacher Zeilen-Diff (für Tool-Karten im UI) ───────────────────────────
function lineDiff(oldText, newText) {
    const a = String(oldText).split('\n');
    const b = String(newText).split('\n');
    // LCS-Tabelle bei riesigen Dateien abschalten (Kosten n*m)
    if (a.length * b.length > 4_000_000) {
        return [{ t: '~', text: `(Datei zu groß für Diff: ${a.length}→${b.length} Zeilen)` }];
    }
    const n = a.length, m = b.length;
    const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
            dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
    }
    const out = [];
    let i = 0, j = 0;
    while (i < n && j < m) {
        if (a[i] === b[j]) { out.push({ t: ' ', text: a[i] }); i++; j++; }
        else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ t: '-', text: a[i] }); i++; }
        else { out.push({ t: '+', text: b[j] }); j++; }
    }
    while (i < n) out.push({ t: '-', text: a[i++] });
    while (j < m) out.push({ t: '+', text: b[j++] });
    // Diff kompakt halten: lange gleichbleibende Blöcke auf 3 Kontextzeilen kürzen
    const compact = [];
    let run = 0;
    for (let k = 0; k < out.length; k++) {
        const line = out[k];
        if (line.t === ' ') {
            run++;
            const ctx = 3;
            const nearChange = (k + 1 < out.length && out.slice(k + 1, k + 1 + ctx).some(l => l.t !== ' ')) ||
                               (compact.slice(Math.max(0, compact.length - ctx)).some(l => l.t !== ' '));
            if (!nearChange && run > ctx) continue;
            if (!nearChange && run === ctx) { compact.push({ t: ' ', text: '…' }); continue; }
            compact.push(line);
        } else { run = 0; compact.push(line); }
    }
    return compact.slice(0, 400);
}

// ── Blocklist für run_command ───────────────────────────────────────────────
const BLOCKLIST = [
    { re: /\brm\s+(-[a-zA-Z]*\s+)*-?[a-zA-Z]*r[a-zA-Z]*f?\s+\/(\s|$)/, why: 'rm -rf auf /' },
    { re: /\bmkfs(\.\w+)?\b/, why: 'mkfs (Dateisystem formatieren)' },
    { re: /\bdd\b[^|]*of=\/dev\/(sd|nvme|hd|vd)/, why: 'dd direkt auf Blockgerät' },
    { re: /\b(shutdown|reboot|halt|poweroff|init\s+[06])\b/, why: 'Container herunterfahren/neustarten' },
    { re: /:\(\)\s*\{.*\};\s*:/, why: 'Fork-Bombe' },
    { re: /\b(pct|qm)\s/, why: 'Proxmox-Verwaltungsbefehle (pct/qm)' },
    { re: /\bchattr\b/, why: 'chattr (Dateiattribute einfrieren)' },
    { re: />\s*\/dev\/(sd|nvme|hd|vd)/, why: 'direktes Beschreiben von Blockgeräten' },
    { re: /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba|z|da|fi)?sh\b/, why: 'Remote-Script per Pipe in die Shell' },
    { re: /\bchmod\s+-R\s+777\s+\//, why: 'chmod 777 auf /' },
];

function checkBlocklist(cmd) {
    for (const b of BLOCKLIST) {
        if (b.re.test(cmd)) return b.why;
    }
    return null;
}

// ── Tools ───────────────────────────────────────────────────────────────────
function toolListDir(wsRoot, args) {
    const dir = safePath(wsRoot, args.path || '.');
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const lines = [];
    for (const e of entries.slice(0, 500)) {
        if (e.isDirectory()) lines.push(`DIR   ${e.name}/`);
        else {
            let size = 0;
            try { size = fs.statSync(path.join(dir, e.name)).size; } catch { /*Race*/ }
            lines.push(`FILE  ${e.name}  (${size} B)`);
        }
    }
    if (entries.length > 500) lines.push(`… ${entries.length - 500} weitere Einträge`);
    return { ok: true, content: lines.join('\n') || '(leer)' };
}

function toolReadFile(wsRoot, args) {
    const f = safePath(wsRoot, args.path);
    const st = fs.statSync(f);
    if (st.isDirectory()) throw new Error(`"${args.path}" ist ein Verzeichnis.`);
    let data = fs.readFileSync(f, 'utf8');
    if (data.length > READ_FILE_CAP) {
        data = data.slice(0, READ_FILE_CAP) + `\n… [abgeschnitten, Datei ist ${st.size} B]`;
    }
    return { ok: true, content: data || '(leere Datei)' };
}

function toolWriteFile(wsRoot, args) {
    if (typeof args.content !== 'string') throw new Error('write_file braucht "content".');
    const f = safePath(wsRoot, args.path);
    const existed = fs.existsSync(f);
    const old = existed ? fs.readFileSync(f, 'utf8') : '';
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, args.content);
    const diff = lineDiff(old, args.content);
    return {
        ok: true,
        content: `${existed ? 'Überschrieben' : 'Neu angelegt'}: ${args.path} (${Buffer.byteLength(args.content)} B)`,
        diff,
    };
}

function toolEditFile(wsRoot, args) {
    const { path: p, old_string, new_string } = args;
    if (typeof old_string !== 'string' || typeof new_string !== 'string') {
        throw new Error('edit_file braucht "old_string" und "new_string".');
    }
    const f = safePath(wsRoot, p);
    const src = fs.readFileSync(f, 'utf8');
    const count = src.split(old_string).length - 1;
    if (count === 0) throw new Error(`old_string nicht gefunden in ${p}.`);
    if (count > 1) throw new Error(`old_string ist mehrdeutig (${count} Treffer) in ${p} – Kontext erweitern.`);
    fs.writeFileSync(f, src.replace(old_string, new_string));
    const diff = lineDiff(src, src.replace(old_string, new_string));
    return { ok: true, content: `edit_file ok: ${p} (${count} Ersetzung)`, diff };
}

function runCommand(wsRoot, args, timeoutS) {
    const cmd = String(args.command || '');
    if (!cmd.trim()) throw new Error('run_command braucht "command".');
    const blocked = checkBlocklist(cmd);
    if (blocked) {
        return { ok: false, content: `BLOCKIERT: ${blocked}\nBefehl: ${cmd}`, blocked: true };
    }
    const timeout = Math.min(Math.max(parseInt(timeoutS || args.timeout_s || '60', 10) || 60, 5), 300) * 1000;
    return new Promise((resolve) => {
        exec(cmd, {
            cwd: wsRoot,
            timeout,
            maxBuffer: 4 * 1024 * 1024,
            killSignal: 'SIGKILL',
            shell: '/bin/bash',
        }, (err, stdout, stderr) => {
            const exitCode = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
            const cap = (s, label) => {
                s = s || '';
                if (s.length > TOOL_OUTPUT_CAP) {
                    s = s.slice(0, TOOL_OUTPUT_CAP) + `\n… [${label} gekürzt, insgesamt ${s.length} Zeichen]`;
                }
                return s;
            };
            let content = `Exit-Code: ${exitCode}${err && err.killed ? ' (Timeout/abgebrochen)' : ''}\n`;
            if (stdout) content += `--- stdout ---\n${cap(stdout, 'stdout')}\n`;
            if (stderr) content += `--- stderr ---\n${cap(stderr, 'stderr')}\n`;
            if (!stdout && !stderr) content += '(keine Ausgabe)';
            resolve({ ok: exitCode === 0, content, exitCode });
        });
    });
}

// ── Tool-Definitionen (OpenAI-Function-Calling-Schema) ──────────────────────
const TOOLS_SCHEMA = [
    { type: 'function', function: { name: 'list_dir', description: 'Listet Verzeichnisinhalte im Workspace auf.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'Relativer Pfad, Default "."' } } } } },
    { type: 'function', function: { name: 'read_file', description: 'Liest eine Datei (UTF-8, max. 100 KB).', parameters: { type: 'object', properties: { path: { type: 'string', description: 'Relativer Pfad' } }, required: ['path'] } } },
    { type: 'function', function: { name: 'write_file', description: 'Schreibt/überschreibt eine Datei komplett.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } } },
    { type: 'function', function: { name: 'edit_file', description: 'Ersetzt einen exakt einmal vorkommenden Textabschnitt (old_string → new_string).', parameters: { type: 'object', properties: { path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' } }, required: ['path', 'old_string', 'new_string'] } } },
    { type: 'function', function: { name: 'run_command', description: 'Führt einen Bash-Befehl im Workspace aus (Timeout max. 300 s). Gefährliche Befehle werden blockiert.', parameters: { type: 'object', properties: { command: { type: 'string' }, timeout_s: { type: 'string', description: 'Optional, Default 60' } }, required: ['command'] } } },
    { type: 'function', function: { name: 'finish', description: 'Beendet die Aufgabe mit einer Zusammenfassung.', parameters: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] } } },
];

function systemPrompt(sess) {
    return `Du bist ZCode-Server, ein präziser Coding-Agent, der lokal auf einem Proxmox-LXC läuft (Web-App im Stil von zcode.z.ai).
Du arbeitest AUSSCHLIESSLICH im Workspace "${sess.workspace}" (Pfad: ${path.join(WORKSPACES_DIR, sess.workspace)}).

Regeln:
- Nutze IMMER die bereitgestellten Tools, um Dateien zu lesen/schreiben oder Befehle auszuführen – erfinde keine Dateiinhalte.
- Vor jeder Änderung die betroffene Datei lesen (kein Blind-Edit). Gezielte Änderungen mit edit_file, neue/ganze Dateien mit write_file.
- Verifiziere Änderungen, wo möglich (Syntax-Check, Tests, Build mit run_command).
- Pfade sind relativ zum Workspace; du kommst nicht aus dem Workspace heraus.
- Antworte in der Sprache der Nutzerafrage (Standard: Deutsch), knapp und sachlich.
- Bist du fertig, rufe finish mit einer kurzen Zusammenfassung auf (was geändert, was verifiziert).
- Bei Blockaden (blockierter Befehl) sagst du offen, was blockiert wurde und warum.

Heutiges Datum: ${new Date().toISOString().slice(0, 10)}.`;
}

// ── LLM-Aufrufe ─────────────────────────────────────────────────────────────
function completionsUrl(baseUrl) {
    let u = String(baseUrl || '').trim().replace(/\/+$/, '');
    if (u.endsWith('/chat/completions')) u = u.slice(0, -'/chat/completions'.length);
    return u + '/chat/completions';
}

function llmHeaders(settings) {
    const h = { 'Content-Type': 'application/json' };
    if (settings.apiKey) h['Authorization'] = `Bearer ${settings.apiKey}`;
    return h;
}

// Wandelt einen Upstream-Stream (OpenAI-SSE) in Events um; ruft onDelta bei
// Text-Stücken und onToolCallDelta bei Function-Call-Fragmenten auf.
async function streamLLM(settings, body, onDelta, signal) {
    const res = await fetch(completionsUrl(settings.baseUrl), {
        method: 'POST',
        headers: llmHeaders(settings),
        body: JSON.stringify(body),
        signal,
    });
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`LLM-Endpoint antwortete HTTP ${res.status}: ${text.slice(0, 2000) || '(kein Body)'}`);
    }
    if (!res.body) throw new Error('LLM-Endpoint lieferte keinen Stream-Body (stream:true gesetzt?).');

    let buffer = '';
    const decoder = new TextDecoder();
    let text = '';
    const toolCalls = {}; // index -> {id, name, arguments}

    const handleChunk = (chunkStr) => {
        let json;
        try { json = JSON.parse(chunkStr); } catch { return; } // Keep-alive/Kommentarzeilen ignorieren
        const choices = json.choices || [];
        const c0 = choices[0] || {};
        const delta = c0.delta || {};
        if (delta.content) {
            text += delta.content;
            onDelta(delta.content);
        }
        for (const tc of delta.tool_calls || []) {
            const idx = tc.index || 0;
            if (!toolCalls[idx]) toolCalls[idx] = { id: '', name: '', arguments: '' };
            if (tc.id) toolCalls[idx].id = tc.id;
            if (tc.function) {
                if (tc.function.name) toolCalls[idx].name += tc.function.name;
                if (tc.function.arguments) toolCalls[idx].arguments += tc.function.arguments;
            }
        }
        if (c0.finish_reason) finishReason = c0.finish_reason;
    };
    let finishReason = null;

    for await (const chunk of res.body) {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
            const t = line.trim();
            if (!t.startsWith('data:')) continue;
            const payload = t.slice(5).trim();
            if (payload === '[DONE]') continue;
            handleChunk(payload);
        }
    }
    const calls = Object.keys(toolCalls).sort((a, b) => a - b).map(k => toolCalls[k]);
    for (const c of calls) {
        try { c.parsed = JSON.parse(c.arguments || '{}'); } catch { c.parsed = null; }
    }
    return { text, toolCalls: calls, finishReason };
}

// ── Bestätigungsmodus („Ask before changes") ────────────────────────────────
// pro Session maximal ein ausstehender Befehl
const pendingConfirms = new Map(); // sessionId -> { pendingId, command, resolve, timer }
const stoppedSessions = new Set(); // sessionId → kurzzeitig "stoppen" (60 s Fenster)

function requestConfirm(sessionId, command, emit) {
    return new Promise((resolve) => {
        const pendingId = newId();
        const entry = { pendingId, command, resolve, timer: null };
        entry.timer = setTimeout(() => {
            if (pendingConfirms.get(sessionId) === entry) {
                pendingConfirms.delete(sessionId);
                resolve(false); // Timeout = ablehnen
            }
        }, CONFIRM_TIMEOUT_MS);
        pendingConfirms.set(sessionId, entry);
        emit({ type: 'confirm_required', pendingId, command });
    });
}

function resolveConfirm(sessionId, pendingId, approved) {
    const entry = pendingConfirms.get(sessionId);
    if (!entry || entry.pendingId !== pendingId) return false;
    clearTimeout(entry.timer);
    pendingConfirms.delete(sessionId);
    entry.resolve(!!approved);
    return true;
}

function dropConfirms(sessionId) {
    const entry = pendingConfirms.get(sessionId);
    if (entry) {
        clearTimeout(entry.timer);
        pendingConfirms.delete(sessionId);
        entry.resolve(false);
    }
}

// ── Agent-Loop ──────────────────────────────────────────────────────────────
async function runAgent(sess, settings, emit, signal, isStopped) {
    const wsRoot = path.join(WORKSPACES_DIR, sess.workspace);
    fs.mkdirSync(wsRoot, { recursive: true });

    const messages = [{ role: 'system', content: systemPrompt(sess) }, ...sess.messages];

    for (let step = 1; step <= MAX_ITERATIONS; step++) {
        if (isStopped() || signal.aborted) return { reason: 'aborted' };

        emit({ type: 'status', text: `Schritt ${step}/${MAX_ITERATIONS}` });

        const body = {
            model: settings.model,
            messages,
            tools: TOOLS_SCHEMA,
            stream: true,
            temperature: 0.2,
        };

        let result;
        try {
            result = await streamLLM(settings, body, (t) => emit({ type: 'delta', text: t }), signal);
        } catch (e) {
            if (signal.aborted || isStopped()) return { reason: 'aborted' };
            // VOLLE Fehlerkette: Meldung + ggf. Cause
            const chain = e.cause ? `\nUrsache: ${e.cause.message || e.cause}` : '';
            throw new Error(`${e.message}${chain}`);
        }

        const toolCalls = result.toolCalls;
        const assistantMsg = { role: 'assistant', content: result.text || '' };
        if (toolCalls.length > 0) {
            assistantMsg.tool_calls = toolCalls.map(tc => ({
                id: tc.id || `call_${newId()}`,
                type: 'function',
                function: { name: tc.name, arguments: tc.arguments || '{}' },
            }));
        }
        messages.push(assistantMsg);
        sess.messages.push(assistantMsg);
        saveSession(sess);

        if (toolCalls.length === 0) {
            emit({ type: 'done', reason: 'answered', summary: result.text || '' });
            return { reason: 'answered', text: result.text };
        }

        let finished = null;
        for (const tc of toolCalls) {
            if (isStopped() || signal.aborted) return { reason: 'aborted' };
            const name = tc.name;
            let toolRes;
            let extra = {};
            const startedAt = Date.now();

            try {
                if (!tc.parsed) throw new Error(`Ungültige JSON-Argumente: ${tc.arguments.slice(0, 200)}`);
                switch (name) {
                    case 'list_dir': toolRes = toolListDir(wsRoot, tc.parsed); break;
                    case 'read_file': toolRes = toolReadFile(wsRoot, tc.parsed); break;
                    case 'write_file': toolRes = toolWriteFile(wsRoot, tc.parsed); break;
                    case 'edit_file': toolRes = toolEditFile(wsRoot, tc.parsed); break;
                    case 'run_command': {
                        // Blocklist VOR der Bestätigungsfrage – blockierte Befehle
                        // dürfen nicht auf eine Freigabe warten (würde hängen).
                        const blockedWhy = checkBlocklist(String(tc.parsed.command || ''));
                        if (blockedWhy) {
                            toolRes = { ok: false, content: `BLOCKIERT: ${blockedWhy}\nBefehl: ${tc.parsed.command}`, blocked: true };
                            break;
                        }
                        if (settings.confirmMode) {
                            const approved = await requestConfirm(sess.id, tc.parsed.command || '', emit);
                            if (isStopped() || signal.aborted) return { reason: 'aborted' };
                            if (!approved) {
                                toolRes = { ok: false, content: 'Vom Nutzer abgelehnt – wähle einen anderen Weg oder frage nach.', rejected: true };
                                break;
                            }
                        }
                        toolRes = await runCommand(wsRoot, tc.parsed, tc.parsed.timeout_s);
                        break;
                    }
                    case 'finish':
                        finished = String(tc.parsed.summary || '');
                        toolRes = { ok: true, content: 'Aufgabe beendet.' };
                        break;
                    default:
                        toolRes = { ok: false, content: `Unbekanntes Tool: ${name}` };
                }
            } catch (e) {
                toolRes = { ok: false, content: `Tool-Fehler: ${e.message}` };
            }

            extra = {};
            if (tc.parsed && (tc.parsed.path)) extra.path = tc.parsed.path;
            if (name === 'run_command' && tc.parsed) extra.command = tc.parsed.command;
            emit({
                type: 'tool_result',
                name,
                ok: toolRes.ok,
                content: toolRes.content,
                diff: toolRes.diff || null,
                exitCode: toolRes.exitCode,
                durationMs: Date.now() - startedAt,
                ...extra,
            });

            messages.push({ role: 'tool', tool_call_id: tc.id || `call_${newId()}`, name, content: toolRes.content });
            sess.messages.push(messages[messages.length - 1]);
            saveSession(sess);

            if (finished !== null) {
                emit({ type: 'done', reason: 'finished', summary: finished });
                return { reason: 'finished', summary: finished };
            }
        }
    }
    emit({ type: 'done', reason: 'max_iterations', summary: `Maximale Iterationszahl (${MAX_ITERATIONS}) erreicht – bitte nachfassen.` });
    return { reason: 'max_iterations' };
}

// ── HTTP-Helfer ─────────────────────────────────────────────────────────────
function sendJson(res, status, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
    });
    res.end(body);
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', (c) => {
            size += c.length;
            if (size > BODY_LIMIT) {
                reject(new Error(`Body zu groß (> ${BODY_LIMIT} B)`));
                req.destroy();
                return;
            }
            chunks.push(c);
        });
        req.on('end', () => {
            if (chunks.length === 0) return resolve({});
            try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
            catch (e) { reject(new Error(`Ungültiges JSON: ${e.message}`)); }
        });
        req.on('error', reject);
    });
}

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.map': 'application/json',
    '.woff2': 'font/woff2',
    '.txt': 'text/plain; charset=utf-8',
};

function serveStatic(req, res, pathname) {
    let rel = decodeURIComponent(pathname);
    if (rel === '/') rel = '/index.html';
    const f = path.resolve(STATIC_DIR, '.' + rel);
    if (!f.startsWith(STATIC_DIR + path.sep) && f !== STATIC_DIR) {
        sendJson(res, 403, { error: 'Forbidden' });
        return;
    }
    let target = f;
    if (!fs.existsSync(target) || fs.statSync(target).isDirectory()) {
        target = path.join(STATIC_DIR, 'index.html'); // SPA-Fallback
    }
    if (!fs.existsSync(target)) {
        sendJson(res, 404, { error: 'Frontend nicht gefunden (static/index.html fehlt – Build enthalten?)' });
        return;
    }
    const ext = path.extname(target).toLowerCase();
    res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Cache-Control': 'no-store',
    });
    fs.createReadStream(target).pipe(res);
}

// ── API-Handler ─────────────────────────────────────────────────────────────
async function handleApi(req, res, pathname, searchParams) {
    const settings = loadSettings();

    // Health – Wahrheitsquelle für Installer & Status
    if (pathname === '/api/health' && req.method === 'GET') {
        return sendJson(res, 200, {
            ok: true, app: 'zcode-server', version: VERSION,
            model: settings.model, baseUrl: settings.baseUrl,
            hasKey: !!settings.apiKey,
            workspaces: listWorkspaces().length,
            node: process.version, uptimeS: Math.round(process.uptime()),
        });
    }

    // Settings
    if (pathname === '/api/settings' && req.method === 'GET') {
        return sendJson(res, 200, {
            baseUrl: settings.baseUrl, model: settings.model,
            confirmMode: settings.confirmMode, hasKey: !!settings.apiKey,
        });
    }
    if (pathname === '/api/settings' && req.method === 'PUT') {
        const body = await readBody(req);
        const next = { ...settings };
        if (typeof body.baseUrl === 'string' && body.baseUrl.trim()) next.baseUrl = body.baseUrl.trim();
        if (typeof body.model === 'string' && body.model.trim()) next.model = body.model.trim();
        if (typeof body.confirmMode === 'boolean') next.confirmMode = body.confirmMode;
        if (typeof body.apiKey === 'string') next.apiKey = body.apiKey.trim(); // leer = löschen
        saveSettings(next);
        log('INFO', 'Settings aktualisiert (model=' + next.model + ', baseUrl=' + next.baseUrl + ', hasKey=' + !!next.apiKey + ')');
        return sendJson(res, 200, { ok: true, baseUrl: next.baseUrl, model: next.model, confirmMode: next.confirmMode, hasKey: !!next.apiKey });
    }

    // Verbindungstest (Mini-Chat)
    if (pathname === '/api/settings/test' && req.method === 'POST') {
        const t0 = Date.now();
        try {
            const res2 = await fetch(completionsUrl(settings.baseUrl), {
                method: 'POST',
                headers: llmHeaders(settings),
                body: JSON.stringify({ model: settings.model, messages: [{ role: 'user', content: 'Antworte nur mit: OK' }], max_tokens: 8, temperature: 0 }),
            });
            const text = await res2.text();
            if (!res2.ok) return sendJson(res, 200, { ok: false, status: res2.status, body: text.slice(0, 1000) });
            const json = JSON.parse(text);
            const reply = json.choices?.[0]?.message?.content || '(leer)';
            return sendJson(res, 200, { ok: true, latencyMs: Date.now() - t0, reply: reply.trim().slice(0, 100) });
        } catch (e) {
            return sendJson(res, 200, { ok: false, error: `${e.message}${e.cause ? ' – Ursache: ' + (e.cause.message || e.cause) : ''}` });
        }
    }

    // Modell-Liste vom Endpoint laden
    if (pathname === '/api/settings/models' && req.method === 'POST') {
        try {
            const base = settings.baseUrl.trim().replace(/\/+$/, '');
            const root = base.endsWith('/chat/completions') ? base.slice(0, -'/chat/completions'.length) : base;
            const res2 = await fetch(root + '/models', { headers: llmHeaders(settings) });
            const text = await res2.text();
            if (!res2.ok) return sendJson(res, 200, { ok: false, status: res2.status, body: text.slice(0, 1000) });
            const json = JSON.parse(text);
            const ids = (json.data || json.models || []).map(m => m.id || m.name).filter(Boolean).sort();
            return sendJson(res, 200, { ok: true, models: ids.slice(0, 200) });
        } catch (e) {
            return sendJson(res, 200, { ok: false, error: e.message });
        }
    }

    // Workspaces
    if (pathname === '/api/workspaces' && req.method === 'GET') {
        return sendJson(res, 200, { workspaces: listWorkspaces() });
    }
    if (pathname === '/api/workspaces' && req.method === 'POST') {
        const body = await readBody(req);
        const name = String(body.name || '').trim();
        if (!WS_NAME_RE.test(name)) {
            return sendJson(res, 400, { error: 'Ungültiger Name (erlaubt: Buchstaben, Ziffern, . _ -, max. 64 Zeichen)' });
        }
        const dir = path.join(WORKSPACES_DIR, name);
        if (fs.existsSync(dir)) return sendJson(res, 409, { error: `Workspace "${name}" existiert bereits.` });
        fs.mkdirSync(dir, { recursive: true });
        log('INFO', 'Workspace angelegt: ' + name);
        return sendJson(res, 200, { ok: true, workspaces: listWorkspaces() });
    }
    let m = pathname.match(/^\/api\/workspaces\/([^/]+)$/);
    if (m && req.method === 'DELETE') {
        const name = decodeURIComponent(m[1]);
        if (!WS_NAME_RE.test(name)) return sendJson(res, 400, { error: 'Ungültiger Workspace-Name' });
        const dir = path.join(WORKSPACES_DIR, name);
        if (!fs.existsSync(dir)) return sendJson(res, 404, { error: 'Workspace nicht gefunden' });
        exec(`rm -rf ${JSON.stringify(dir)}`, { shell: '/bin/bash' }, (err) => {
            if (err) return sendJson(res, 500, { error: err.message });
            log('INFO', 'Workspace gelöscht: ' + name);
            sendJson(res, 200, { ok: true, workspaces: listWorkspaces() });
        });
        return;
    }

    // Sessions
    if (pathname === '/api/sessions' && req.method === 'GET') {
        const wsFilter = searchParams.get('workspace');
        const sessions = [];
        for (const f of fs.readdirSync(SESSIONS_DIR)) {
            if (!f.endsWith('.json')) continue;
            try {
                const s = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8'));
                if (wsFilter && s.workspace !== wsFilter) continue;
                sessions.push({ id: s.id, title: s.title, workspace: s.workspace, createdAt: s.createdAt, updatedAt: s.updatedAt });
            } catch { /* korrupte Datei überspringen */ }
        }
        sessions.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
        return sendJson(res, 200, { sessions });
    }
    if (pathname === '/api/sessions' && req.method === 'POST') {
        const body = await readBody(req);
        const workspace = String(body.workspace || '').trim();
        if (!WS_NAME_RE.test(workspace) || !fs.existsSync(path.join(WORKSPACES_DIR, workspace))) {
            return sendJson(res, 400, { error: `Workspace "${workspace}" existiert nicht.` });
        }
        const sess = {
            id: newId(),
            workspace,
            title: 'Neue Session',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            messages: [],
        };
        saveSession(sess);
        log('INFO', `Session ${sess.id} angelegt (workspace=${workspace})`);
        return sendJson(res, 200, sess);
    }
    m = pathname.match(/^\/api\/sessions\/([a-zA-Z0-9_-]+)$/);
    if (m && req.method === 'GET') {
        const sess = loadSession(m[1]);
        if (!sess) return sendJson(res, 404, { error: 'Session nicht gefunden' });
        return sendJson(res, 200, sess);
    }
    if (m && req.method === 'DELETE') {
        const f = sessionFile(m[1]);
        if (fs.existsSync(f)) fs.unlinkSync(f);
        dropConfirms(m[1]);
        return sendJson(res, 200, { ok: true });
    }

    // Nachricht senden → SSE-Stream
    m = pathname.match(/^\/api\/sessions\/([a-zA-Z0-9_-]+)\/messages$/);
    if (m && req.method === 'POST') {
        const sess = loadSession(m[1]);
        if (!sess) return sendJson(res, 404, { error: 'Session nicht gefunden' });
        if (!settings.apiKey) {
            return sendJson(res, 400, { error: 'Kein API-Key gesetzt – bitte in den Einstellungen hinterlegen.' });
        }
        const body = await readBody(req);
        const content = String(body.content || '').trim();
        if (!content) return sendJson(res, 400, { error: 'Leere Nachricht.' });

        if (sess.messages.length === 0) {
            sess.title = content.slice(0, 60) + (content.length > 60 ? '…' : '');
        }
        sess.messages.push({ role: 'user', content });
        saveSession(sess);

        // SSE-Antwort
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-store',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
        });
        let closed = false;
        res.on('close', () => { closed = true; dropConfirms(sess.id); controller.abort(); });
        const emit = (obj) => {
            if (closed) return;
            try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch { closed = true; }
        };
        const controller = new AbortController();
        // Stop = expliziter /stop-Endpoint ODER Client hat die SSE-Verbindung geschlossen
        const isStopped = () => stoppedSessions.has(sess.id) || closed;

        log('INFO', `Agent-Run startet: session=${sess.id} ws=${sess.workspace} model=${settings.model}`);

        try {
            await runAgent(sess, settings, emit, controller.signal, isStopped);
        } catch (e) {
            const msg = `${e.message}${e.cause ? `\nUrsache: ${e.cause.message || e.cause}` : ''}${e.stack ? '\n' + e.stack.split('\n').slice(0, 6).join('\n') : ''}`;
            log('ERROR', `Agent-Run fehlgeschlagen: ${e.message}`);
            emit({ type: 'error', message: msg });
        }
        try { res.write('data: [DONE]\n\n'); res.end(); } catch { /* egal */ }
        log('INFO', `Agent-Run beendet: session=${sess.id}`);
        return;
    }

    // Bestätigung (Bestätigungsmodus)
    m = pathname.match(/^\/api\/sessions\/([a-zA-Z0-9_-]+)\/confirm$/);
    if (m && req.method === 'POST') {
        const body = await readBody(req);
        const ok2 = resolveConfirm(m[1], String(body.pendingId || ''), !!body.approved);
        return sendJson(res, ok2 ? 200 : 404, { ok: ok2 });
    }

    // Stop
    m = pathname.match(/^\/api\/sessions\/([a-zA-Z0-9_-]+)\/stop$/);
    if (m && req.method === 'POST') {
        stoppedSessions.add(m[1]);
        dropConfirms(m[1]);
        setTimeout(() => stoppedSessions.delete(m[1]), 60 * 1000);
        return sendJson(res, 200, { ok: true });
    }

    sendJson(res, 404, { error: `Unbekannter API-Pfad: ${req.method} ${pathname}` });
}

// ── Server ──────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;
    try {
        if (pathname.startsWith('/api/')) {
            await handleApi(req, res, pathname, url.searchParams);
        } else if (req.method === 'GET' || req.method === 'HEAD') {
            serveStatic(req, res, pathname);
        } else {
            sendJson(res, 405, { error: 'Method not allowed' });
        }
    } catch (e) {
        // Vollständige Fehlerkette auch dem Client zeigen (Debugging-Anforderung)
        log('ERROR', `Request-Fehler ${req.method} ${pathname}: ${e.message}\n${e.stack}`);
        if (!res.headersSent) {
            sendJson(res, 500, { error: e.message, stack: (e.stack || '').split('\n').slice(0, 10) });
        } else {
            try { res.end(); } catch { /* egal */ }
        }
    }
});

ensureDirs();
server.listen(PORT, '0.0.0.0', () => {
    log('INFO', `ZCode-Server v${VERSION} lauscht auf http://0.0.0.0:${PORT}`);
    log('INFO', `Home: ${HOME_DIR} | Node: ${process.version} | Modell: ${loadSettings().model}`);
});
