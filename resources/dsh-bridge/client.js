// Use the DSH workbench's session navigation so open tabs and drafts are retained.
window.__ModuleLoader__.load({
  id: '@worldlinebox/dsh-bridge',
  factory() {
    return {
      inject: ['uiWorkspace', 'sessions'],
      apply(ctx) {
        ctx.effect(() => {
          const sessions = ctx.get('sessions').list;
          const openRequested = () => {
            const match = /^#wlb-session=(wlb-bot-[a-f0-9]{64})$/.exec(location.hash);
            if (!match || sessions.getSnapshot().phase !== 'ready') return;
            history.replaceState(history.state, '', location.pathname + location.search);
            ctx.get('uiWorkspace').openSession(match[1]);
          };
          const unsubscribe = sessions.subscribe(openRequested);
          window.addEventListener('hashchange', openRequested);
          openRequested();
          return () => {
            unsubscribe();
            window.removeEventListener('hashchange', openRequested);
          };
        }, 'WorldlineBox: open the requested chat session');
      },
    };
  },
});
