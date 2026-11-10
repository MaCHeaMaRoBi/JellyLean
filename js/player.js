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
    var lastPlaytimeAt = 0;
    var lastSeekTarget = null;
    var stallTimer = null;
    var stallEmitted = false;
    var stallArmedAt = 0;
    var stallBaseMs = 0;

    /* AVPlay reports prepare results and errors asynchronously, and a closed
       session still delivers them. Every callback is tied to the open that
       created it, so a stale one cannot seek, play or error the new stream. */
    var generation = 0;

    var Player = U.emitter({});

    function stage() { return U.$('#stage'); }

    function emitTime() {
        Player.emit('timeupdate', state.positionMs, state.durationMs);
    }

    function startTicker() {
        stopTicker();
        tickTimer = setInterval(function () {
            if (!state.opened) return;
            if (state.mode === 'avplay') {
                /* oncurrentplaytime already carries the position; poll only if
                   that event has gone quiet, so a firmware that stops sending
                   it cannot freeze the clock (and a paused player never needs
                   a poll: the position is not moving). */
                if (av && !state.paused && Date.now() - lastPlaytimeAt > 2000) {
                    try { state.positionMs = av.getCurrentTime() || state.positionMs; } catch (e) { /* state not ready */ }
                }
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
       so the caller can fall back to a server transcode. The wait scales with
       the bitrate (U.stallLimitMs): a slow NAS start is not a dead stream. */
    function streamBitrate() {
        var source = state.mediaSource;
        if (!source) return 0;
        if (source.Bitrate) return source.Bitrate;
        var streams = source.MediaStreams || [];
        for (var i = 0; i < streams.length; i++) {
            if (streams[i].Type === 'Video' && streams[i].BitRate) return streams[i].BitRate;
        }
        return 0;
    }

    function startWatchdog(floorMs) {
        stopWatchdog();
        stallEmitted = false;
        stallArmedAt = Date.now();
        /* Progress is measured against where this open started: a resume at
           0:30 already has positionMs above the threshold before any frame has
           decoded, which used to disable the check for every resumed item. */
        stallBaseMs = state.positionMs;
        var limit = U.stallLimitMs(streamBitrate(), floorMs);
        stallTimer = setInterval(function () {
            if (stallEmitted) return;
            /* A paused player never reports progress; that is not a stall. */
            if (state.paused) { stallArmedAt = Date.now(); return; }
            if (Date.now() - stallArmedAt < limit) return;
            if (state.positionMs > stallBaseMs + 1500) { stopWatchdog(); return; }
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

    function avplayOpen(options, gen) {
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
                if (gen !== generation) return;
                state.positionMs = ms;
                lastPlaytimeAt = Date.now();
            },
            onbufferingstart: function () { if (gen !== generation) return; Player.emit('buffering', true); },
            onbufferingprogress: function (percent) { if (gen !== generation) return; Player.emit('buffering-progress', percent); },
            onbufferingcomplete: function () { if (gen !== generation) return; Player.emit('buffering', false); },
            onstreamcompleted: function () {
                if (gen !== generation) return;
                state.paused = true;
                Player.emit('ended');
            },
            onevent: function (eventType) {
                if (gen !== generation) return;
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
                if (gen !== generation) return;
                Player.emit('error', (error && (error.message || error.name)) || 'AVPlay error');
            },
            onsubtitlechange: function () { /* subtitles are server-rendered/off */ },
            ondrmevent: function () { /* no DRM sources */ }
        });

        av.prepareAsync(function () {
            if (gen !== generation) return;
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
            if (gen !== generation) return;
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

    function html5Open(options, gen) {
        var node = ensureVideoElement();
        node.classList.remove('hidden');
        node.src = options.url;
        state.opened = false;
        state.durationMs = 0;

        node.addEventListener('loadedmetadata', function onMeta() {
            node.removeEventListener('loadedmetadata', onMeta);
            /* Metadata for a replaced item must not seek or play the new one. */
            if (gen !== generation) return;
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
        var gen = ++generation;
        state.url = options.url;
        state.item = options.item || null;
        state.mediaSource = options.mediaSource || null;
        state.playSessionId = options.playSessionId || '';
        state.positionMs = options.startMs || 0;
        state.durationMs = 0;
        state.paused = true;
        state.opened = false;
        lastSeekTarget = null;
        lastPlaytimeAt = 0;

        showStage(true);

        if (state.mode === 'avplay') {
            try {
                avplayOpen(options, gen);
            } catch (e) {
                Player.emit('error', String(e));
            }
        } else {
            html5Open(options, gen);
        }

        /* A transcode warms up before its first segment exists, so the caller
           can ask for more patience than the bitrate budget alone gives. */
        startWatchdog(options.stallFloorMs);
        return Player;
    };

    Player.resume = function () {
        if (state.paused === false) return;
        if (state.mode === 'avplay' && av) {
            try { av.play(); } catch (e) { console.warn(e); }
        } else if (videoEl) {
            var p = videoEl.play();
            if (p && p.catch) p.catch(function () {});
        }
        state.paused = false;
        /* AVPlay's own PLAYING/PAUSED events are swallowed because the flag is
           already set when they arrive, so announce the change here: the OSD
           label and the server's paused state both hang off this event. */
        Player.emit('playing');
    };

    Player.pause = function () {
        if (state.paused) return;
        if (state.mode === 'avplay' && av) {
            try { av.pause(); } catch (e) { console.warn(e); }
        } else if (videoEl) {
            videoEl.pause();
        }
        state.paused = true;
        Player.emit('paused');
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

    /* The audio tracks AVPlay itself found in the stream, in container order,
       as { index, language }. Null when this is not AVPlay or the TV gave no
       track list at all. `trusted` is true only when the list also names a
       video track, i.e. it is a real listing: an empty audio list inside it
       means the TV found no audio it can decode. */
    Player.getAudioTracks = function () {
        if (state.mode !== 'avplay' || !av || typeof av.getTotalTrackInfo !== 'function') return null;

        var info;
        try { info = av.getTotalTrackInfo(); } catch (e) { return null; }
        if (!info || !info.length) return null;

        var tracks = [];
        var sawVideo = false;
        for (var i = 0; i < info.length; i++) {
            var type = String(info[i].type || '').toUpperCase();
            if (type === 'VIDEO') sawVideo = true;
            if (type !== 'AUDIO') continue;

            var language = '';
            try {
                var extra = typeof info[i].extra_info === 'string'
                    ? JSON.parse(info[i].extra_info) : (info[i].extra_info || {});
                language = extra.language || extra.track_lang || '';
            } catch (e) { /* the field is free-form on some firmware */ }
            tracks.push({ index: info[i].index, language: language });
        }
        return { tracks: tracks, trusted: sawVideo };
    };

    /* Switch the audio track of the stream that is open, without restarting
       it. False when this engine cannot, so the caller can restart instead. */
    Player.selectAudioTrack = function (avplayIndex) {
        if (state.mode !== 'avplay' || !av || typeof av.setSelectTrack !== 'function') return false;
        if (avplayIndex === undefined || avplayIndex === null || avplayIndex < 0) return false;
        try {
            av.setSelectTrack('AUDIO', avplayIndex);
            return true;
        } catch (e) {
            console.warn('setSelectTrack failed', e);
            return false;
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
        /* Invalidate every callback the previous open left in flight. */
        generation++;
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
