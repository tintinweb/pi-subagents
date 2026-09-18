export default function focusAdapterProbe(pi) {
  let ctx;
  pi.on("session_start", (_event, sessionContext) => {
    ctx = sessionContext;
  });
  pi.events.on("pi-focus:bind-child", (request) => {
    if (!ctx || typeof request?.acknowledge !== "function") return;
    pi.appendEntry("focus-adapter-probe", {
      sessionId: ctx.sessionManager.getSessionId(),
      focusId: request.focusId,
      subfocusId: request.subfocusId ?? null,
    });
    request.acknowledge({ ok: true });
  });
}
