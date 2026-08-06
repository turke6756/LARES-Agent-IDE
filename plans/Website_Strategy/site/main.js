(() => {
  'use strict';

  const acts = [...document.querySelectorAll('.act')];
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const mobile = window.matchMedia('(max-width: 767px)');

  if (!acts.length) return;

  const mediaStates = acts.map((act) => {
    const video = act.querySelector('video');
    const source = video?.querySelector('source');
    return video && source
      ? { act, video, source, visible: false, sourceNeedsLoad: false }
      : null;
  }).filter(Boolean);
  const mediaByAct = new Map(mediaStates.map((state) => [state.act, state]));

  const playVideo = (state) => {
    if (state.sourceNeedsLoad) {
      state.video.load();
      state.sourceNeedsLoad = false;
    }
    state.video.play().catch(() => {});
  };

  const syncVideoSource = (state) => {
    const desiredSource = mobile.matches
      ? state.source.dataset.mobileSrc
      : state.source.dataset.desktopSrc;

    if (!desiredSource || state.source.getAttribute('src') === desiredSource) return;

    state.video.pause();
    state.source.setAttribute('src', desiredSource);
    state.sourceNeedsLoad = true;

    if (state.visible && !reducedMotion.matches) playVideo(state);
  };

  const syncMotionPreference = () => {
    const reduce = reducedMotion.matches;
    for (const act of acts) {
      if (reduce) act.style.setProperty('--progress', '1');
    }
    for (const state of mediaStates) {
      state.video.controls = reduce;
      if (reduce) state.video.pause();
      else if (state.visible) playVideo(state);
    }
  };

  mediaStates.forEach(syncVideoSource);

  const mediaObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const state = mediaByAct.get(entry.target);
      if (!state) continue;
      state.visible = entry.intersectionRatio >= 0.18;
      if (state.visible && !reducedMotion.matches) playVideo(state);
      else state.video.pause();
    }
  }, { threshold: 0.18 });

  mediaStates.forEach(({ act }) => mediaObserver.observe(act));
  reducedMotion.addEventListener('change', syncMotionPreference);
  syncMotionPreference();

  let ticking = false;

  const updateProgress = () => {
    ticking = false;
    for (const act of acts) {
      if (reducedMotion.matches || mobile.matches) {
        act.style.setProperty('--progress', '1');
        continue;
      }
      const rect = act.getBoundingClientRect();
      const scrollable = Math.max(1, rect.height - window.innerHeight);
      const progress = Math.min(1, Math.max(0, -rect.top / scrollable));
      act.style.setProperty('--progress', progress.toFixed(4));
    }
  };

  const requestProgress = () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(updateProgress);
  };

  window.addEventListener('scroll', requestProgress, { passive: true });
  window.addEventListener('resize', requestProgress, { passive: true });
  mobile.addEventListener('change', () => {
    mediaStates.forEach(syncVideoSource);
    requestProgress();
  });
  requestProgress();

  if (location.hash.startsWith('#beat-')) {
    document.querySelector(location.hash)?.scrollIntoView({ behavior: 'instant' });
    requestProgress();
  }
})();
