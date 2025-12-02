export type TabType = 'dialogue' | 'chunks' | 'summary';

interface SessionTabsProps {
    activeTab: TabType;
    onTabChange: (tab: TabType) => void;
    hasSummary: boolean;
    isGeneratingSummary: boolean;
    isRecording?: boolean; // Скрывать Summary во время записи
}

export default function SessionTabs({ 
    activeTab, 
    onTabChange, 
    hasSummary,
    isGeneratingSummary,
    isRecording = false
}: SessionTabsProps) {
    const tabs: { id: TabType; label: string; icon: string; hideWhenRecording?: boolean }[] = [
        { id: 'dialogue', label: 'Диалог', icon: '💬' },
        { id: 'chunks', label: 'Отрывки', icon: '📝' },
        { id: 'summary', label: 'Summary', icon: '📋', hideWhenRecording: true },
    ];

    // Фильтруем вкладки во время записи
    const visibleTabs = tabs.filter(tab => !isRecording || !tab.hideWhenRecording);

    return (
        <div style={{
            display: 'flex',
            gap: '0.25rem',
            padding: '0.5rem 0',
            borderBottom: '1px solid #333',
            marginBottom: '1rem'
        }}>
            {visibleTabs.map(tab => {
                const isActive = activeTab === tab.id;
                const showBadge = tab.id === 'summary' && (hasSummary || isGeneratingSummary);
                
                return (
                    <button
                        key={tab.id}
                        onClick={() => onTabChange(tab.id)}
                        style={{
                            padding: '0.5rem 1rem',
                            backgroundColor: isActive ? '#2a2a4e' : 'transparent',
                            color: isActive ? '#fff' : '#888',
                            border: 'none',
                            borderBottom: isActive ? '2px solid #6c5ce7' : '2px solid transparent',
                            borderRadius: '4px 4px 0 0',
                            cursor: 'pointer',
                            fontSize: '0.9rem',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '0.4rem',
                            transition: 'all 0.2s ease'
                        }}
                    >
                        <span>{tab.icon}</span>
                        <span>{tab.label}</span>
                        {showBadge && (
                            <span style={{
                                width: '8px',
                                height: '8px',
                                borderRadius: '50%',
                                backgroundColor: isGeneratingSummary ? '#ff9800' : '#4caf50',
                                animation: isGeneratingSummary ? 'pulse 1s infinite' : 'none'
                            }} />
                        )}
                    </button>
                );
            })}
        </div>
    );
}
