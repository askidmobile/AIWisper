import { useEffect, useCallback } from 'react';

export interface KeyboardShortcut {
    key: string;
    ctrl?: boolean;
    shift?: boolean;
    alt?: boolean;
    meta?: boolean; // Cmd on Mac
    action: () => void;
    description: string;
    enabled?: boolean;
}

interface UseKeyboardShortcutsOptions {
    shortcuts: KeyboardShortcut[];
    enabled?: boolean;
}

/**
 * Хук для управления клавиатурными сочетаниями
 * 
 * Пример использования:
 * ```tsx
 * useKeyboardShortcuts({
 *     shortcuts: [
 *         { key: 'r', meta: true, action: startRecording, description: 'Начать запись' },
 *         { key: 's', meta: true, action: stopRecording, description: 'Остановить запись' },
 *         { key: ' ', action: togglePlayPause, description: 'Воспроизведение/Пауза' },
 *     ]
 * });
 * ```
 */
export const useKeyboardShortcuts = ({ shortcuts, enabled = true }: UseKeyboardShortcutsOptions) => {
    const handleKeyDown = useCallback((e: KeyboardEvent) => {
        if (!enabled) return;
        
        // Игнорируем события в input/textarea
        const target = e.target as HTMLElement;
        if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
            return;
        }
        
        for (const shortcut of shortcuts) {
            if (shortcut.enabled === false) continue;
            
            const keyMatch = e.key.toLowerCase() === shortcut.key.toLowerCase();
            const ctrlMatch = shortcut.ctrl ? (e.ctrlKey || e.metaKey) : !e.ctrlKey;
            const shiftMatch = shortcut.shift ? e.shiftKey : !e.shiftKey;
            const altMatch = shortcut.alt ? e.altKey : !e.altKey;
            // metaMatch используется для проверки Cmd на Mac
            void (shortcut.meta ? e.metaKey : true);
            
            // Для meta shortcuts проверяем только meta
            if (shortcut.meta) {
                if (keyMatch && e.metaKey && !e.shiftKey && !e.altKey) {
                    e.preventDefault();
                    shortcut.action();
                    return;
                }
            } else if (shortcut.ctrl) {
                if (keyMatch && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
                    e.preventDefault();
                    shortcut.action();
                    return;
                }
            } else if (keyMatch && ctrlMatch && shiftMatch && altMatch) {
                // Простые shortcuts без модификаторов
                if (!e.ctrlKey && !e.metaKey && !e.altKey) {
                    e.preventDefault();
                    shortcut.action();
                    return;
                }
            }
        }
    }, [shortcuts, enabled]);
    
    useEffect(() => {
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [handleKeyDown]);
    
    // Возвращаем список shortcuts для отображения в UI (например, в Help modal)
    return {
        shortcuts: shortcuts.filter(s => s.enabled !== false).map(s => ({
            key: s.key,
            modifiers: [
                s.meta && '⌘',
                s.ctrl && 'Ctrl',
                s.shift && '⇧',
                s.alt && '⌥',
            ].filter(Boolean).join('+'),
            description: s.description,
        })),
    };
};

/**
 * Предустановленные shortcuts для приложения
 */
export const createAppShortcuts = (handlers: {
    onStartStop?: () => void;
    onPlayPause?: () => void;
    onSeekForward?: () => void;
    onSeekBackward?: () => void;
    onToggleSettings?: () => void;
    onCopyTranscription?: () => void;
    onExportTXT?: () => void;
    onShowHelp?: () => void;
    isRecording?: boolean;
    isPlaying?: boolean;
}): KeyboardShortcut[] => {
    const shortcuts: KeyboardShortcut[] = [];
    
    // Запись
    if (handlers.onStartStop) {
        shortcuts.push({
            key: 'r',
            meta: true,
            action: handlers.onStartStop,
            description: handlers.isRecording ? 'Остановить запись' : 'Начать запись',
        });
    }
    
    // Воспроизведение
    if (handlers.onPlayPause) {
        shortcuts.push({
            key: ' ',
            action: handlers.onPlayPause,
            description: handlers.isPlaying ? 'Пауза' : 'Воспроизвести',
            enabled: !handlers.isRecording,
        });
    }
    
    // Перемотка
    if (handlers.onSeekForward) {
        shortcuts.push({
            key: 'ArrowRight',
            action: handlers.onSeekForward,
            description: 'Вперёд 10 сек',
            enabled: !handlers.isRecording,
        });
    }
    
    if (handlers.onSeekBackward) {
        shortcuts.push({
            key: 'ArrowLeft',
            action: handlers.onSeekBackward,
            description: 'Назад 10 сек',
            enabled: !handlers.isRecording,
        });
    }
    
    // Настройки
    if (handlers.onToggleSettings) {
        shortcuts.push({
            key: ',',
            meta: true,
            action: handlers.onToggleSettings,
            description: 'Открыть настройки',
        });
    }
    
    // Копирование
    if (handlers.onCopyTranscription) {
        shortcuts.push({
            key: 'c',
            meta: true,
            shift: true,
            action: handlers.onCopyTranscription,
            description: 'Копировать транскрипцию',
        });
    }
    
    // Экспорт
    if (handlers.onExportTXT) {
        shortcuts.push({
            key: 'e',
            meta: true,
            action: handlers.onExportTXT,
            description: 'Экспорт в TXT',
        });
    }
    
    // Помощь
    if (handlers.onShowHelp) {
        shortcuts.push({
            key: '?',
            action: handlers.onShowHelp,
            description: 'Показать справку',
        });
    }
    
    return shortcuts;
};
