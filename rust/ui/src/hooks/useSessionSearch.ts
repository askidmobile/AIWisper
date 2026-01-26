import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { SessionInfo } from '../types/session';

interface UseSessionSearchOptions {
    sessions: SessionInfo[];
    debounceMs?: number;
}

interface UseSessionSearchReturn {
    searchQuery: string;
    setSearchQuery: (query: string) => void;
    filteredSessions: SessionInfo[];
    isSearching: boolean;
    clearSearch: () => void;
    
    // Мультиселект для batch операций
    selectedIds: Set<string>;
    toggleSelection: (id: string) => void;
    selectAll: () => void;
    clearSelection: () => void;
    isAllSelected: boolean;
}

/**
 * Хук для поиска и фильтрации сессий с debounce
 * 
 * Пример использования:
 * ```tsx
 * const { searchQuery, setSearchQuery, filteredSessions, selectedIds, toggleSelection } = useSessionSearch({
 *     sessions,
 *     debounceMs: 300,
 * });
 * ```
 */
export const useSessionSearch = ({
    sessions,
    debounceMs = 300,
}: UseSessionSearchOptions): UseSessionSearchReturn => {
    const [searchQuery, setSearchQueryInternal] = useState('');
    const [debouncedQuery, setDebouncedQuery] = useState('');
    const [isSearching, setIsSearching] = useState(false);
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
    
    const debounceTimerRef = useRef<NodeJS.Timeout | null>(null);

    // Debounced search query setter
    const setSearchQuery = useCallback((query: string) => {
        setSearchQueryInternal(query);
        setIsSearching(true);
        
        if (debounceTimerRef.current) {
            clearTimeout(debounceTimerRef.current);
        }
        
        debounceTimerRef.current = setTimeout(() => {
            setDebouncedQuery(query);
            setIsSearching(false);
        }, debounceMs);
    }, [debounceMs]);

    // Cleanup debounce timer
    useEffect(() => {
        return () => {
            if (debounceTimerRef.current) {
                clearTimeout(debounceTimerRef.current);
            }
        };
    }, []);

    // Фильтрация сессий по запросу
    const filteredSessions = useMemo(() => {
        if (!debouncedQuery.trim()) {
            return sessions;
        }
        
        const query = debouncedQuery.toLowerCase().trim();
        
        return sessions.filter(session => {
            // Поиск по названию
            if (session.title?.toLowerCase().includes(query)) {
                return true;
            }
            
            // Поиск по дате (формат: DD.MM.YYYY или YYYY-MM-DD)
            const date = new Date(session.startTime);
            const dateStr = date.toLocaleDateString('ru-RU');
            const isoDateStr = date.toISOString().split('T')[0];
            if (dateStr.includes(query) || isoDateStr.includes(query)) {
                return true;
            }
            
            // Поиск по ID (частичное совпадение)
            if (session.id.toLowerCase().includes(query)) {
                return true;
            }
            
            return false;
        });
    }, [sessions, debouncedQuery]);

    const clearSearch = useCallback(() => {
        setSearchQueryInternal('');
        setDebouncedQuery('');
        setIsSearching(false);
        if (debounceTimerRef.current) {
            clearTimeout(debounceTimerRef.current);
        }
    }, []);

    // Мультиселект функции
    const toggleSelection = useCallback((id: string) => {
        setSelectedIds(prev => {
            const next = new Set(prev);
            if (next.has(id)) {
                next.delete(id);
            } else {
                next.add(id);
            }
            return next;
        });
    }, []);

    const selectAll = useCallback(() => {
        setSelectedIds(new Set(filteredSessions.map(s => s.id)));
    }, [filteredSessions]);

    const clearSelection = useCallback(() => {
        setSelectedIds(new Set());
    }, []);

    const isAllSelected = useMemo(() => {
        if (filteredSessions.length === 0) return false;
        return filteredSessions.every(s => selectedIds.has(s.id));
    }, [filteredSessions, selectedIds]);

    // Очищаем выбор при изменении фильтрации (опционально)
    // useEffect(() => {
    //     setSelectedIds(new Set());
    // }, [debouncedQuery]);

    return {
        searchQuery,
        setSearchQuery,
        filteredSessions,
        isSearching,
        clearSearch,
        selectedIds,
        toggleSelection,
        selectAll,
        clearSelection,
        isAllSelected,
    };
};

export default useSessionSearch;
