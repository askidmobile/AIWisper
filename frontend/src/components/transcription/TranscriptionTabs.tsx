import React from 'react';

export type TabType = 'dialogue' | 'chunks' | 'speakers';

interface Tab {
    id: TabType;
    label: string;
    icon?: string;
}

const TABS: Tab[] = [
    { id: 'dialogue', label: 'Диалог', icon: '💬' },
    { id: 'chunks', label: 'Чанки', icon: '📦' },
    { id: 'speakers', label: 'Спикеры', icon: '👥' },
];

interface TranscriptionTabsProps {
    activeTab: TabType;
    onTabChange: (tab: TabType) => void;
    chunksCount?: number;
    speakersCount?: number;
}

/**
 * Компонент вкладок для переключения между режимами просмотра транскрипции
 */
export const TranscriptionTabs: React.FC<TranscriptionTabsProps> = ({
    activeTab,
    onTabChange,
    chunksCount,
    speakersCount,
}) => {
    return (
        <div style={{
            display: 'flex',
            gap: '0.5rem',
            marginBottom: '1rem',
            borderBottom: '1px solid var(--border)',
            paddingBottom: '0.5rem',
        }}>
            {TABS.map(tab => (
                <TabButton
                    key={tab.id}
                    tab={tab}
                    isActive={activeTab === tab.id}
                    onClick={() => onTabChange(tab.id)}
                    badge={
                        tab.id === 'chunks' ? chunksCount :
                        tab.id === 'speakers' ? speakersCount :
                        undefined
                    }
                />
            ))}
        </div>
    );
};

interface TabButtonProps {
    tab: Tab;
    isActive: boolean;
    onClick: () => void;
    badge?: number;
}

const TabButton: React.FC<TabButtonProps> = ({ tab, isActive, onClick, badge }) => (
    <button
        onClick={onClick}
        style={{
            padding: '0.5rem 1rem',
            fontSize: '0.85rem',
            fontWeight: isActive ? 600 : 400,
            color: isActive ? 'var(--primary)' : 'var(--text-muted)',
            backgroundColor: isActive ? 'rgba(138, 43, 226, 0.1)' : 'transparent',
            border: 'none',
            borderRadius: '6px',
            cursor: 'pointer',
            transition: 'all 0.2s ease',
            display: 'flex',
            alignItems: 'center',
            gap: '0.4rem',
        }}
    >
        {tab.icon && <span>{tab.icon}</span>}
        <span>{tab.label}</span>
        {badge !== undefined && badge > 0 && (
            <span style={{
                fontSize: '0.7rem',
                backgroundColor: isActive ? 'var(--primary)' : 'var(--surface-strong)',
                color: isActive ? 'white' : 'var(--text-muted)',
                padding: '0.1rem 0.4rem',
                borderRadius: '999px',
                minWidth: '1.2rem',
                textAlign: 'center',
            }}>
                {badge}
            </span>
        )}
    </button>
);

export default TranscriptionTabs;
