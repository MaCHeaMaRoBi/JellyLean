/* Application shell: boot, routing, remote keys and the playback pipeline. */
(function (global) {
    'use strict';

    var KEY = {
        BACK: 10009,
        EXIT: 10182,
        ENTER: 13,
        LEFT: 37,
        UP: 38,
        RIGHT: 39,
        DOWN: 40,
        ESCAPE: 27,
        BACKSPACE: 8
    };

    var DIRECTIONS = { 37: 'left', 38: 'up', 39: 'right', 40: 'down' };

    var root = null;
    var stack = [];
    var mounted = null;
    var syncWired = false;
    var pendingItemId = null;

    /* ------------------------------------------------------------- routing */

    function moduleFor(name) {
        return global.Screens && global.Screens[name];
    }

    function mount(frame, restore) {
        var mod = moduleFor(frame.name);
        U.setPendingFocus(restore ? frame.memo : null);

        if (!mod || typeof mod.render !== 'function') {
            console.error('Unknown screen:', frame.name);
            if (frame.name === 'home') return;
            stack = [{ name: 'home', params: {} }];
            mount(stack[0]);
            return;
        }

        if (mounted && mounted.module && typeof mounted.module.destroy === 'function') {
            try {
                mounted.module.destroy();
            } catch (e) {
                console.error('destroy ' + mounted.name, e);
            }
        }

        U.clear(root);

        mounted = { name: frame.name, params: frame.params, module: mod };

        try {
            mod.render(root, frame.params);
        } catch (e) {
            console.error('render ' + frame.name, e);
            U.clear(root);
            root.appendChild(UI.empty('This screen failed to load. Press BACK to go home.'));
        }
    }

    function go(name, params, replace) {
        var frame = { name: name, params: params || {} };

        /* Remember where focus was so BACK lands on the same card. */
        if (stack.length) stack[stack.length - 1].memo = U.captureFocus();

        if (replace && stack.length) {
            stack[stack.length - 1] = frame;
        } else if (stack.length && stack[stack.length - 1].name === name && name === 'player') {
            /* Never stack players on top of each other. */
            stack[stack.length - 1] = frame;
        } else {
            stack.push(frame);
        }

        mount(frame);
    }

    var App = {
        go: function (name, params, options) {
            go(name, params, !!(options && options.replace));
        },

        /* Top-level destinations (tabs) restart the history at Home, so BACK from
           any tab returns Home instead of walking through every tab visited. */
        tab: function (name, params) {
            if (mounted && mounted.name === name && name === 'home') return;
            var frame = { name: name, params: params || {} };
            stack = name === 'home' ? [frame] : [{ name: 'home', params: {} }, frame];
            mount(frame);
        },

        back: function () {
            if (stack.length > 1) {
                stack.pop();
                mount(stack[stack.length - 1], true);
                return;
            }
            if (!stack.length || stack[0].name !== 'home') {
                stack = [{ name: 'home', params: {} }];
                mount(stack[0]);
            }
        },

        exitApp: function () {
            try {
                if (global.tizen && global.tizen.application) {
                    global.tizen.application.getCurrentApplication().exit();
                }
            } catch (e) {
                console.warn('exit failed', e);
            }
        }
    };

    /* --------------------------------------------------------------- keys */

    function isTextInput(node) {
        return !!node && node.tagName === 'INPUT';
    }

    function bindKeys() {
        document.addEventListener('keydown', function (event) {
            /* The player screen owns every key while it is open. */
            if (mounted && mounted.name === 'player') return;

            var code = event.keyCode;
            var active = document.activeElement;

            var isBack = code === KEY.BACK || code === KEY.ESCAPE ||
                (code === KEY.BACKSPACE && !isTextInput(active));

            if (isBack) {
                event.preventDefault();
                if (isTextInput(active)) {
                    /* Leave the field (closes the TV keyboard) and land on
                       whatever sits below it, never on nothing. */
                    active.blur();
                    if (!U.moveFocus(document, 'down')) U.rescueFocus(root);
                    return;
                }
                /* Nothing to go back to before login. */
                if (mounted && mounted.name === 'setup') {
                    App.exitApp();
                    return;
                }
                if (mounted && mounted.name === 'home' && stack.length <= 1) {
                    /* First BACK returns to the top of Home; the second leaves. */
                    var homeTab = U.$('[data-nav="home"]');
                    var onTop = !active || U.isNav(active);
                    if (!onTop && homeTab) { U.focusNode(homeTab); return; }
                    App.exitApp();
                    return;
                }
                App.back();
                return;
            }

            if (code === KEY.EXIT) {
                event.preventDefault();
                App.exitApp();
                return;
            }

            /* Focus must never be lost: if it fell to <body> (a rebuilt list, a
               closed panel) any remote key first puts it back. */
            if ((DIRECTIONS[code] || code === KEY.ENTER) && (!active || active === document.body)) {
                if (U.rescueFocus(root)) { event.preventDefault(); return; }
            }

            if (DIRECTIONS[code]) {
                var dir = DIRECTIONS[code];
                /* Inside a text field, left/right must edit the text. Up/down
                   instead leave the field, otherwise the TV's on-screen
                   keyboard traps focus and the buttons below are unreachable.
                   Keeping the input as the current node lets the spatial
                   search pick the button underneath it. */
                if (isTextInput(active) && (dir === 'left' || dir === 'right')) return;
                if (U.moveFocus(document, dir)) event.preventDefault();
                return;
            }

            if (code === KEY.ENTER) {
                if (!active || isTextInput(active)) return;
                if (active.getAttribute && active.getAttribute('data-focusable') !== null) {
                    event.preventDefault();
                    active.click();
                }
            }
        }, false);
    }

    /* Samsung does not pause AVPlay when the app is hidden, so audio keeps
       playing under the TV menu after HOME or standby. */
    function bindLifecycle() {
        document.addEventListener('visibilitychange', function () {
            var P = global.Player;
            if (document.hidden && P && P.isOpen() && !P.isPaused()) P.pause();
        });
    }

    function registerTvKeys() {
        var tvinput = global.tizen && global.tizen.tvinput;
        if (!tvinput || !tvinput.registerKey) return;

        var keys = [
            ['MediaPlayPause', 10252],
            ['MediaPlay', 415],
            ['MediaPause', 19],
            ['MediaStop', 413],
            ['MediaFastForward', 417],
            ['MediaRewind', 412]
        ];

        for (var i = 0; i < keys.length; i++) {
            try {
                tvinput.registerKey(keys[i][0], keys[i][1]);
            } catch (e) {
                console.warn('registerKey ' + keys[i][0], e);
            }
        }
    }

    /* ------------------------------------------------------------ playback */

    /* Everything the last playback negotiated, kept so Settings can show what
       the TV actually asked the server for. The TV has no logs, so this is the
       only shot at diagnosing "audio but black picture" after the fact. */
    function describePlayback(result) {
        var source = result.source || {};
        var streams = source.MediaStreams || [];
        var video = null;
        var audio = null;

        for (var i = 0; i < streams.length; i++) {
            if (!video && streams[i].Type === 'Video') video = streams[i];
            if (!audio && streams[i].Type === 'Audio') audio = streams[i];
        }

        function codec(stream) {
            if (!stream) return '?';
            var label = stream.Codec || '?';
            if (stream.Width && stream.Height) label += ' ' + stream.Width + '\u00d7' + stream.Height;
            if (stream.Codec === 'h264' && stream.Level) label += ' L' + (stream.Level / 10);
            if (stream.BitDepth && stream.BitDepth > 8) label += ' ' + stream.BitDepth + '-bit';
            return label;
        }

        return {
            method: result.method,
            container: source.Container || '?',
            video: codec(video),
            audio: audio
                ? (audio.Codec || '?') + (audio.Channels ? ' ' + audio.Channels + 'ch' : '')
                : '?',
            bitrate: video && video.BitRate ? Math.round(video.BitRate / 1000) + 'k' : '?',
            at: Date.now()
        };
    }

    /* The source streams describe the file, not what the transcoder emits, so a
       4K HEVC remux would report "hevc 3840x2160" even while the TV receives
       1080p H.264. Ask the master playlist for the real target and attach it to
       the same record, unless another playback has already replaced it. */
    function watchTranscodeOutput(record, url) {
        Api.transcodeOutput(Api.withApiKey(url)).then(function (output) {
            if (!output || !output.resolution || App.lastPlayback !== record) return;
            record.output = output.resolution + ' @ ' + output.bitrate + ' Mbps';
        });
    }

    App.lastPlayback = null;

    App.playItem = function (item, options) {
        if (!item || !item.Id) return Promise.resolve();

        var opts = options || {};
        var startMs;

        if (opts.startMs !== undefined && opts.startMs !== null) {
            startMs = opts.startMs;
        } else if (opts.startTicks !== undefined && opts.startTicks !== null) {
            startMs = U.ticksToMs(opts.startTicks);
        } else {
            startMs = U.ticksToMs((item.UserData && item.UserData.PlaybackPositionTicks) || 0);
        }
        startMs = Math.max(0, Math.round(startMs));

        var startTicks = U.msToTicks(startMs);
        pendingItemId = item.Id;

        /* In a group, publishing the new queue is what makes everybody follow.
           The local player opens right away and the echoed queue event is
           ignored by App.wireSyncPlay because the item already matches. */
        if (SyncPlay.isEnabled() && !opts.fromGroup) {
            SyncPlay.startGroupPlayback(item.Id, startTicks);
        }

        var forceTranscode = opts.forceTranscode !== undefined
            ? !!opts.forceTranscode
            : Store.pref('forceTranscode', false);

        /* A saved image track can only be shown by a transcode with that track
           burned in, so discover the source first, then renegotiate with its
           id and index. Text tracks need no second call. */
        return Api.negotiate(item.Id, {
            startTicks: startTicks,
            forceTranscode: forceTranscode,
            transcodeBitrate: Store.pref('transcodeQuality', 20000000),
            subtitleIndex: opts.subtitleIndex,
            audioIndex: opts.audioIndex,
            mediaSourceId: opts.mediaSourceId
        }).then(function (result) {
            if (!result || !result.source) {
                throw new Error('the server returned no media sources');
            }

            if (opts.subtitleIndex !== undefined && opts.subtitleIndex !== null &&
                    opts.subtitleIndex >= 0) {
                result.subtitleIndex = opts.subtitleIndex;
            }

            var noIndex = opts.subtitleIndex === undefined || opts.subtitleIndex === null ||
                opts.subtitleIndex < 0;
            var image = noIndex && global.Subtitles
                ? Subtitles.imagePreference(item, result.source)
                : null;

            if (!image) return result;

            return Api.negotiate(item.Id, {
                startTicks: startTicks,
                forceTranscode: true,
                transcodeBitrate: Store.pref('transcodeQuality', 20000000),
                subtitleIndex: image.Index,
                audioIndex: opts.audioIndex,
                mediaSourceId: result.source.Id
            }).then(function (burned) {
                if (!burned || !burned.source) return result;
                burned.subtitleIndex = image.Index;
                return burned;
            }).catch(function () {
                /* Keep the picture playing without the track rather than
                   refusing to start the item. The picker can try again. */
                return result;
            });
        }).then(function (result) {
            if (!result || !result.source) {
                throw new Error('the server returned no media sources');
            }

            App.lastPlayback = describePlayback(result);

            if (result.method === 'Transcode' && result.url) {
                watchTranscodeOutput(App.lastPlayback, result.url);
            }

            go('player', {
                item: item,
                source: result.source,
                url: Api.withApiKey(result.url),
                playMethod: result.method,
                playSessionId: result.playSessionId,
                startMs: startMs,
                subtitleIndex: result.subtitleIndex,
                audioIndex: opts.audioIndex,
                retriedTranscode: !!opts.retriedTranscode
            });
            pendingItemId = null;
        }).catch(function (err) {
            pendingItemId = null;
            U.toast('Could not start playback: ' + (err && err.message ? err.message : 'unknown error'));
        });
    };

    App.playItemById = function (itemId, startMs, fromGroup) {
        return Api.item(itemId).then(function (item) {
            return App.playItem(item, { startMs: startMs || 0, fromGroup: !!fromGroup });
        }).catch(function (err) {
            U.toast('Could not load that item: ' + (err && err.message ? err.message : 'error'));
        });
    };

    /* ------------------------------------------------------------- syncplay */

    function wireSyncPlay() {
        if (syncWired) return;
        syncWired = true;

        SyncPlay.on('load', function (payload) {
            if (!payload || !payload.itemId) return;

            var playing = Player.getItem();
            var startMs = U.ticksToMs(payload.startTicks || 0);

            /* The echoed queue for an item this client already asked to play. */
            if (pendingItemId === payload.itemId) return;

            if (playing && playing.Id === payload.itemId && mounted && mounted.name === 'player') {
                if (Math.abs(Player.getPosition() - startMs) > 1500) Player.seekTo(startMs);
                return;
            }

            App.playItemById(payload.itemId, startMs, true);
        });

        SyncPlay.on('stop', function () {
            if (mounted && mounted.name === 'player' &&
                    global.Screens.player && typeof global.Screens.player.stop === 'function') {
                global.Screens.player.stop();
            }
        });

        SyncPlay.on('notice', function (message) {
            if (Store.pref('syncPlayNotices', true)) U.toast(message);
        });

        SyncPlay.on('disabled', function () {
            U.toast('SyncPlay group ended');
        });
    }

    /* ---------------------------------------------------------------- boot */

    function startApp() {
        stack = [{ name: 'home', params: {} }];
        wireSyncPlay();
        SyncPlay.connect();
        mount(stack[0]);
    }

    App.afterLogin = function () {
        startApp();
    };

    App.logout = function () {
        SyncPlay.disconnect();
        UI.resetViews();
        Api.logout();
        Store.clearAuth();
        stack = [];
        go('setup', {}, true);
    };

    App.init = function () {
        root = U.$('#app');
        U.listen();
        if (!root) {
            console.error('#app is missing');
            return;
        }

        bindKeys();
        bindLifecycle();
        registerTvKeys();

        /* A dead token must not leave every screen stuck on HTTP 401. */
        Api.onUnauthorized(function () {
            SyncPlay.disconnect();
            Store.clearAuth();
            stack = [];
            go('setup', {}, true);
            U.toast('Your session expired. Sign in again.');
        });

        if (!Store.isLoggedIn()) {
            go('setup');
            return;
        }

        var auth = Store.auth();
        Api.configure({
            serverUrl: auth.serverUrl,
            token: auth.token,
            userId: auth.userId,
            deviceId: Store.deviceId(),
            deviceName: Store.deviceName()
        });

        /* Validate the stored token once; a server that is merely offline still
           lets the user into the UI, where the retry buttons live. */
        Api.currentUser().then(function () {
            startApp();
        }).catch(function (err) {
            if (err && err.status === 401) {
                Store.clearAuth();
                stack = [];
                go('setup', {}, true);
                return;
            }
            startApp();
        });
    };

    global.App = App;

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', App.init);
    } else {
        App.init();
    }
})(window);
