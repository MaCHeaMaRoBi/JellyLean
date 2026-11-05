/* Playback engine.
   Prefers Samsung's native AVPlay (hardware decode, HLS, the only reliable
   path on a 2017 TV). Falls back to a plain <video> element so the app can be
   developed and tested in a desktop browser. */
(function (global) {
    'use strict';

    /* Only $WEBAPIS matters here. Gating on the separate `tizen` global was how
       the TV silently ended up on the HTML5 engine and a black screen. */
    var hasAvplay = !!(global.webapis && global.webapis.avplay);
    var av = hasAvplay ? global.webapis.avplay : null;

    var state = {
        mode: hasAvplay ? 'avplay' : 'html5',
        url: '',
        item: null,
        mediaSource: null,
        playSessionId: '',
        durationMs: 0,
        positionMs: 0,
        paused: true,
        opened: false,
        seekable: true
    };

    var videoEl = null;
    var surfaceEl = null;
    var tickTimer = null;
    var lastSeekTarget = null;
    var stallTimer = null;
    var stallEmitted = false;
    var stallArmedAt = 0;

    var Player = U.emitter({});

    function stage() { return U.$('#stage'); }

    function emitTime() {
        Player.emit('timeupdate', state.positionMs, state.durationMs);
    }

    function startTicker() {
        stopTicker();
        tickTimer = setInterval(function () {
            if (!state.opened) return;
            if (state.mode === 'avplay' && av) {
                try { state.positionMs = av.getCurrentTime() || state.positionMs; } catch (e) { /* state not ready */ }
            } else if (videoEl) {
                state.positionMs = Math.round((videoEl.currentTime || 0) * 1000);
                state.durationMs = Math.round((videoEl.duration || 0) * 1000) || state.durationMs;
            }
            emitTime();
        }, 500);
    }

    function stopTicker() {
        if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
    }

    /* A direct-play stream can open "successfully" and still decode nothing —
       the classic black screen when the container/codec is not really
       supported. If no playback time is reported shortly after opening, say so
       so the caller can fall back to a server transcode. */
    function startWatchdog(limitMs) {
        stopWatchdog();
        stallEmitted = false;
        stallArmedAt = Date.now();
        var limit = limitMs || 12000;
        stallTimer = setInterval(function () {
            if (stallEmitted) return;
            if (Date.now() - stallArmedAt < limit) return;
            if (state.positionMs > 1500) { stopWatchdog(); return; }
            stallEmitted = true;
            Player.emit('stalled', state.mode);
        }, 2000);
    }

    function stopWatchdog() {
        if (stallTimer) { clearInterval(stallTimer); stallTimer = null; }
    }

    function showStage(show) {
        var node = stage();
        if (!node) return;
        if (show) node.classList.remove('hidden');
        else node.classList.add('hidden');

        document.body.classList[show ? 'add' : 'remove']('playing');

        /* Only AVPlay needs a transparent canvas; the HTML5 engine keeps the
           dark page behind its letterboxing. */
        if (state.mode === 'avplay') {
            document.documentElement.classList[show ? 'add' : 'remove']('playing');
        }
    }

    /* ------------------------------------------------------------- AVPlay */

    function avplayOpen(options) {
        surfaceEl = U.$('#avplaySurface');
        if (surfaceEl) surfaceEl.classList.remove('hidden');

        /* AVPlay paints beneath the page. The HTML5 element would be an opaque
           black rectangle on top of it. */
        var fallback = U.$('#html5Video');
        if (fallback) fallback.classList.add('hidden');

        av.open(options.url);
        av.setDisplayRect(0, 0, window.innerWidth, window.innerHeight);

        av.setListener({
            oncurrentplaytime: function (ms) {
                state.positionMs = ms;
            },
            onbufferingstart: function () { Player.emit('buffering', true); },
            onbufferingprogress: function (percent) { Player.emit('buffering-progress', percent); },
            onbufferingcomplete: function () { Player.emit('buffering', false); },
            onstreamcompleted: function () {
                state.paused = true;
                Player.emit('ended');
            },
            onevent: function (eventType) {
                if (eventType === 'PLAYING') {
                    if (state.paused) {
                        state.paused = false;
                        Player.emit('playing');
                    }
                } else if (eventType === 'PAUSED') {
                    if (!state.paused) {
                        state.paused = true;
                        Player.emit('paused');
                    }
                } else if (eventType === 'STOP') {
                    Player.emit('stopped');
                }
            },
            onerror: function (error) {
                Player.emit('error', (error && (error.message || error.name)) || 'AVPlay error');
            },
            onsubtitlechange: function () { /* subtitles are server-rendered/off */ },
            ondrmevent: function () { /* no DRM sources */ }
        });

        av.prepareAsync(function () {
            state.opened = true;
            try { state.durationMs = av.getDuration() || 0; } catch (e) { state.durationMs = 0; }

            if (options.startMs && options.startMs > 0) {
                try { av.seekTo(Math.round(options.startMs)); state.positionMs = options.startMs; } catch (e) { /* ignore */ }
            }

            startTicker();
            Player.emit('ready', state.durationMs);

            if (options.autoplay === false) {
                state.paused = true;
                Player.emit('paused');
            } else {
                try {
                    av.play();
                    /* This set never delivers AVPlay's PLAYING event, so
                       without this the app keeps reporting itself as paused:
                       SyncPlay would tell the group to hold, and the OSD would
                       draw a play glyph over running video. */
                    if (state.paused) {
                        state.paused = false;
                        Player.emit('playing');
                    }
                } catch (e) { Player.emit('error', String(e)); }
            }
        }, function (error) {
            state.opened = false;
            Player.emit('error', (error && (error.message || error.name)) || 'Unable to open stream');
        });
    }

    /* -------------------------------------------------------------- HTML5 */

    function ensureVideoElement() {
        if (videoEl) return videoEl;
        videoEl = U.$('#html5Video');
        if (!videoEl) {
            videoEl = document.createElement('video');
            videoEl.id = 'html5Video';
            videoEl.setAttribute('playsinline', '');
            stage().appendChild(videoEl);
        }
        videoEl.addEventListener('loadedmetadata', function () {
            state.durationMs = Math.round((videoEl.duration || 0) * 1000);
            Player.emit('ready', state.durationMs);
        });
        videoEl.addEventListener('playing', function () { state.paused = false; Player.emit('playing'); });
        videoEl.addEventListener('pause', function () { state.paused = true; Player.emit('paused'); });
        videoEl.addEventListener('waiting', function () { Player.emit('buffering', true); });
        videoEl.addEventListener('canplay', function () { Player.emit('buffering', false); });
        videoEl.addEventListener('seeking', function () { Player.emit('buffering', true); });
        videoEl.addEventListener('seeked', function () {
            state.positionMs = Math.round((videoEl.currentTime || 0) * 1000);
            Player.emit('seeked');
            Player.emit('buffering', false);
        });
        videoEl.addEventListener('ended', function () {
            state.paused = true;
            Player.emit('ended');
        });
        /* Visible only while this engine is the one playing. */
        videoEl.classList.remove('hidden');

        videoEl.addEventListener('error', function () {
            var error = videoEl.error;
            Player.emit('error', error ? ('Media error ' + error.code) : 'Media error');
        });
        return videoEl;
    }

    function html5Open(options) {
        var node = ensureVideoElement();
        node.classList.remove('hidden');
        node.src = options.url;
        state.opened = false;
        state.durationMs = 0;

        node.addEventListener('loadedmetadata', function onMeta() {
            node.removeEventListener('loadedmetadata', onMeta);
            state.opened = true;
            if (options.startMs > 0) {
                try { node.currentTime = options.startMs / 1000; } catch (e) { /* ignore */ }
                state.positionMs = options.startMs;
            }
            startTicker();
            if (options.autoplay === false) {
                state.paused = true;
                Player.emit('paused');
            } else {
                var p = node.play();
                if (p && p.catch) p.catch(function () { /* autoplay policy, user will press OK */ });
            }
        });
        node.load();
    }

    /* ------------------------------------------------------------ public */

    Player.mode = state.mode;
    Player.hasAvplay = hasAvplay;
    Player.engine = function () {
        return state.mode === 'avplay' ? 'AVPlay (hardware)' : 'HTML5 <video>';
    };

    Player.open = function (options) {
        Player.close();
        state.url = options.url;
        state.item = options.item || null;
        state.mediaSource = options.mediaSource || null;
        state.playSessionId = options.playSessionId || '';
        state.positionMs = options.startMs || 0;
        state.durationMs = 0;
        state.paused = true;
        state.opened = false;
        lastSeekTarget = null;

        showStage(true);

        if (state.mode === 'avplay') {
            try {
                avplayOpen(options);
            } catch (e) {
                Player.emit('error', String(e));
            }
        } else {
            html5Open(options);
        }

        /* A transcode warms up before its first segment exists, so the caller
           can ask for more patience than a direct play needs. */
        startWatchdog(options.watchdogMs);
        return Player;
    };

    Player.resume = function () {
        if (state.mode === 'avplay' && av) {
            try { av.play(); } catch (e) { console.warn(e); }
        } else if (videoEl) {
            var p = videoEl.play();
            if (p && p.catch) p.catch(function () {});
        }
        state.paused = false;
    };

    Player.pause = function () {
        if (state.mode === 'avplay' && av) {
            if (state.paused) return;
            try { av.pause(); } catch (e) { console.warn(e); }
        } else if (videoEl) {
            videoEl.pause();
        }
        state.paused = true;
    };

    Player.seekTo = function (ms) {
        var target = Math.max(0, Math.round(ms));
        state.positionMs = target;
        lastSeekTarget = target;
        if (state.mode === 'avplay' && av) {
            try { av.seekTo(target); } catch (e) { console.warn('seekTo', e); }
            Player.emit('seeked');
        } else if (videoEl) {
            try { videoEl.currentTime = target / 1000; } catch (e) { console.warn('seek', e); }
        }
        emitTime();
    };

    Player.setSpeed = function (rate) {
        if (state.mode === 'avplay' && av && typeof av.setSpeed === 'function') {
            try { av.setSpeed(rate); } catch (e) { /* unsupported on this firmware */ }
        } else if (videoEl) {
            try { videoEl.playbackRate = rate; } catch (e) { /* ignore */ }
        }
    };

    Player.getPosition = function () { return state.positionMs; };
    Player.getDuration = function () { return state.durationMs; };
    Player.isPaused = function () { return state.paused; };
    Player.isOpen = function () { return state.opened; };
    Player.getItem = function () { return state.item; };
    Player.getMediaSource = function () { return state.mediaSource; };
    Player.getPlaySessionId = function () { return state.playSessionId; };
    Player.getLastSeekTarget = function () { return lastSeekTarget; };

    Player.close = function () {
        stopTicker();
        stopWatchdog();
        if (state.mode === 'avplay' && av) {
            try { av.stop(); } catch (e) { /* not playing */ }
            try { av.close(); } catch (e) { /* not open */ }
            if (surfaceEl) surfaceEl.classList.add('hidden');
        } else if (videoEl) {
            try { videoEl.pause(); } catch (e) { /* ignore */ }
            videoEl.removeAttribute('src');
            try { videoEl.load(); } catch (e) { /* ignore */ }
            videoEl.classList.add('hidden');
        }
        state.opened = false;
        state.paused = true;
        state.positionMs = 0;
        state.durationMs = 0;
        showStage(false);
    };

    global.Player = Player;
})(window);
