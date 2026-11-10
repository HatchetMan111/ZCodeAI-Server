import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Build landet direkt in app/static (committed – der LXC braucht kein npm).
export default defineConfig({
    plugins: [react()],
    build: {
        outDir: '../static',
        emptyOutDir: true,
    },
    server: {
        proxy: {
            '/api': 'http://127.0.0.1:8090',
        },
    },
});
