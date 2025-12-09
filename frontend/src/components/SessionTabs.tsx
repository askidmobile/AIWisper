export type TabType = 'dialogue' | 'chunks' | 'summary';

interface SessionTabsProps {
    activeTab: TabType;
    onTabChange: (tab: TabType) => void;
    hasSummary: boolean;
    isGeneratingSummary: boolean;
    isRecording?: boolean;
}

export default function SessionTabs({
    activeTab,
    onTabChange,
    hasSummary,
    isGeneratingSummary,
    isRecording = false,
}: SessionTabsProps) {
    const tabs: { id: TabType; label: string; hideWhenRecording?: boolean }[] = [
        { id: 'dialogue', label: 'Транскрипция' },
        { id: 'chunks', label: 'Отрезки' },
        { id: 'summary', label: 'Сводка', hideWhenRecording: true },
    ];

    const visibleTabs = tabs.filter((tab) => !isRecording || !tab.hideWhenRecording);

    return (
        <div
            className="segmented-control"
            style={{
                margin: '0 1rem 1rem',
            }}
        >
            {visibleTabs.map((tab) => {
                const isActive = activeTab === tab.id;
                const showBadge = tab.id === 'summary' && (hasSummary || isGeneratingSummary);

                return (
                    <button
                        key={tab.id}
                        onClick={() => onTabChange(tab.id)}
                        className={`segmented-control-item ${isActive ? 'active' : ''}`}
                        style={{
                            position: 'relative',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '0.4rem',
                        }}
                    >
                        <span>{tab.label}</span>
                        {showBadge && (
                            <span
                                style={{
                                    width: '6px',
                                    height: '6px',
                                    borderRadius: '50%',
                                    backgroundColor: isGeneratingSummary
                                        ? 'var(--warning)'
                                        : 'var(--success)',
                                    animation: isGeneratingSummary ? 'pulse 1s infinite' : 'none',
                                }}
                            />
                        )}
                    </button>
                );
            })}
        </div>
    );
}
