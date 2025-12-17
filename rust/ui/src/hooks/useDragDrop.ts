import { useState, useCallback, useRef, useEffect } from 'react';

interface UseDragDropOptions {
    onFileDrop: (file: File) => Promise<void>;
    acceptedTypes?: string[]; // e.g., ['audio/mp3', 'audio/wav', 'audio/mpeg']
    enabled?: boolean;
}

interface UseDragDropReturn {
    isDragging: boolean;
    isProcessing: boolean;
    progress: string | null;
    error: string | null;
    dragHandlers: {
        onDragOver: (e: React.DragEvent) => void;
        onDragEnter: (e: React.DragEvent) => void;
        onDragLeave: (e: React.DragEvent) => void;
        onDrop: (e: React.DragEvent) => void;
    };
    clearError: () => void;
}

const DEFAULT_ACCEPTED_TYPES = [
    'audio/mp3',
    'audio/mpeg',
    'audio/wav',
    'audio/x-wav',
    'audio/wave',
    'audio/m4a',
    'audio/x-m4a',
    'audio/mp4',
    'audio/ogg',
    'audio/webm',
    'audio/flac',
];

/**
 * Хук для обработки Drag & Drop файлов
 * 
 * Пример использования:
 * ```tsx
 * const { isDragging, isProcessing, progress, dragHandlers } = useDragDrop({
 *     onFileDrop: async (file) => {
 *         await importAudioFile(file);
 *     },
 *     acceptedTypes: ['audio/mp3', 'audio/wav'],
 * });
 * 
 * return (
 *     <div {...dragHandlers}>
 *         {isDragging && <DropOverlay />}
 *         {isProcessing && <ProcessingIndicator progress={progress} />}
 *         ...
 *     </div>
 * );
 * ```
 */
export const useDragDrop = ({
    onFileDrop,
    acceptedTypes = DEFAULT_ACCEPTED_TYPES,
    enabled = true,
}: UseDragDropOptions): UseDragDropReturn => {
    const [isDragging, setIsDragging] = useState(false);
    const [isProcessing, setIsProcessing] = useState(false);
    const [progress, setProgress] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    
    const dragCounterRef = useRef(0);
    
    const isValidFile = useCallback((file: File): boolean => {
        // Проверяем MIME type
        if (acceptedTypes.includes(file.type)) {
            return true;
        }
        
        // Проверяем расширение файла как fallback
        const extension = file.name.split('.').pop()?.toLowerCase();
        const validExtensions = ['mp3', 'wav', 'm4a', 'ogg', 'webm', 'flac', 'aac'];
        if (extension && validExtensions.includes(extension)) {
            return true;
        }
        
        return false;
    }, [acceptedTypes]);
    
    const handleDragOver = useCallback((e: React.DragEvent) => {
        if (!enabled) return;
        e.preventDefault();
        e.stopPropagation();
    }, [enabled]);
    
    const handleDragEnter = useCallback((e: React.DragEvent) => {
        if (!enabled) return;
        e.preventDefault();
        e.stopPropagation();
        
        dragCounterRef.current++;
        
        // Проверяем, есть ли файлы в drag event
        if (e.dataTransfer.items && e.dataTransfer.items.length > 0) {
            setIsDragging(true);
        }
    }, [enabled]);
    
    const handleDragLeave = useCallback((e: React.DragEvent) => {
        if (!enabled) return;
        e.preventDefault();
        e.stopPropagation();
        
        dragCounterRef.current--;
        
        if (dragCounterRef.current === 0) {
            setIsDragging(false);
        }
    }, [enabled]);
    
    const handleDrop = useCallback(async (e: React.DragEvent) => {
        if (!enabled) return;
        e.preventDefault();
        e.stopPropagation();
        
        setIsDragging(false);
        dragCounterRef.current = 0;
        
        const files = Array.from(e.dataTransfer.files);
        
        if (files.length === 0) {
            return;
        }
        
        // Берём первый файл
        const file = files[0];
        
        if (!isValidFile(file)) {
            setError(`Неподдерживаемый формат файла: ${file.type || file.name.split('.').pop()}`);
            return;
        }
        
        setIsProcessing(true);
        setProgress('Подготовка файла...');
        setError(null);
        
        try {
            await onFileDrop(file);
            setProgress(null);
        } catch (err: any) {
            setError(err.message || 'Ошибка при импорте файла');
        } finally {
            setIsProcessing(false);
        }
    }, [enabled, isValidFile, onFileDrop]);
    
    const clearError = useCallback(() => {
        setError(null);
    }, []);
    
    // Сбрасываем состояние при размонтировании
    useEffect(() => {
        return () => {
            dragCounterRef.current = 0;
        };
    }, []);
    
    return {
        isDragging,
        isProcessing,
        progress,
        error,
        dragHandlers: {
            onDragOver: handleDragOver,
            onDragEnter: handleDragEnter,
            onDragLeave: handleDragLeave,
            onDrop: handleDrop,
        },
        clearError,
    };
};

/**
 * Стили для компонента DropOverlay (использовать в JSX компоненте)
 */
export const dropOverlayStyles = {
    container: {
        position: 'fixed' as const,
        inset: 0,
        background: 'rgba(138, 43, 226, 0.15)',
        backdropFilter: 'blur(4px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
        pointerEvents: 'none' as const,
    },
    content: {
        background: 'var(--surface-elevated)',
        borderRadius: 'var(--radius-xl)',
        padding: '2rem 3rem',
        textAlign: 'center' as const,
        boxShadow: 'var(--shadow-lg)',
        border: '2px dashed var(--primary)',
    },
    icon: {
        fontSize: '3rem',
        marginBottom: '1rem',
    },
    title: {
        fontSize: '1.1rem',
        fontWeight: 600,
        color: 'var(--text-primary)',
    },
    subtitle: {
        fontSize: '0.85rem',
        color: 'var(--text-muted)',
        marginTop: '0.5rem',
    },
};
