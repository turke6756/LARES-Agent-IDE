(() => {
  'use strict';

  const act = document.querySelector('.act--workspaces');
  const video = act?.querySelector('video');
  const videoSource = video?.querySelector('source');
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const mobile = window.matchMedia('(max-width: 767px)');

  if (!act || !video || !videoSource) return;

  let actIsVisible = false;
  let sourceNeedsLoad = false;

  const playVideo = () => {
    if (sourceNeedsLoad) {
      video.load();
      sourceNeedsLoad = false;
    }
    video.play().catch(() => {});
  };

  const syncVideoSource = () => {
    const desiredSource = mobile.matches
      ? videoSource.dataset.mobileSrc
      : videoSource.dataset.desktopSrc;

    if (!desiredSource || videoSource.getAttribute('src') === desiredSource) return;

    video.pause();
    videoSource.setAttribute('src', desiredSource);
    sourceNeedsLoad = true;

    if (actIsVisible && !reducedMotion.matches) {
      playVideo();
    }
  };

  const syncMotionPreference = () => {
    const reduce = reducedMotion.matches;
    video.controls = reduce;
    if (reduce) {
      video.pause();
      act.style.setProperty('--progress', '1');
    } else if (actIsVisible) {
      playVideo();
    }
  };

  syncVideoSource();

  const mediaObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      actIsVisible = entry.isIntersecting;
      if (entry.isIntersecting && !reducedMotion.matches) {
        playVideo();
      } else {
        video.pause();
      }
    }
  }, { threshold: 0.18 });

  mediaObserver.observe(act);
  reducedMotion.addEventListener('change', syncMotionPreference);
  syncMotionPreference();

  let ticking = false;

  const updateProgress = () => {
    ticking = false;
    if (reducedMotion.matches || mobile.matches) {
      act.style.setProperty('--progress', '1');
      return;
    }

    const rect = act.getBoundingClientRect();
    const scrollable = Math.max(1, rect.height - window.innerHeight);
    const progress = Math.min(1, Math.max(0, -rect.top / scrollable));
    act.style.setProperty('--progress', progress.toFixed(4));
  };

  const requestProgress = () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(updateProgress);
  };

  window.addEventListener('scroll', requestProgress, { passive: true });
  window.addEventListener('resize', requestProgress, { passive: true });
  mobile.addEventListener('change', () => {
    syncVideoSource();
    requestProgress();
  });
  requestProgress();

  if (location.hash.startsWith('#beat-')) {
    document.querySelector(location.hash)?.scrollIntoView({ behavior: 'instant' });
    requestProgress();
  }
})();
