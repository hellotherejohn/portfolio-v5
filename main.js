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

  // ---------- video-loop: press the "2025 Reel" button to grow the card
  // in place (pushing the content below it down, not a modal/overlay), then
  // crossfade over to the full Vimeo reel ----------
  const videoLoop = document.getElementById('videoLoop');
  const videoLoopVideo = videoLoop.querySelector('video');
  const videoWatchBtn = document.getElementById('videoWatchBtn');
  const videoMinimizeBtn = document.getElementById('videoMinimizeBtn');
  const videoEmbedWrap = document.getElementById('videoEmbedWrap');
  const VIMEO_EMBED_SRC = 'https://player.vimeo.com/video/1145039675?h=a79b5bc91c&autoplay=1&title=0&byline=0&portrait=0';

  function expandVideo() {
    if (videoLoop.classList.contains('expanded')) return; // already open -- e.g. a click landing on the loop itself while expanded
    videoLoop.classList.add('expanded');
    videoLoopVideo.pause(); // less flicker while it's blurring and the Vimeo embed swaps in over it
    // .video-loop's own CSS transition (width, 550ms) does the actual grow --
    // this just waits for it to land before swapping in the embed, so the
    // crossfade starts once there's actually room for it rather than mid-grow.
    const onGrowDone = (e) => {
      if (e.propertyName !== 'width') return;
      videoLoop.removeEventListener('transitionend', onGrowDone);
      const iframe = document.createElement('iframe');
      iframe.src = VIMEO_EMBED_SRC;
      iframe.allow = 'autoplay; fullscreen; picture-in-picture';
      iframe.allowFullscreen = true;
      iframe.setAttribute('frameborder', '0');
      videoEmbedWrap.appendChild(iframe);
      requestAnimationFrame(() => videoEmbedWrap.classList.add('visible'));
    };
    videoLoop.addEventListener('transitionend', onGrowDone);
  }

  function collapseVideo(e) {
    // The minimize button is a descendant of .video-loop, so without this a
    // click on it would also bubble up into videoLoop's own click-to-expand
    // listener below and immediately reopen what this just closed.
    if (e) e.stopPropagation();
    videoEmbedWrap.classList.remove('visible');
    videoLoop.classList.remove('expanded');
    videoLoopVideo.play();
    const onShrinkDone = (e) => {
      if (e.propertyName !== 'width') return;
      videoLoop.removeEventListener('transitionend', onShrinkDone);
      videoEmbedWrap.innerHTML = ''; // stop the embed rather than leave it playing off-screen
    };
    videoLoop.addEventListener('transitionend', onShrinkDone);
  }

  videoWatchBtn.addEventListener('mousedown', () => videoWatchBtn.classList.add('pressed'));
  window.addEventListener('mouseup', () => videoWatchBtn.classList.remove('pressed'));
  // The whole thumbnail is clickable, not just the button -- a click on the
  // button itself still reaches this via normal bubbling, so there's only
  // ever the one listener/one place expandVideo() is actually called from.
  videoLoop.addEventListener('click', expandVideo);
  videoMinimizeBtn.addEventListener('click', collapseVideo);
});