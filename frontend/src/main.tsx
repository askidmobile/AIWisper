import React from 'react'
import ReactDOM from 'react-dom/client'
import './index.css'

// Feature flag для переключения между старым и новым UI
// Установите USE_NEW_UI=true в localStorage для тестирования нового UI
// Или добавьте VITE_USE_NEW_UI=true в .env файл
const USE_NEW_UI = localStorage.getItem('USE_NEW_UI') === 'true' || 
                   (import.meta as any).env?.VITE_USE_NEW_UI === 'true';

// Динамический импорт для code splitting
const AppComponent = USE_NEW_UI 
    ? React.lazy(() => import('./AppWithProviders'))
    : React.lazy(() => import('./App'));

// Fallback компонент для загрузки
const LoadingFallback = () => (
    <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100vh',
        background: '#0a0a14',
        color: '#fff',
    }}>
        <div style={{ textAlign: 'center' }}>
            <div style={{
                width: '40px',
                height: '40px',
                margin: '0 auto 1rem',
                border: '3px solid rgba(255,255,255,0.1)',
                borderTopColor: '#8b5cf6',
                borderRadius: '50%',
                animation: 'spin 1s linear infinite',
            }} />
            <div>Загрузка AIWisper...</div>
            <style>{`
                @keyframes spin {
                    to { transform: rotate(360deg); }
                }
            `}</style>
        </div>
    </div>
);

// Логируем какой UI используется
console.log(`[AIWisper] Using ${USE_NEW_UI ? 'NEW modular UI (MainLayout)' : 'LEGACY UI (App.tsx)'}`);
console.log('[AIWisper] To switch UI, run in console: localStorage.setItem("USE_NEW_UI", "true") and reload');

ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
        <React.Suspense fallback={<LoadingFallback />}>
            <AppComponent />
        </React.Suspense>
    </React.StrictMode>,
)
