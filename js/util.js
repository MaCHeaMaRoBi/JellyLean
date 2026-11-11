/* Shared helpers: DOM, formatting, focus navigation, events.
   ES5 syntax on purpose - Tizen 3.0 ships an older V8 than most tooling assumes. */
(function (global) {
    'use strict';

    function $(sel, root) { return (root || document).querySelector(sel); }

    function $all(sel, root) {
        return Array.prototype.slice.call((root || document).querySelectorAll(sel));
    }

    function el(tag, className, text) {
        var node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined && text !== null) node.textContent = text;
        return node;
    }

    function clear(node) {
        while (node && node.firstChild) node.removeChild(node.firstChild);
    }

    function esc(value) {
        return String(value === undefined || value === null ? '' : value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function pad2(n) { return n < 10 ? '0' + n : '' + n; }

    /* Media time: Jellyfin speaks 100ns ticks. */
    function ticksToMs(ticks) { return Math.round((ticks || 0) / 10000); }
    function msToTicks(ms) { return Math.round((ms || 0) * 10000); }

    function fmtTime(ms) {
        var total = Math.max(0, Math.floor((ms || 0) / 1000));
        var h = Math.floor(total / 3600);
        var m = Math.floor((total % 3600) / 60);
        var s = total % 60;
        return h > 0 ? h + ':' + pad2(m) + ':' + pad2(s) : m + ':' + pad2(s);
    }

    function fmtRuntime(ticks) {
        var mins = Math.floor(ticksToMs(ticks) / 60000);
        if (mins < 60) return mins + ' min';
        return Math.floor(mins / 60) + 'h ' + (mins % 60) + 'm';
    }

    function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

    /* How long a stream gets to produce its first frame before it is called
       dead. A slow NAS and a dead stream look the same at first; only the bytes
       still to arrive differ, so budget the wait from the bitrate: 8 s of video
       at a pessimistic 1 MB/s, plus 5 s of fixed overhead. The 12 s floor is
       the old direct-play limit: a NAS spinning its disks up can take that
       long, and must not be failed early. A 40 Mbps remux gets ~45 s.
       `floorMs` keeps a caller's minimum (a cold transcode needs longer than
       its bitrate says). */
    function stallLimitMs(bitrate, floorMs) {
        var ms = clamp(5000 + (bitrate || 0) / 1000, 12000, 45000);
        return Math.max(floorMs || 0, ms);
    }

    var toastTimer = null;

    function toast(message) {
        var node = $('#toast');
        if (!node) return;
        node.textContent = message;
        node.classList.remove('hidden');
        if (toastTimer) clearTimeout(toastTimer);
        toastTimer = setTimeout(function () { node.classList.add('hidden'); }, 3200);
    }

    /* ------------------------------------------------------------ events */

    function emitter(obj) {
        var handlers = {};

        obj.on = function (name, fn) {
            (handlers[name] = handlers[name] || []).push(fn);
            return obj;
        };

        obj.off = function (name, fn) {
            var list = handlers[name];
            if (!list) return obj;
            for (var i = list.length - 1; i >= 0; i--) {
                if (list[i] === fn) list.splice(i, 1);
            }
            return obj;
        };

        obj.emit = function (name) {
            var args = Array.prototype.slice.call(arguments, 1);
            var list = handlers[name];
            if (list) {
                for (var i = 0; i < list.length; i++) {
                    try { list[i].apply(null, args); } catch (e) { console.error('[emit ' + name + ']', e); }
                }
            }
            return obj;
        };

        return obj;
    }

    /* ------------------------------------------------ geometry and scrolling
       Everything that scrolls does so with a CSS transform on a track, never
       with scrollTop/scrollLeft: transforms are composited, so a 2017 TV can
       animate them at full rate, and native scrolling cannot be eased.

         .page       vertical track inside .viewport (one per screen)
         .row-track  horizontal track inside .row-viewport (one per shelf)

       The *target* translation is kept on the element (_tx/_ty). While a
       transition is in flight, getBoundingClientRect() reports the half-way
       picture, so every measurement goes through finalRect(), which corrects
       for the pending motion. That keeps D-pad navigation exact when the viewer
       presses keys faster than the animation. */

    var SAFE_X = 96;            /* 5% of 1920: nothing important crosses this */
    var PEEK_X = 168;           /* keep the next card peeking on the right    */
    var PAGE_MARGIN = 72;       /* minimal-scroll margin, top and bottom      */

    function matches(node, selector) {
        var fn = node.matches || node.webkitMatchesSelector || node.msMatchesSelector;
        return !!fn && fn.call(node, selector);
    }

    function closest(node, selector) {
        for (var p = node; p && p.nodeType === 1; p = p.parentNode) {
            if (matches(p, selector)) return p;
        }
        return null;
    }

    function matrixOf(node) {
        var style = global.getComputedStyle(node);
        var raw = style.webkitTransform || style.transform;
        if (!raw || raw === 'none') return { x: 0, y: 0 };
        var parts;
        var m = /matrix3d\(([^)]*)\)/.exec(raw);
        if (m) {
            parts = m[1].split(',');
            return { x: parseFloat(parts[12]) || 0, y: parseFloat(parts[13]) || 0 };
        }
        m = /matrix\(([^)]*)\)/.exec(raw);
        if (m) {
            parts = m[1].split(',');
            return { x: parseFloat(parts[4]) || 0, y: parseFloat(parts[5]) || 0 };
        }
        return { x: 0, y: 0 };
    }

    function finalRect(node) {
        var r = node.getBoundingClientRect();
        var out = { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
        for (var p = node.parentNode; p && p.nodeType === 1; p = p.parentNode) {
            if (p._tx !== undefined) {
                var m = matrixOf(p);
                var dx = p._tx - m.x;
                var dy = p._ty - m.y;
                out.left += dx; out.right += dx; out.top += dy; out.bottom += dy;
            }
        }
        out.width = out.right - out.left;
        out.height = out.bottom - out.top;
        return out;
    }

    function setTranslate(node, x, y, instant) {
        if (node._tx === x && node._ty === y) return;
        node._tx = x;
        node._ty = y;
        var value = 'translate3d(' + x + 'px,' + y + 'px,0)';
        if (instant) node.classList.add('instant');
        node.style.webkitTransform = value;
        node.style.transform = value;
        if (instant) {
            void node.offsetWidth;            /* commit the jump with no transition */
            node.classList.remove('instant');
        }
    }

    function shiftTrack(track, node, instant) {
        var viewport = track.parentNode;
        var vr = viewport.getBoundingClientRect();
        var fr = finalRect(node);
        var x = track._tx || 0;

        if (fr.left < vr.left + SAFE_X) x += (vr.left + SAFE_X) - fr.left;
        else if (fr.right > vr.right - PEEK_X) x -= fr.right - (vr.right - PEEK_X);

        var min = Math.min(0, vr.width - track.scrollWidth);
        setTranslate(track, clamp(x, min, 0), 0, instant);
    }

    function shiftPage(page, node, instant) {
        var viewport = page.parentNode;
        var vr = viewport.getBoundingClientRect();
        var y = page._ty || 0;
        var fr = finalRect(node);
        var shelf = closest(node, '.row');
        var line = parseFloat(page.getAttribute('data-line'));

        if (closest(node, '[data-scroll-top]')) {
            y = 0;
        } else if (shelf && page.getAttribute('data-align') === 'row' && !isNaN(line)) {
            /* Stage layouts: the focused shelf always lands on the same line. */
            y += (vr.top + line) - finalRect(shelf).top;
        } else {
            var top = vr.top + PAGE_MARGIN;
            var bottom = vr.bottom - PAGE_MARGIN;
            if (fr.top < top || fr.bottom > bottom) {
                if (instant) y += (vr.top + vr.height * 0.36) - fr.top;
                else if (fr.top < top) y += top - fr.top;
                else y -= fr.bottom - bottom;
            }
        }

        var min = Math.min(0, vr.height - page.offsetHeight);
        setTranslate(page, 0, clamp(y, min, 0), instant);
    }

    /* Native scrollers (long picker lists inside the player): minimal scroll. */
    function shiftNative(box, node) {
        var nr = node.getBoundingClientRect();
        var br = box.getBoundingClientRect();
        if (nr.top < br.top + 8) box.scrollTop -= (br.top - nr.top) + 24;
        else if (nr.bottom > br.bottom - 8) box.scrollTop += (nr.bottom - br.bottom) + 24;
    }

    function ensureVisible(node, instant) {
        for (var p = node.parentNode; p && p !== document.body; p = p.parentNode) {
            if (!p.classList) continue;
            if (p.classList.contains('row-track')) shiftTrack(p, node, instant);
            else if (p.classList.contains('page')) { shiftPage(p, node, instant); break; }
            else if (p.classList.contains('nscroll')) shiftNative(p, node);
        }
    }

    /* focus() scrolls overflow:hidden ancestors on its own. The transform is the
       source of truth, so undo any native offset it introduced. */
    function resetNativeScroll(node) {
        for (var p = node.parentNode; p && p !== document.body; p = p.parentNode) {
            if (p.classList && (p.classList.contains('row-viewport') ||
                    p.classList.contains('viewport') || p.classList.contains('screen'))) {
                if (p.scrollLeft) p.scrollLeft = 0;
                if (p.scrollTop) p.scrollTop = 0;
            }
        }
        resetDocumentScroll();
    }

    function resetDocumentScroll() {
        if (document.body.scrollTop) document.body.scrollTop = 0;
        if (document.documentElement.scrollTop) document.documentElement.scrollTop = 0;
        if (document.body.scrollLeft) document.body.scrollLeft = 0;
    }

    /* ------------------------------------------------------- lazy artwork
       Only artwork near the viewport is requested; each card carries data-src. */

    var lazyTimer = null;
    var LAZY_X = 1500;
    var LAZY_Y = 1300;
    /* Images further out than this are dropped again: a 300-title shelf would
       otherwise keep every decoded bitmap alive for the whole session. */
    var RELEASE_X = 3200;
    var RELEASE_Y = 2600;

    function lazyCheck() {
        lazyTimer = null;
        var pending = $all('img[data-src]');
        for (var i = 0; i < pending.length; i++) {
            var img = pending[i];
            var r = finalRect(img);
            if (r.width === 0 && r.height === 0 && !img.offsetParent) continue;
            if (r.right > -LAZY_X && r.left < 1920 + LAZY_X &&
                    r.bottom > -LAZY_Y && r.top < 1080 + LAZY_Y) {
                img.src = img.getAttribute('data-src');
                img.removeAttribute('data-src');
            }
        }

        var loaded = $all('img[data-lazy][src]');
        for (var j = 0; j < loaded.length; j++) {
            var far = loaded[j];
            var box = finalRect(far);
            if (box.right > -RELEASE_X && box.left < 1920 + RELEASE_X &&
                    box.bottom > -RELEASE_Y && box.top < 1080 + RELEASE_Y) continue;
            far.setAttribute('data-src', far.getAttribute('src'));
            far.removeAttribute('src');
            far.className = '';
        }
    }

    function lazySchedule(delayMs) {
        if (lazyTimer) clearTimeout(lazyTimer);
        lazyTimer = setTimeout(lazyCheck, delayMs === undefined ? 60 : delayMs);
    }

    /* ---------------------------------------------------------- focus engine
       Remote navigation is row-based, the way every TV shelf UI works:

         LEFT / RIGHT   previous / next focusable in the same row
         UP / DOWN      previous / next row, landing on the item nearest the
                        column the viewer was last on (not the geometric
                        nearest, which jumps diagonally between shelves)

       A "row" is the closest ancestor marked data-row; a focusable outside any
       row is a row of one. data-row="nav" is the tab bar: UP enters it at the
       current tab, DOWN leaves it back to the last content item. */

    var FOCUSABLE = '[data-focusable]';
    var anchorX = 960;
    var keepAnchor = false;
    var lastContent = null;
    var pendingMemo = null;
    var listening = false;

    function isVisible(node) {
        if (!node || node.disabled) return false;
        if (node.getAttribute && node.getAttribute('data-disabled') === 'true') return false;
        var rect = node.getBoundingClientRect();
        return rect.width > 4 && rect.height > 4;
    }

    function focusables(container) {
        return $all(FOCUSABLE, container).filter(isVisible);
    }

    function rowOf(node) { return closest(node, '[data-row]') || node; }

    function isNav(node) {
        var row = closest(node, '[data-row]');
        return !!row && row.getAttribute('data-row') === 'nav';
    }

    function groupRows(nodes) {
        var rows = [];
        for (var i = 0; i < nodes.length; i++) {
            var el = rowOf(nodes[i]);
            var last = rows[rows.length - 1];
            if (last && last.el === el) last.nodes.push(nodes[i]);
            else rows.push({ el: el, nodes: [nodes[i]] });
        }
        return rows;
    }

    function centerX(node) {
        var r = finalRect(node);
        return (r.left + r.right) / 2;
    }

    function nearestX(nodes, x) {
        var best = nodes[0];
        var bestDist = Infinity;
        for (var i = 0; i < nodes.length; i++) {
            var d = Math.abs(centerX(nodes[i]) - x);
            if (d < bestDist) { bestDist = d; best = nodes[i]; }
        }
        return best;
    }

    function entryOf(row) {
        if (row.el.getAttribute && row.el.getAttribute('data-entry') === 'current') {
            for (var i = 0; i < row.nodes.length; i++) {
                if (row.nodes[i].classList.contains('current')) return row.nodes[i];
            }
        }
        return null;
    }

    /* Focus a node and bring it into view. `instant` skips the easing (used when
       restoring a screen, where animating from the top would be noise). */
    function focusNode(node, options) {
        var opts = options || {};
        if (!node) return false;
        keepAnchor = !!opts.keepAnchor;
        node._instant = !!opts.instant;
        /* preventScroll is ignored by older Tizen engines, so the reset below
           is what really matters. */
        try { node.focus({ preventScroll: true }); } catch (e) { /* detached node */ }
        /* Blink scrolls overflow:hidden ancestors AFTER the focus event has
           been dispatched, so the reset inside onFocusIn runs too early. Left
           alone, the native offset adds to the transform and the shelf sits
           half-hidden until the next focus change. */
        resetNativeScroll(node);
        node._instant = false;
        keepAnchor = false;
        return document.activeElement === node;
    }

    function onFocusIn(event) {
        var node = event.target;
        if (!node || node.nodeType !== 1 || !node.getAttribute) return;
        if (node.getAttribute('data-focusable') === null) return;
        resetNativeScroll(node);
        ensureVisible(node, !!node._instant);
        if (!isNav(node)) lastContent = node;
        if (!keepAnchor) anchorX = centerX(node);
        lazySchedule();
    }

    /* Safety net for every other focus() call (and for late native scrolls):
       the viewports never scroll natively, the transform is the only truth. */
    function onNativeScroll(event) {
        var node = event.target;
        if (!node || node === document || node === document.documentElement || node === document.body) {
            resetDocumentScroll();
            return;
        }
        if (!node.classList) return;
        if (node.classList.contains('row-viewport') || node.classList.contains('viewport') ||
                node.classList.contains('screen')) {
            if (node.scrollTop) node.scrollTop = 0;
            if (node.scrollLeft) node.scrollLeft = 0;
        }
    }

    function listen() {
        if (listening) return;
        listening = true;
        document.addEventListener('focus', onFocusIn, true);
        document.addEventListener('scroll', onNativeScroll, true);
    }

    function moveFocus(container, direction) {
        var nodes = focusables(container);
        if (!nodes.length) return false;

        var current = document.activeElement;
        if (!current || nodes.indexOf(current) === -1) {
            return focusNode(entryNode(nodes));
        }

        var rows = groupRows(nodes);
        var rowIndex = -1;
        for (var i = 0; i < rows.length; i++) {
            if (rows[i].nodes.indexOf(current) !== -1) { rowIndex = i; break; }
        }
        if (rowIndex < 0) return false;

        var row = rows[rowIndex];

        if (direction === 'left' || direction === 'right') {
            var at = row.nodes.indexOf(current);
            var next = row.nodes[at + (direction === 'left' ? -1 : 1)];
            return next ? focusNode(next) : false;
        }

        var target = rows[rowIndex + (direction === 'up' ? -1 : 1)];
        if (!target) return false;

        var pick = entryOf(target);
        if (!pick && direction === 'down' && isNav(current) && lastContent &&
                target.nodes.indexOf(lastContent) !== -1) {
            pick = lastContent;
        }
        if (!pick && direction === 'down' && isNav(current) && lastContent &&
                nodes.indexOf(lastContent) !== -1) {
            pick = lastContent;
        }
        if (!pick) pick = nearestX(target.nodes, anchorX);
        return focusNode(pick, { keepAnchor: true });
    }

    /* First thing to focus on a screen: the remembered item when coming back,
       an explicit data-autofocus, else the first non-nav focusable. */
    function entryNode(nodes) {
        if (pendingMemo) {
            var found = findMemo(nodes, pendingMemo);
            if (found) return found;
        }
        for (var i = 0; i < nodes.length; i++) {
            if (nodes[i].getAttribute('data-autofocus') !== null) return nodes[i];
        }
        for (var j = 0; j < nodes.length; j++) {
            if (!isNav(nodes[j])) return nodes[j];
        }
        return nodes[0];
    }

    function findMemo(nodes, memo) {
        var i;
        if (memo.key) {
            for (i = 0; i < nodes.length; i++) {
                if (nodes[i].getAttribute('data-key') === memo.key) return nodes[i];
            }
        }
        return null;
    }

    function focusFirst(container) {
        var nodes = focusables(container);
        if (!nodes.length) return false;
        var memo = pendingMemo;
        var node = entryNode(nodes);
        var restored = !!(memo && findMemo(nodes, memo) === node);
        pendingMemo = null;
        return focusNode(node, { instant: restored });
    }

    /* Called by the router just before it leaves a screen. */
    function captureFocus() {
        var node = document.activeElement;
        if (!node || !node.getAttribute || node.getAttribute('data-focusable') === null) {
            node = lastContent && document.body.contains(lastContent) ? lastContent : null;
        }
        if (!node) return null;
        return { key: node.getAttribute('data-key') || '' };
    }

    function setPendingFocus(memo) { pendingMemo = memo || null; }

    /* A screen that loses its focused element (rebuilt list, closed panel) must
       never leave the remote with nothing selected. */
    function rescueFocus(container) {
        var active = document.activeElement;
        if (active && active !== document.body && container.contains(active) &&
                active.getAttribute && active.getAttribute('data-focusable') !== null &&
                isVisible(active)) {
            return false;
        }
        return focusFirst(container);
    }

    /* --------------------------------------------------------------- misc */

    function once(fn) {
        var called = false;
        return function () {
            if (called) return;
            called = true;
            fn.apply(null, arguments);
        };
    }

    function delay(ms) {
        return new Promise(function (resolve) { setTimeout(resolve, ms); });
    }

    function withTimeout(promise, ms, label) {
        return new Promise(function (resolve, reject) {
            var done = false;
            var timer = setTimeout(function () {
                if (done) return;
                done = true;
                reject(new Error((label || 'operation') + ' timed out'));
            }, ms);
            promise.then(function (value) {
                if (done) return;
                done = true;
                clearTimeout(timer);
                resolve(value);
            }, function (err) {
                if (done) return;
                done = true;
                clearTimeout(timer);
                reject(err);
            });
        });
    }

    global.U = {
        $: $,
        $all: $all,
        el: el,
        clear: clear,
        esc: esc,
        pad2: pad2,
        ticksToMs: ticksToMs,
        msToTicks: msToTicks,
        fmtTime: fmtTime,
        fmtRuntime: fmtRuntime,
        clamp: clamp,
        stallLimitMs: stallLimitMs,
        toast: toast,
        emitter: emitter,
        isVisible: isVisible,
        closest: closest,
        finalRect: finalRect,
        setTranslate: setTranslate,
        focusables: focusables,
        ensureVisible: ensureVisible,
        moveFocus: moveFocus,
        focusFirst: focusFirst,
        focusNode: focusNode,
        captureFocus: captureFocus,
        setPendingFocus: setPendingFocus,
        rescueFocus: rescueFocus,
        listen: listen,
        isNav: isNav,
        lazy: { check: lazyCheck, schedule: lazySchedule },
        once: once,
        delay: delay,
        withTimeout: withTimeout
    };
})(window);
