import React, { useState, useEffect } from 'react';
import { RefreshCw, Zap, Brain, Code } from 'lucide-react';
import { motion } from 'framer-motion';

const StreamingIndicator = ({ isActive, stage = 'thinking', progress = 0 }) => {
    const [dots, setDots] = useState('');

    useEffect(() => {
        if (!isActive) return;
        
        const interval = setInterval(() => {
            setDots(prev => {
                if (prev.length >= 3) return '';
                return prev + '.';
            });
        }, 500);

        return () => clearInterval(interval);
    }, [isActive]);

    if (!isActive) return null;

    const getStageInfo = () => {
        switch (stage) {
            case 'thinking':
                return { icon: Brain, text: 'AI is analyzing your request', color: 'var(--brand-blue)' };
            case 'generating':
                return { icon: Code, text: 'Generating strategy code', color: 'var(--brand-purple)' };
            case 'optimizing':
                return { icon: Zap, text: 'Optimizing parameters', color: 'var(--brand-yellow)' };
            default:
                return { icon: RefreshCw, text: 'Processing', color: 'var(--brand-blue)' };
        }
    };

    const { icon: Icon, text, color } = getStageInfo();

    return (
        <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            style={{
                padding: '1rem',
                background: 'rgba(59, 130, 246, 0.1)',
                border: '1px solid rgba(59, 130, 246, 0.2)',
                borderRadius: '12px',
                marginTop: '1rem'
            }}
        >
            <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '0.75rem' }}>
                <div style={{
                    width: '40px',
                    height: '40px',
                    borderRadius: '50%',
                    background: color,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center'
                }}>
                    <Icon size={20} color="white" className={stage === 'thinking' ? 'animate-pulse' : 'animate-spin'} />
                </div>
                <div>
                    <div style={{ fontWeight: 'bold', color: color }}>
                        {text}{dots}
                    </div>
                    <div style={{ fontSize: '0.8rem', opacity: 0.7, marginTop: '0.25rem' }}>
                        This may take 10-30 seconds depending on complexity
                    </div>
                </div>
            </div>
            
            {progress > 0 && (
                <div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.5rem', fontSize: '0.8rem' }}>
                        <span>Progress</span>
                        <span>{progress}%</span>
                    </div>
                    <div style={{ 
                        height: '6px', 
                        background: 'var(--bg-app)', 
                        borderRadius: '3px', 
                        overflow: 'hidden' 
                    }}>
                        <motion.div
                            initial={{ width: 0 }}
                            animate={{ width: `${progress}%` }}
                            style={{ 
                                height: '100%', 
                                background: `linear-gradient(90deg, ${color}, ${color}aa)`,
                                borderRadius: '3px'
                            }}
                        />
                    </div>
                </div>
            )}
        </motion.div>
    );
};

export default StreamingIndicator;