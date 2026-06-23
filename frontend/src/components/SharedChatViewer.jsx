import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { Bot, User, MessageSquare } from 'lucide-react';
import { API_BASE } from '../config';

const SharedChatViewer = ({ shareId }) => {
    const [chatData, setChatData] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);

    useEffect(() => {
        const fetchSharedChat = async () => {
            try {
                const response = await axios.get(`${API_BASE}/chat/shared/${shareId}`);
                setChatData(response.data);
            } catch (err) {
                setError('Failed to load shared chat');
            } finally {
                setLoading(false);
            }
        };

        if (shareId) {
            fetchSharedChat();
        }
    }, [shareId]);

    const formatTs = (ts) => {
        try {
            return new Date(ts).toLocaleString();
        } catch {
            return 'Unknown time';
        }
    };

    if (loading) {
        return (
            <div style={{ padding: '2rem', textAlign: 'center' }}>
                <div>Loading shared chat...</div>
            </div>
        );
    }

    if (error) {
        return (
            <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-error)' }}>
                <div>{error}</div>
            </div>
        );
    }

    if (!chatData) {
        return (
            <div style={{ padding: '2rem', textAlign: 'center' }}>
                <div>Chat not found</div>
            </div>
        );
    }

    return (
        <div style={{ maxWidth: '800px', margin: '0 auto', padding: '2rem' }}>
            <div style={{ marginBottom: '2rem', textAlign: 'center' }}>
                <h1 style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem', margin: '0 0 0.5rem 0' }}>
                    <MessageSquare size={24} />
                    {chatData.title}
                </h1>
                <p style={{ margin: 0, opacity: 0.6, fontSize: '0.9rem' }}>
                    Shared on {formatTs(chatData.created_at)}
                    {chatData.limited && ' • Limited to latest 4 messages'}
                </p>
            </div>

            <div style={{ background: 'var(--bg-secondary)', borderRadius: '8px', padding: '1.5rem' }}>
                {chatData.messages.map((message, index) => (
                    <div key={message.id || index} style={{ display: 'flex', gap: '0.75rem', marginBottom: index < chatData.messages.length - 1 ? '1.5rem' : 0, alignItems: 'flex-start' }}>
                        <div style={{ 
                            width: 36, 
                            height: 36, 
                            borderRadius: '50%', 
                            flexShrink: 0, 
                            display: 'flex', 
                            alignItems: 'center', 
                            justifyContent: 'center', 
                            background: message.type === 'bot' ? 'var(--brand-blue)' : 'var(--brand-green)' 
                        }}>
                            {message.type === 'bot' ? <Bot size={18} color="white" /> : <User size={18} color="white" />}
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
                                <span style={{ fontWeight: 700, fontSize: '0.9rem' }}>
                                    {message.type === 'bot' ? 'AI Assistant' : 'User'}
                                </span>
                                <span style={{ fontSize: '0.75rem', opacity: 0.5 }}>
                                    {formatTs(message.timestamp)}
                                </span>
                            </div>
                            <div style={{ 
                                whiteSpace: 'pre-wrap', 
                                lineHeight: 1.6,
                                fontSize: '0.95rem'
                            }}>
                                {message.content}
                            </div>
                        </div>
                    </div>
                ))}
            </div>

            <div style={{ marginTop: '2rem', textAlign: 'center', opacity: 0.6, fontSize: '0.85rem' }}>
                <p>This is a shared chat thread from TradingSpy</p>
            </div>
        </div>
    );
};

export default SharedChatViewer;
