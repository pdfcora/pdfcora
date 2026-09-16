const tool = (t) => ({ id: `tool-${t}`, label: t[0].toUpperCase() + t.slice(1), item: { kind: 'tool', tool: t } });
export const toolbarItems = {
    tool,
    undo: { id: 'editor-undo', label: 'Undo', item: { kind: 'undo' } },
    deleteSelection: { id: 'editor-delete', label: 'Delete', item: { kind: 'deleteSelection' } },
    zoomOut: { id: 'zoom-out', label: '−', item: { kind: 'zoomOut' } },
    zoomIn: { id: 'zoom-in', label: '+', item: { kind: 'zoomIn' } },
    fitWidth: { id: 'zoom-fit', label: 'Fit', item: { kind: 'fitWidth' } },
    pageBack: { id: 'page-back', label: '‹', item: { kind: 'pageBack' } },
    pageForward: { id: 'page-forward', label: '›', item: { kind: 'pageForward' } },
    save: { id: 'editor-save', label: 'Save', item: { kind: 'save' } },
    spacer: { id: 'spacer', label: '', item: { kind: 'spacer' } },
    divider: { id: 'divider', label: '', item: { kind: 'divider' } },
    custom: (id, label, content, action) => ({ id, label, item: { kind: 'custom', content, action } }),
};
export const defaultToolbar = {
    items: [
        tool('select'), tool('ink'), tool('note'), tool('highlight'), tool('redact'),
        toolbarItems.divider, toolbarItems.undo, toolbarItems.deleteSelection,
        toolbarItems.spacer,
        toolbarItems.zoomOut, toolbarItems.fitWidth, toolbarItems.zoomIn,
        toolbarItems.divider, toolbarItems.save,
    ],
};
/** Viewing only: no tools, no save. */
export const viewingToolbar = {
    items: [
        toolbarItems.pageBack, toolbarItems.pageForward, toolbarItems.spacer,
        toolbarItems.zoomOut, toolbarItems.fitWidth, toolbarItems.zoomIn,
    ],
};
//# sourceMappingURL=toolbar.js.map