// Fixed main-frame launch wrapper; invoked only after the native, isolated WK
// installer acknowledges completion. No generic review/fresh-catalog assertion.
((scope) => {
  void (async () => {
    if (window.__echoNativeCodingLaunchStarted) return;
    window.__echoNativeCodingLaunchStarted = true;
    const invoke = window.__TAURI_INTERNALS__.invoke;
    const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const key = 'echoagent.native-code-review.v1';
    const report = { environment: 'native Echo Code acceptance', phase: 'unknown', checks: [], errors: [], passed: false, activeStep: 'native-context' };
    try {
      const context = await invoke('desktop_review_context');
      report.phase = context.phase;
      report.nativeContext = context;
      if (context.home !== scope.home || typeof scope.nonce !== 'string' || scope.nonce.length < 24) {
        throw new Error('Native Code installer and renderer contexts do not agree');
      }
      report.activeStep = 'app-shell-mounted';
      const shellReady = () => document.querySelector('.app__body') && document.querySelector('.sidebar__nav')
        && (document.querySelector('.home__title') || document.querySelector('.echo-composer') || document.querySelector('.app__coding-surface'));
      const deadline = Date.now() + 60000;
      while (!shellReady() && Date.now() < deadline) await delay(100);
      if (!shellReady()) throw new Error('Native app shell did not initialize for Code acceptance: app-shell-mounted');
      report.activeStep = 'retained-session-catalog';
      const main = JSON.parse(localStorage.getItem('echoagent.native-review.v1') || 'null');
      if (main?.version !== 1 || !main.session?.sessionId || !main.session?.cwd) {
        throw new Error('The existing isolated native review has no retained main session');
      }
      const sessions = await invoke('agent_list_all_sessions', { includeArchived: true });
      const session = sessions.find((item) => item.sessionId === main.session.sessionId);
      if (!session || session.cwd !== main.session.cwd || !session.cwd.startsWith(`${scope.home}/`)) {
        throw new Error('The retained main session no longer belongs to this isolated home');
      }
      report.sessionId = session.sessionId;
      report.workspace = session.cwd;
      const stored = JSON.parse(localStorage.getItem(key) || 'null');
      const continuing = context.phase === 'first-launch' && scope.continueExistingTask === true;
      const continuingDelivery = context.phase === 'first-launch' && scope.continueDeliveryReview === true;
      if (continuing && continuingDelivery) throw new Error('Code continuation modes are mutually exclusive');
      if (context.phase === 'first-launch' && stored && !continuing && !continuingDelivery) {
        throw new Error('Code review marker already exists; preserving the earlier acceptance evidence');
      }
      if (continuing && (stored?.version !== 1 || stored.sessionId !== session.sessionId
        || !stored.expected || stored.expected.verificationId || stored.expected.contentRevision)) {
        throw new Error('No matching untouched failed Code acceptance marker exists');
      }
      if (continuingDelivery && (stored?.version !== 1 || stored.sessionId !== session.sessionId
        || !stored.expected || stored.expected.cwd !== session.cwd)) {
        throw new Error('No matching retained Code delivery review marker exists');
      }
      if (context.phase === 'restart' && (stored?.version !== 1 || stored.sessionId !== session.sessionId)) {
        throw new Error('No matching first-launch Code acceptance marker exists');
      }
      const coding = await window.__echoNativeCodingReview({ invoke, home: scope.home, cwd: session.cwd,
        nonce: scope.nonce, sessionId: session.sessionId, phase: context.phase, expected: stored?.expected,
        continueExistingTask: continuing, continueDeliveryReview: continuingDelivery });
      report.coding = coding;
      report.checks = coding.checks;
      report.errors = coding.errors;
      report.passed = coding.passed === true;
      report.activeStep = coding.activeStep;
      report.failureContext = coding.failureContext;
      // Save only acceptance expectations, never mutate the production task or
      // session store to make a restart check pass. Retain failed expectations.
      if (context.phase === 'first-launch' && coding.expected) {
        localStorage.setItem(key, JSON.stringify({ version: 1, sessionId: session.sessionId, expected: coding.expected }));
      }
    } catch (error) { report.errors.push(String(error)); report.passed = false; }
    report.finishedAt = new Date().toISOString();
    await invoke('desktop_review_complete', { report });
  })();
})
