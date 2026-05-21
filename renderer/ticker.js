/**
 * ticker.js — Detection ticker for the play screen
 *
 * Append-only map of unique labels. Words scroll continuously from the right.
 * When the latest spawned word is fully inside the viewport, mapIndex advances
 * (wraps to 0 when index === map.length) and map[mapIndex] is appended as
 * the next word. Mid-scroll map growth only appends to the map array.
 */

'use strict';

const DEFAULT_SPEED_PX_S = 36;

/**
 * @param {Object} options
 * @param {HTMLElement} options.trackEl - Inner track element (transform target)
 * @param {HTMLElement} [options.containerEl] - Overflow clip container (defaults to track parent)
 * @param {number} [options.speedPxPerSec] - Horizontal drift speed in pixels per second
 */
export const createTicker = ({
  trackEl,
  containerEl,
  speedPxPerSec = DEFAULT_SPEED_PX_S,
} = {}) => {
  if (!trackEl) throw new Error('createTicker: trackEl is required');

  const container = containerEl || trackEl.parentElement;

  /** @type {Set<string>} */
  let seen = new Set();
  /** @type {string[]} append-only, never removed mid-round */
  let map = [];
  /** @type {number} index of the next word to spawn onto the tape */
  let mapIndex = 0;
  /** @type {number} total horizontal scroll in pixels (monotonic) */
  let scrollPx = 0;
  /** @type {number} scrollPx at which the next word should be spawned */
  let nextSpawnAt = 0;
  let rafId = null;
  let lastTs = 0;
  let running = false;
  /** @type {Set<string>} */
  let excludeLower = new Set();
  /** @type {Set<string>} */
  let targetLower = new Set();

  const containerWidth = () => (container ? container.clientWidth : 0);

  const applyTransform = () => {
    const cw = containerWidth();
    trackEl.style.transform = `translate3d(${cw - scrollPx}px, 0, 0)`;
  };

  const appendWord = (text) => {
    const span = document.createElement('span');
    const key = text.toLowerCase();
    span.className = targetLower.has(key)
      ? 'play-ticker-word play-ticker-word--target'
      : 'play-ticker-word';
    span.textContent = text;
    trackEl.appendChild(span);
    return span;
  };

  /** Left edge offset of a span within the track (sum of prior sibling widths). */
  const spanTrackOffset = (span) => {
    let offset = 0;
    let node = trackEl.firstElementChild;
    while (node && node !== span) {
      offset += node.getBoundingClientRect().width;
      node = node.nextElementSibling;
    }
    return offset;
  };

  /**
   * A word is fully in when its right edge meets the container's right edge.
   * With translateX(cw - scrollPx), screen left = trackOffset - scrollPx + cw... 
   * screen right = trackOffset - scrollPx + cw + wordWidth
   * Fully in when screen right === cw → scrollPx === trackOffset + wordWidth
   */
  const fullyInAt = (trackOffset, wordWidth) => trackOffset + wordWidth;

  const spawnWord = () => {
    const text = map[mapIndex];
    const span = appendWord(text);
    const offset = spanTrackOffset(span);
    const w = Math.max(span.getBoundingClientRect().width, 1);
    nextSpawnAt = fullyInAt(offset, w);

    mapIndex += 1;
    if (mapIndex >= map.length) {
      mapIndex = 0;
    }
  };

  const trySpawn = () => {
    if (map.length === 0) return;
    while (scrollPx >= nextSpawnAt) {
      spawnWord();
    }
  };

  const trimOffLeft = () => {
    const cw = containerWidth();
    let first = trackEl.firstElementChild;
    while (first) {
      const offset = spanTrackOffset(first);
      const w = first.getBoundingClientRect().width;
      const screenRight = offset - scrollPx + cw + w;
      if (screenRight >= 0) break;
      scrollPx -= w;
      nextSpawnAt -= w;
      first.remove();
      first = trackEl.firstElementChild;
    }
  };

  const tick = (ts) => {
    if (!running) return;
    if (!lastTs) lastTs = ts;
    const dt = Math.min((ts - lastTs) / 1000, 0.1);
    lastTs = ts;

    if (map.length > 0) {
      scrollPx += speedPxPerSec * dt;
      trySpawn();
      trimOffLeft();
      applyTransform();
    }

    rafId = requestAnimationFrame(tick);
  };

  return {
    setExcludeLabels(labels) {
      excludeLower = new Set((labels || []).map((l) => l.toLowerCase()));
    },

    setTargetLabels(labels) {
      targetLower = new Set((labels || []).map((l) => l.toLowerCase()));
    },

    addDetections(labels) {
      let wasEmpty = map.length === 0;
      for (const raw of labels || []) {
        const text = (raw || '').trim();
        const key = text.toLowerCase();
        if (!text || excludeLower.has(key) || seen.has(key)) continue;
        seen.add(key);
        map.push(text);
      }

      if (wasEmpty && map.length > 0) {
        mapIndex = 0;
        scrollPx = 0;
        nextSpawnAt = 0;
        trackEl.replaceChildren();
        trySpawn();
        applyTransform();
      }
    },

    reset() {
      seen = new Set();
      map = [];
      mapIndex = 0;
      scrollPx = 0;
      nextSpawnAt = 0;
      lastTs = 0;
      targetLower = new Set();
      trackEl.replaceChildren();
      trackEl.style.transform = '';
    },

    start() {
      if (running) return;
      running = true;
      lastTs = 0;
      rafId = requestAnimationFrame(tick);
    },

    stop() {
      running = false;
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
    },
  };
};
