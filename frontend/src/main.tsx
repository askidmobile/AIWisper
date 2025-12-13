import React from 'react'
import ReactDOM from 'react-dom/client'
import './index.css'

// Feature flag для переключения между новым и старым UI
// По умолчанию используется НОВЫЙ модульный UI (AppWithProviders)
// Установите USE_LEGACY_UI=true в localStorage для использования старого App.tsx
// Или добавьте VITE_USE_LEGACY_UI=true в .env файл
const USE_LEGACY_UI = localStorage.getItem('USE_LEGACY_UI') === 'true' || 
                      (import.meta as any).env?.VITE_USE_LEGACY_UI === 'true';

// Динамический импорт для code splitting
const AppComponent = USE_LEGACY_UI 
    ? React.lazy(() => import('./App.legacy'))
    : React.lazy(() => import('./AppWithProviders'));

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
console.log(`[AIWisper] Using ${USE_LEGACY_UI ? 'LEGACY UI (App.tsx)' : 'NEW modular UI (MainLayout)'}`);
console.log('[AIWisper] To switch to legacy UI, run: localStorage.setItem("USE_LEGACY_UI", "true") and reload');
console.log('[AIWisper] To switch to new UI, run: localStorage.removeItem("USE_LEGACY_UI") and reload');

ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
        <React.Suspense fallback={<LoadingFallback />}>
            <AppComponent />
        </React.Suspense>
    </React.StrictMode>,
)
