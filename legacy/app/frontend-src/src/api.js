// REST- + SSE-Helfer fürs ZCode-Server-Frontend

async function request(path, opts = {}) {
    const res = await fetch(path, {
        headers: { 'Content-Type': 'application/json' },
        ...opts,
        body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
    return json;
}

export const api = {
    health: () => request('/api/health'),
    getSettings: () => request('/api/settings'),
    putSettings: (s) => request('/api/settings', { method: 'PUT', body: s }),
    testConnection: () => request('/api/settings/test', { method: 'POST' }),
    loadModels: () => request('/api/settings/models', { method: 'POST' }),
    listWorkspaces: () => request('/api/workspaces'),
    createWorkspace: (name) => request('/api/workspaces', { method: 'POST', body: { name } }),
    deleteWorkspace: (name) => request(`/api/workspaces/${encodeURIComponent(name)}`, { method: 'DELETE' }),
    listSessions: (workspace) => request(`/api/sessions?workspace=${encodeURIComponent(workspace)}`),
    createSession: (workspace) => request('/api/sessions', { method: 'POST', body: { workspace } }),
    getSession: (id) => request(`/api/sessions/${id}`),
    deleteSession: (id) => request(`/api/sessions/${id}`, { method: 'DELETE' }),
    confirm: (id, pendingId, approved) => request(`/api/sessions/${id}/confirm`, { method: 'POST', body: { pendingId, approved } }),
    stop: (id) => request(`/api/sessions/${id}/stop`, { method: 'POST' }),
};

// POST /messages → SSE-Stream lesen; onEvent bekommt die JSON-Objekte
// (type: status|delta|tool_result|confirm_required|error|done).
export async function streamMessage(sessionId, content, onEvent, signal) {
    const res = await fetch(`/api/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
        signal,
    });
    if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error || `HTTP ${res.status}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop();
        for (const part of parts) {
            const line = part.split('\n').find(l => l.startsWith('data:'));
            if (!line) continue;
            const payload = line.slice(5).trim();
            if (!payload || payload === '[DONE]') continue;
            try { onEvent(JSON.parse(payload)); } catch { /* defektes Chunk ignorieren */ }
        }
    }
}
