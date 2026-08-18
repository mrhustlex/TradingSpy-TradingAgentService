import { useCallback, useRef, useState } from 'react';

/**
 * Pull-to-resize for bottom sheets: dragging the handle up enlarges the sheet,
 * dragging down shrinks it. Returns the current height (null = CSS default)
 * plus the pointer handlers to attach to the handle element.
 */
export default function useSheetResize(minRatio = 0.45, maxRatio = 0.96, defaultRatio = 0.75) {
  const [sheetHeight, setSheetHeight] = useState(null);
  const dragRef = useRef(null);

  const startDrag = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    const vh = window.innerHeight || 700;
    dragRef.current = {
      startY: e.clientY,
      startH: sheetHeight ?? Math.round(vh * defaultRatio),
      minH: Math.round(vh * minRatio),
      maxH: Math.round(vh * maxRatio),
    };
    window.addEventListener('pointermove', onDragMove);
    window.addEventListener('pointerup', endDrag);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheetHeight, minRatio, maxRatio, defaultRatio]);

  const onDragMove = useCallback((e) => {
    if (!dragRef.current) return;
    const { startY, startH, minH, maxH } = dragRef.current;
    const next = startH + (startY - e.clientY);
    setSheetHeight(Math.max(minH, Math.min(maxH, next)));
  }, []);

  const endDrag = useCallback(() => {
    dragRef.current = null;
    window.removeEventListener('pointermove', onDragMove);
    window.removeEventListener('pointerup', endDrag);
  }, [onDragMove]);

  return {
    sheetHeight,
    handleProps: {
      onPointerDown: startDrag,
      style: { cursor: 'row-resize', touchAction: 'none', userSelect: 'none', WebkitUserSelect: 'none' },
    },
    sheetStyle: sheetHeight ? { height: sheetHeight, maxHeight: sheetHeight } : undefined,
  };
}
