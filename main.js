document.addEventListener('DOMContentLoaded', () => {
  const links = document.querySelectorAll('.shuffle-link');

  links.forEach(link => {
    const text = link.textContent;
    link.innerHTML = '';
    let isShuffled = false;

    // Wrap each character in a span, preserving spaces
    for (let char of text) {
      if (char === ' ') {
        link.appendChild(document.createTextNode(' '));
      } else {
        const span = document.createElement('span');
        span.textContent = char;
        link.appendChild(span);
      }
    }

    function shuffleChars() {
      const chars = link.querySelectorAll('span');
      chars.forEach(char => {
        const randomX = (Math.random() - 0.5) * 2;
        const randomY = (Math.random() - 0.5) * 8;
        const randomRotation = (Math.random() - 0.5) * 30;
        char.style.transform = `translate(${randomX}px, ${randomY}px) rotate(${randomRotation}deg)`;
      });
    }

    link.addEventListener('mouseenter', () => {
      if (!isShuffled) {
        shuffleChars();
        isShuffled = true;
      }
    });

    link.addEventListener('mouseleave', () => {
      const chars = link.querySelectorAll('span');
      chars.forEach(char => {
        char.style.transform = 'none';
      });
      isShuffled = false;
    });
  });

  // ---------- video-loop: press "2025 Reel" to grow the card in place
  // (pushing the content below it down, not a modal), then crossfade over
  // to the full Vimeo reel ----------
  const videoLoop = document.getElementById('videoLoop');
  const videoLoopVideo = videoLoop.querySelector('video');
  const videoWatchBtn = document.getElementById('videoWatchBtn');
  const videoMinimizeBtn = document.getElementById('videoMinimizeBtn');
  const videoEmbedWrap = document.getElementById('videoEmbedWrap');
  const VIMEO_EMBED_SRC = 'https://player.vimeo.com/video/1145039675?h=a79b5bc91c&autoplay=1&title=0&byline=0&portrait=0';

  function expandVideo() {
    if (videoLoop.classList.contains('expanded')) return;
    videoLoop.classList.add('expanded');
    videoLoopVideo.pause();
    // Wait for .video-loop's own width transition to finish before swapping
    // in the embed, so the crossfade starts once there's room for it.
    const onGrowDone = (e) => {
      if (e.propertyName !== 'width') return;
      videoLoop.removeEventListener('transitionend', onGrowDone);
      const iframe = document.createElement('iframe');
      iframe.allow = 'autoplay; fullscreen; picture-in-picture';
      iframe.allowFullscreen = true;
      iframe.setAttribute('frameborder', '0');
      // The dots loader (.video-loading) is visible as soon as .expanded is
      // added, on top of the still-blurred loop -- .embed-ready hides it
      // and starts the crossfade only once the iframe has actually
      // loaded, so a slow Vimeo load doesn't leave a blank/blurred gap.
      iframe.addEventListener('load', () => {
        videoLoop.classList.add('embed-ready');
        videoEmbedWrap.classList.add('visible');
      });
      iframe.src = VIMEO_EMBED_SRC;
      videoEmbedWrap.appendChild(iframe);
    };
    videoLoop.addEventListener('transitionend', onGrowDone);
  }

  function collapseVideo(e) {
    // Stop the click from bubbling into videoLoop's own expand listener.
    if (e) e.stopPropagation();
    videoEmbedWrap.classList.remove('visible');
    videoLoop.classList.remove('expanded', 'embed-ready');
    videoLoopVideo.play();
    const onShrinkDone = (e) => {
      if (e.propertyName !== 'width') return;
      videoLoop.removeEventListener('transitionend', onShrinkDone);
      videoEmbedWrap.innerHTML = '';
    };
    videoLoop.addEventListener('transitionend', onShrinkDone);
  }

  videoWatchBtn.addEventListener('mousedown', () => videoWatchBtn.classList.add('pressed'));
  window.addEventListener('mouseup', () => videoWatchBtn.classList.remove('pressed'));
  // The whole thumbnail is clickable, not just the button.
  videoLoop.addEventListener('click', expandVideo);
  videoMinimizeBtn.addEventListener('click', collapseVideo);

  // ---------- Fonts pill: click "Fonts" to fan a small stack of pills out
  // above it. Each pill spawns in with an elastic entrance (staggered per
  // item), then while open, hovering a pill has it magnetically chase the
  // cursor a little and spring back on release -- a small physics sim
  // driving --spring-x/--spring-y/--pill-scale every frame, layered on top
  // of its fixed resting position. ----------
  const fontsMenu = document.getElementById('fontsMenu');
  if (fontsMenu) {
    const fontsMenuTrigger = document.getElementById('fontsMenuTrigger');
    const fontsFan = document.getElementById('fontsFan');

    // JK Roadium is commented out until it's ready to launch -- uncomment
    // to bring it back. "More soon" is a permanent, unlinked placeholder
    // (null href -- see the disabled-pill handling below and
    // .fanPill.disabled in the stylesheet).
    const FONT_ITEMS = [
      // { label: 'JK Roadium', href: 'fonts/roadium/' },
      { label: 'More soon\u2026', href: null },
    ];

    // macOS's dock "fan" stack is the reference: items stack straight up
    // from the trigger, each one drifting a little further right and
    // rotating a little further clockwise than the one below it.
    const FAN_LIFT = 17; // px from the trigger's center to the first pill
    const FAN_STEP_Y = 48; // additional vertical stacking distance per item
    const FAN_STEP_X = 16; // rightward drift per item
    const FAN_STEP_ROTATE = 8; // degrees of extra clockwise lean per item
    const FOLLOW_STRENGTH = 0.4; // fraction of the cursor's offset a hovered pill's spring target takes on
    const FOLLOW_MAX = 14; // px -- clamps how far a pill can be pulled toward the cursor
    const POSITION_STIFFNESS = 0.14;
    const POSITION_DAMPING = 0.82; // underdamped on purpose -- a gentle overshoot on release is the "sticky" feel
    const SCALE_EASE = 0.2; // plain exponential ease, no overshoot

    // A minimal damped-spring integrator: update() nudges value toward
    // target using force/velocity/damping rather than a fixed CSS timeline,
    // which is what gives the hover motion its lag/overshoot feel.
    function createSpring(stiffness, damping) {
      let value = 0, velocity = 0, target = 0;
      return {
        set target(t) { target = t; },
        update() {
          const force = (target - value) * stiffness;
          velocity = (velocity + force) * damping;
          value += velocity;
          return value;
        },
        get settled() {
          return Math.abs(target - value) < 0.05 && Math.abs(velocity) < 0.05;
        },
      };
    }

    // A plain exponential ease (no velocity/overshoot) -- used only for
    // scale, since sharing the position spring made it look jittery.
    function createEase(factor) {
      let value = 1, target = 1;
      return {
        set target(t) { target = t; },
        update() {
          value += (target - value) * factor;
          return value;
        },
        get settled() {
          return Math.abs(target - value) < 0.001;
        },
      };
    }

    const pills = FONT_ITEMS.map((item, i) => {
      const home = document.createElement('div');
      home.className = 'fanPillHome';

      // i=0 is the bottom-most pill (closest to the trigger); each one
      // above it drifts further right and rotates further clockwise.
      const homeX = i * FAN_STEP_X;
      const homeY = -(FAN_LIFT + i * FAN_STEP_Y);
      const homeRotate = i * FAN_STEP_ROTATE;
      home.style.setProperty('--home-x', `${homeX}px`);
      home.style.setProperty('--home-y', `${homeY}px`);
      home.style.setProperty('--home-rotate', `${homeRotate}deg`);
      home.style.setProperty('--stagger-delay', `${i * 20}ms`);

      // A null href means it's not a real, navigable item -- render as a
      // plain <span> rather than a dead link.
      const pill = document.createElement(item.href ? 'a' : 'span');
      pill.className = item.href ? 'fanPill' : 'fanPill disabled';
      if (item.href) pill.href = item.href;
      pill.textContent = item.label;
      home.appendChild(pill);
      fontsFan.appendChild(home);

      const springX = createSpring(POSITION_STIFFNESS, POSITION_DAMPING);
      const springY = createSpring(POSITION_STIFFNESS, POSITION_DAMPING);
      const springScale = createEase(SCALE_EASE);

      pill.addEventListener('mouseenter', () => {
        springScale.target = 1.08;
      });
      pill.addEventListener('mousemove', (e) => {
        const rect = pill.getBoundingClientRect();
        const dx = (e.clientX - (rect.left + rect.width / 2)) * FOLLOW_STRENGTH;
        const dy = (e.clientY - (rect.top + rect.height / 2)) * FOLLOW_STRENGTH;
        springX.target = Math.max(-FOLLOW_MAX, Math.min(FOLLOW_MAX, dx));
        springY.target = Math.max(-FOLLOW_MAX, Math.min(FOLLOW_MAX, dy));
      });
      pill.addEventListener('mouseleave', () => {
        springX.target = 0;
        springY.target = 0;
        springScale.target = 1;
      });

      return { home, pill, springX, springY, springScale };
    });

    let rafId = null;
    function tick() {
      let anySettling = false;
      pills.forEach(({ pill, springX, springY, springScale }) => {
        pill.style.setProperty('--spring-x', `${springX.update()}px`);
        pill.style.setProperty('--spring-y', `${springY.update()}px`);
        pill.style.setProperty('--pill-scale', springScale.update());
        if (!springX.settled || !springY.settled || !springScale.settled) anySettling = true;
      });
      // Keep running while the fan is open, or until every spring has
      // settled, so a hover released as the menu closes still finishes.
      if (fontsMenu.classList.contains('open') || anySettling) {
        rafId = requestAnimationFrame(tick);
      } else {
        rafId = null;
      }
    }
    function ensureTicking() {
      if (rafId === null) rafId = requestAnimationFrame(tick);
    }

    function openFontsMenu() {
      fontsMenu.classList.add('open');
      fontsMenuTrigger.setAttribute('aria-expanded', 'true');
      ensureTicking();
    }
    function closeFontsMenu() {
      fontsMenu.classList.remove('open');
      fontsMenuTrigger.setAttribute('aria-expanded', 'false');
      ensureTicking();
    }
    fontsMenuTrigger.addEventListener('click', () => {
      if (fontsMenu.classList.contains('open')) closeFontsMenu();
      else openFontsMenu();
    });
    document.addEventListener('click', (e) => {
      if (!fontsMenu.contains(e.target)) closeFontsMenu();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeFontsMenu();
    });
  }
});
