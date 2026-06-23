import React, { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { motion } from 'framer-motion';

const ExpandableSection = ({ label, icon, color = 'var(--brand-yellow)', defaultOpen = true, children }) => {
    const [open, setOpen] = useState(defaultOpen);

    return (
        <div className="panel">
            <div
                onClick={() => setOpen(prev => !prev)}
                style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.5rem',
                    marginBottom: open ? '1.25rem' : 0,
                    color,
                    cursor: 'pointer',
                    userSelect: 'none',
                }}
            >
                {icon}
                <span style={{ flex: 1, fontWeight: 700, fontSize: '1.1rem' }}>{label}</span>
                <motion.div
                    animate={{ rotate: open ? 180 : 0 }}
                    transition={{ duration: 0.2 }}
                >
                    <ChevronDown size={18} />
                </motion.div>
            </div>
            <motion.div
                initial={false}
                animate={{
                    height: open ? 'auto' : 0,
                    opacity: open ? 1 : 0,
                }}
                transition={{ duration: 0.25, ease: 'easeInOut' }}
                style={{ overflow: 'hidden' }}
            >
                {children}
            </motion.div>
        </div>
    );
};

export default ExpandableSection;
