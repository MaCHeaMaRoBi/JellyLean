/* Playback screen.
   Owns the OSD, the AVPlay/HTML5 session reporting, Skip Intro and the local
   side of SyncPlay. The route controller (App) only hands us a resolved stream;
   everything here talks to Player / SyncPlay / Api directly. */
(function (global) {
    'use strict';

    window.Screens = window.Screens || {};

    var KEY = {
        BACK: 10009,
        EXIT: 10182,
        ENTER: 13,
        LEFT: 37,
        UP: 38,
        RIGHT: 39,
        DOWN: 40,
        PAUSE: 19,
        PLAY: 415,
        PLAY_PAUSE: 10252,
        STOP: 413,
        FF: 417,
        REWIND: 412,
        INFO: 457
    };

    /* How long the OSD stays after the last key. Nothing may pin it: the info
       panel and the pickers close together with it. */
    var FADE_MS = 4000;
    var FADE_INFO_MS = 9000;      /* long enough to read the playback info */
    var FADE_PICKER_MS = 20000;   /* audio/subtitle lists the viewer is browsing */
    var PROGRESS_MS = 10000;
    var SEEK_STEP_MS = 10000;
    var SEEK_LONG_MS = 30000;

    var UPNEXT_SECONDS = 10;

    var session = null;
    var osd = null;
    var stage = null;
    var els = null;
    var upNext = null;

    /* ------------------------------------------------------------- OSD glue */

    function chip(text, className, icon) {
        var node = U.el('span', 'chip' + (className ? ' ' + className : ''));
        if (icon && global.Icons) node.appendChild(global.Icons.el(icon, 20));
        node.appendChild(U.el('span', 'chip-label', text));
        return node;
    }

    function setOsdUp(up) {
        document.body.classList[up ? 'add' : 'remove']('osd-up');
    }

    function osdDelay() {
        if (session.audioOpen || session.subtitleOpen) return FADE_PICKER_MS;
        if (session.infoOpen) return FADE_INFO_MS;
        return FADE_MS;
    }

    function showOsd() {
        if (!session || session.fading) return;
        osd.classList.remove('faded');
        setOsdUp(true);
        if (session.fadeTimer) clearTimeout(session.fadeTimer);
        session.fadeTimer = setTimeout(fadeOsd, osdDelay());
    }

    function fadeOsd() {
        if (!session) return;

        /* The close helpers below call showOsd(); `fading` keeps them from
           bringing the OSD straight back. */
        session.fading = true;
        if (session.infoOpen) {
            session.infoOpen = false;
            if (els.infoPanel) els.infoPanel.classList.add('hidden');
        }
        PlayerAudio.close(false);
        closeSubtitles(false);
        session.fading = false;

        /* Focus must leave the controls with the OSD, otherwise the next
           LEFT/RIGHT would move an invisible highlight instead of seeking. */
        var active = document.activeElement;
        if (active && active !== document.body && osd.contains(active)) active.blur();

        osd.classList.add('faded');
        setOsdUp(false);
    }

    function flash(message) {
        if (!els.center) return;
        els.center.textContent = message || '';
        els.center.classList.add('show');
        if (session && session.flashTimer) clearTimeout(session.flashTimer);
        if (session) {
            session.flashTimer = setTimeout(function () {
                els.center.classList.remove('show');
            }, 1200);
        }
    }

    function setState(text) {
        if (els.state) els.state.textContent = text || '';
        paintPlayButton();
    }

    /* The button shows the action it will perform: a pause glyph while playing,
       a play glyph while paused. */
    function paintPlayButton() {
        if (!els || !els.playGlyph || !session) return;
        var want = Player.isPaused() ? 'play' : 'pause';
        if (session.playGlyph === want) return;

        session.playGlyph = want;
        U.clear(els.playGlyph);
        els.playGlyph.appendChild(global.Icons.el(want, 38));
    }

    function paintBadges() {
        if (!session || !els.badges) return;
        U.clear(els.badges);

        var method = session.playMethod;
        var methodIcon = method === 'Transcode' ? 'transcode'
            : (method === 'DirectStream' ? 'forward' : 'play');

        els.badges.appendChild(chip(method === 'Transcode' ? 'Transcode'
            : (method === 'DirectStream' ? 'Direct stream' : 'Direct play'), '', methodIcon));
        els.badges.appendChild(chip(Player.hasAvplay ? 'AVPlay' : 'HTML5', '',
            Player.hasAvplay ? 'tv' : 'monitor'));

        if (SyncPlay.isEnabled()) {
            var group = SyncPlay.getGroup();
            els.badges.appendChild(chip('SyncPlay' + (group && group.GroupName ? ' \u00b7 ' + group.GroupName : ''), '', 'users'));
        } else if (session.startMs > 5000) {
            els.badges.appendChild(chip('Resuming', '', 'rewind'));
        }
    }

    /* ------------------------------------------------------ osd controls */

    var CONTROLS = [
        { id: 'rewind', icon: 'rewind', label: 'Rewind 10 seconds', run: function () { seekBy(-SEEK_STEP_MS); } },
        { id: 'play', icon: 'play', label: 'Play or pause', run: togglePlay },
        { id: 'forward', icon: 'forward', label: 'Forward 10 seconds', run: function () { seekBy(SEEK_STEP_MS); } },
        { id: 'audio', icon: 'audio', label: 'Audio track', run: PlayerAudio.toggle },
        { id: 'subtitles', icon: 'captions', label: 'Subtitles', run: toggleSubtitles },
        { id: 'info', icon: 'info', label: 'Playback information', run: toggleInfo }
    ];

    function buildControls() {
        U.clear(els.buttons);

        for (var i = 0; i < CONTROLS.length; i++) {
            (function (spec) {
                var btn = U.el('button', 'osd-btn osd-btn-' + spec.id);
                btn.setAttribute('data-focusable', '');
                btn.setAttribute('aria-label', spec.label);
                btn.title = spec.label;
                btn.tabIndex = -1;

                if (spec.id === 'play') {
                    els.playGlyph = U.el('span', 'osd-glyph');
                    els.playGlyph.appendChild(global.Icons.el('play', 38));
                    btn.appendChild(els.playGlyph);
                } else {
                    btn.appendChild(global.Icons.el(spec.icon, 32));
                }
                if (spec.id === 'subtitles') els.subtitleBtn = btn;
                if (spec.id === 'audio') els.audioBtn = btn;

                btn.onclick = function (event) {
                    if (event && event.preventDefault) event.preventDefault();
                    spec.run();
                    btn.blur();
                    showOsd();
                };

                els.buttons.appendChild(btn);
            })(CONTROLS[i]);
        }
    }

    function controlFocusIndex() {
        if (!els || !els.buttons) return -1;
        var active = document.activeElement;
        var children = els.buttons.children;

        for (var i = 0; i < children.length; i++) {
            if (children[i] === active) return i;
        }
        return -1;
    }

    function focusControl(index) {
        if (!els || !els.buttons) return;
        var children = els.buttons.children;
        if (!children.length) return;

        var next = index;
        if (next < 0) next = children.length - 1;
        if (next >= children.length) next = 0;
        children[next].focus();
    }

    /* -------------------------------------------------------- playback info */

    function subtitleLabel(stream) {
        var label = stream.Language
            ? Subtitles.languageName(stream.Language)
            : (stream.DisplayTitle || stream.Codec || 'Track');
        if (stream.Title && stream.Title !== stream.Language &&
                String(stream.Title).toLowerCase() !== String(label).toLowerCase()) {
            label += ' \u00b7 ' + stream.Title;
        }
        return label;
    }

    function infoRow(rows, label, value) {
        if (value === undefined || value === null || value === '') return;

        var row = U.el('div', 'info-row');
        row.appendChild(U.el('span', 'info-label', label));
        row.appendChild(U.el('span', 'info-value', String(value)));
        rows.appendChild(row);
    }

    /* Jellyfin's TranscodeReasons are CamelCase identifiers. */
    function transcodeReason(code) {
        return String(code).replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
    }

    function paintInfo() {
        if (!els || !els.infoPanel || !session) return;

        U.clear(els.infoPanel);

        var item = session.item || {};
        var source = session.source || {};
        var streams = source.MediaStreams || [];
        var video = null;
        var subtitleCount = 0;

        for (var i = 0; i < streams.length; i++) {
            if (!video && streams[i].Type === 'Video') video = streams[i];
            if (streams[i].Type === 'Subtitle') subtitleCount++;
        }

        var audio = session.audioStream || AudioPrefs.pick(source);

        var title = item.Name || 'Playback';
        if (item.Type === 'Episode' && item.SeriesName) {
            title = item.SeriesName + ' \u2014 ' + title;
        }
        els.infoPanel.appendChild(U.el('div', 'info-title', title));

        var rows = U.el('div', 'info-rows');

        infoRow(rows, 'Playback', session.playMethod === 'Transcode' ? 'Transcode (server)'
            : (session.playMethod === 'DirectStream' ? 'Direct stream' : 'Direct play'));
        infoRow(rows, 'Engine', Player.engine());
        infoRow(rows, 'Container', source.Container || '?');

        if (video) {
            var videoLabel = (video.Codec || '?') + '  ' + (video.Width || '?') + '\u00d7' + (video.Height || '?');
            if (video.BitRate) videoLabel += '  \u00b7  ' + Math.round(video.BitRate / 1000) + ' kbps';
            infoRow(rows, 'Source video', videoLabel);
        }

        if (session.playMethod === 'Transcode') {
            infoRow(rows, 'Output', session.outputLabel || 'negotiating\u2026');
            var capMbps = Store.pref('maxBitrate', 0);
            infoRow(rows, 'Bitrate cap', (capMbps > 0 ? capMbps + ' Mbps' : 'None') + ' (1920\u00d71080 max)');
        }

        if (audio) {
            var audioLabel = audio.Codec || '?';
            if (audio.Channels) audioLabel += '  \u00b7  ' + audio.Channels + ' ch';
            if (audio.Language) audioLabel += '  \u00b7  ' + String(audio.Language).toUpperCase();
            infoRow(rows, 'Audio', audioLabel);
        }

        if (session.playMethod === 'Transcode') {
            /* What the server decided and why, from its own transcoding URL. */
            var plan = Api.transcodeInfo(source.TranscodingUrl);
            if (plan && plan.audioCodec) {
                var outLabel = plan.audioCodec.toUpperCase();
                if (plan.audioChannels) outLabel += '  \u00b7  up to ' + plan.audioChannels + ' ch';
                infoRow(rows, 'Audio output', outLabel);
            }
            if (plan && plan.reasons.length) {
                infoRow(rows, 'Transcoding because', plan.reasons.map(transcodeReason).join(', '));
            }
        }

        var subtitleValue;
        if (session.subtitleStream) {
            subtitleValue = subtitleLabel(session.subtitleStream);
            if (Subtitles.isImageCodec(session.subtitleStream.Codec) &&
                    session.burnedSubtitleIndex === session.subtitleStream.Index) {
                subtitleValue += '  \u00b7  Burned in';
            }
        } else {
            subtitleValue = subtitleCount ? 'Off  (' + subtitleCount + ' available)' : 'None';
        }
        infoRow(rows, 'Subtitles', subtitleValue);

        els.infoPanel.appendChild(rows);
        els.infoPanel.appendChild(U.el('div', 'info-hint', 'BACK closes this panel'));
    }

    /* The playlist states the negotiated output; the media streams only
       describe the file. Fetch it once per session, then reuse it. */
    function loadOutput() {
        if (!session || session.playMethod !== 'Transcode' || session.outputLabel) return;

        var last = App.lastPlayback;
        if (last && last.output) {
            session.outputLabel = last.output;
            return;
        }

        var current = session;
        Api.transcodeOutput(Api.withApiKey(current.url)).then(function (output) {
            if (!output || !output.resolution || session !== current) return;
            current.outputLabel = output.resolution + ' @ ' + output.bitrate + ' Mbps';
            if (current.infoOpen) paintInfo();
        });
    }

    function toggleInfo() {
        if (!session || !els.infoPanel) return;

        if (!session.infoOpen && session.audioOpen) PlayerAudio.close(false);
        if (!session.infoOpen && session.subtitleOpen) closeSubtitles(false);

        session.infoOpen = !session.infoOpen;
        els.infoPanel.classList[session.infoOpen ? 'remove' : 'add']('hidden');

        if (session.infoOpen) {
            loadOutput();
            paintInfo();
        }
        showOsd();
    }

    function closeInfo() {
        if (!session || !session.infoOpen) return false;
        toggleInfo();
        return true;
    }

    function paintTitle(item) {
        if (!els.title) return;
        var title = item.Name || 'Untitled';

        if (item.Type === 'Episode' && item.SeriesName) {
            var prefix = '';
            if (item.ParentIndexNumber !== undefined && item.ParentIndexNumber !== null) {
                prefix = 'S' + item.ParentIndexNumber + 'E' + (item.IndexNumber || 0) + '  \u00b7  ';
            }
            title = item.SeriesName + '  \u2014  ' + prefix + title;
        }
        els.title.textContent = title;
    }

    function paintProgress(positionMs, durationMs) {
        if (!els) return;
        var percent = durationMs > 0 ? (positionMs / durationMs) * 100 : 0;
        percent = U.clamp(percent, 0, 100);
        els.fill.style.width = percent + '%';
        els.head.style.left = percent + '%';
        els.current.textContent = U.fmtTime(positionMs);
        els.total.textContent = U.fmtTime(durationMs);
        if (els.track) {
            els.track.setAttribute('aria-valuenow', String(Math.round(percent)));
            els.track.setAttribute('aria-valuetext',
                U.fmtTime(positionMs) + ' of ' + U.fmtTime(durationMs));
        }
    }

    /* ----------------------------------------------------------- skip intro */

    function hideSkip() {
        if (!els) return;
        els.skipBar.classList.add('hidden');
        if (session) {
            session.segment = null;
            session.skipVisible = false;
        }
        if (document.activeElement === els.skipBtn) els.skipBtn.blur();
    }

    function performSkip(segment) {
        if (!segment) return;
        var targetTicks = SkipIntro.skip(segment);
        session.skipCooldownUntil = Date.now() + 2500;
        hideSkip();
        if (SyncPlay.isEnabled()) SyncPlay.seekTo(targetTicks);
        else Player.seekTo(U.ticksToMs(targetTicks));
        flash(SkipIntro.label(segment).replace('Skip ', 'Skipped '));
        showOsd();
    }

    function updateSkip(positionMs) {
        if (!session) return;
        if (session.skipCooldownUntil && Date.now() < session.skipCooldownUntil) return;

        var active = SkipIntro.activeAt(U.msToTicks(positionMs));

        if (!active) {
            if (session.skipVisible) hideSkip();
            return;
        }

        if (Store.pref('autoSkipIntro', false) && !SyncPlay.isEnabled() &&
                SkipIntro.shouldAutoSkip(active)) {
            performSkip(active);
            return;
        }

        var label = SkipIntro.label(active);
        if (els.skipLabel && els.skipLabel.textContent !== label) els.skipLabel.textContent = label;

        session.segment = active;
        if (!session.skipVisible) {
            session.skipVisible = true;
            els.skipBar.classList.remove('hidden');
            showOsd();
        }
    }

    /* ------------------------------------------------------------ reporting */

    function playbackBody() {
        return {
            ItemId: session.item.Id,
            MediaSourceId: session.source ? session.source.Id : undefined,
            PlaySessionId: session.playSessionId || undefined,
            PositionTicks: U.msToTicks(Player.getPosition()),
            CanSeek: true,
            IsPaused: Player.isPaused(),
            IsMuted: false,
            PlayMethod: session.playMethod
        };
    }

    function reportStart() {
        if (!session || session.reportedStart) return;
        session.reportedStart = true;
        Api.reportStart(playbackBody());
        SyncPlay.setPlaybackActive(true);
        SyncPlay.onPlaybackStarted();
    }

    function reportProgress() {
        if (!session || !session.reportedStart) return;
        Api.reportProgress(playbackBody());
    }

    function reportStopped() {
        if (!session) return;
        if (session.reportedStart) {
            Api.reportStopped(playbackBody());
            session.reportedStart = false;
        }
        SyncPlay.onPlaybackStopped();
    }

    /* ----------------------------------------------------------- transitions */

    function finish(userInitiated) {
        if (!session || session.stopping) return;
        session.stopping = true;

        var item = session.item;
        reportStopped();
        teardown();

        if (userInitiated) {
            App.back();
            return;
        }

        U.toast('Finished ' + (item && item.Name ? item.Name : 'playback'));
        App.back();
    }

    function onEnded() {
        if (!session || session.stopping) return;
        session.stopping = true;

        var item = session.item;
        reportStopped();
        teardown();

        /* Wait for the played flag before asking for Next Up, otherwise the
           server can still hand back the episode that just finished. */
        var marked = item && item.Id ? Api.markPlayed(item.Id) : Promise.resolve();
        marked.then(function () { afterPlayback(item); },
            function () { afterPlayback(item); });
    }

    function finishedLabel(item) {
        return 'Finished ' + (item && item.Name ? item.Name : 'playback');
    }

    function afterPlayback(item) {
        if (!item || item.Type !== 'Episode' || !item.SeriesId ||
                SyncPlay.isEnabled() || !Store.pref('autoAdvance', true)) {
            U.toast(finishedLabel(item));
            App.back();
            return;
        }

        Api.nextUp(item.SeriesId).then(function (next) {
            if (!next || next.Id === item.Id) {
                U.toast(finishedLabel(item));
                App.back();
                return;
            }
            showUpNext(next);
        }).catch(function () {
            U.toast(finishedLabel(item));
            App.back();
        });
    }

    /* ------------------------------------------------------------ up next */

    function hideUpNext() {
        if (!upNext) return;

        if (upNext.timer) clearInterval(upNext.timer);
        if (upNext.onKey) document.removeEventListener('keydown', onKeyDownCapture, true);
        if (upNext.node && upNext.node.parentNode) upNext.node.parentNode.removeChild(upNext.node);

        /* The overlay, not the card, owns the full-screen scrim. Leaving it
           visible dims (and covers) every screen after autoplay. */
        var overlay = U.$('#upNextOverlay');
        if (overlay) {
            overlay.classList.add('hidden');
            U.clear(overlay);
        }
        upNext = null;
    }

    function onKeyDownCapture(event) {
        if (!upNext) return;

        var code = event.keyCode;

        if (code === KEY.BACK) {
            event.preventDefault();
            event.stopPropagation();
            dismissUpNext();
            return;
        }
        if (code === KEY.EXIT) {
            event.preventDefault();
            event.stopPropagation();
            dismissUpNext();
            App.exitApp();
            return;
        }
        /* The app-level handler ignores keys while the player is mounted, so
           OK has to be delivered here or the Up Next buttons are dead. */
        if (code === KEY.ENTER) {
            event.preventDefault();
            event.stopPropagation();
            var node = document.activeElement;
            if (node && typeof node.click === 'function') node.click();
            return;
        }
        if (code === KEY.LEFT || code === KEY.RIGHT || code === KEY.UP || code === KEY.DOWN) {
            event.preventDefault();
            event.stopPropagation();
            var direction = code === KEY.LEFT ? 'left' : (code === KEY.RIGHT ? 'right'
                : (code === KEY.UP ? 'up' : 'down'));
            U.moveFocus(upNext.node, direction);
        }
    }

    function dismissUpNext() {
        hideUpNext();
        App.back();
    }

    function playUpNext() {
        if (!upNext) return;
        var next = upNext.item;
        hideUpNext();
        App.playItem(next, { startTicks: 0 });
    }

    function showUpNext(next) {
        var node = U.$('#upNextOverlay');
        if (!node) {
            App.back();
            return;
        }

        hideUpNext();
        U.clear(node);
        node.classList.remove('hidden');

        var box = U.el('div', 'upnext-box');

        var art = U.el('div', 'upnext-art');
        var image = next.ImageTags && next.ImageTags.Primary
            ? Api.imageUrl(next, 'Primary', 480)
            : (next.ImageTags && next.ImageTags.Thumb ? Api.imageUrl(next, 'Thumb', 480) : '');
        if (image) art.style.backgroundImage = 'url("' + image + '")';
        box.appendChild(art);

        var body = U.el('div', 'upnext-body');
        body.appendChild(U.el('div', 'upnext-kicker', 'Up Next'));

        var tag = '';
        if (next.ParentIndexNumber !== undefined && next.ParentIndexNumber !== null) {
            tag = 'S' + next.ParentIndexNumber;
            if (next.IndexNumber !== undefined && next.IndexNumber !== null) tag += 'E' + next.IndexNumber;
            tag += '  ';
        }
        body.appendChild(U.el('div', 'upnext-title', tag + (next.Name || 'Next episode')));

        var sub = [];
        if (next.SeriesName) sub.push(next.SeriesName);
        if (next.RunTimeTicks) sub.push(U.fmtRuntime(next.RunTimeTicks));
        body.appendChild(U.el('div', 'upnext-sub', sub.join('  \u00b7  ')));

        var countdown = U.el('div', 'upnext-count', 'Playing in ' + UPNEXT_SECONDS + ' seconds');
        body.appendChild(countdown);

        var actions = U.el('div', 'btn-row');
        var playBtn = UI.iconize(U.el('button', 'btn primary'), 'play', 'Play Now');
        playBtn.setAttribute('data-focusable', '');
        playBtn.tabIndex = -1;
        playBtn.onclick = playUpNext;
        actions.appendChild(playBtn);

        var notNow = UI.iconize(U.el('button', 'btn ghost'), 'back', 'Not Now');
        notNow.setAttribute('data-focusable', '');
        notNow.tabIndex = -1;
        notNow.onclick = dismissUpNext;
        actions.appendChild(notNow);

        body.appendChild(actions);
        box.appendChild(body);
        node.appendChild(box);

        upNext = {
            item: next,
            node: box,
            timer: null,
            onKey: onKeyDownCapture,
            remaining: UPNEXT_SECONDS
        };

        document.addEventListener('keydown', onKeyDownCapture, true);
        U.focusFirst(box);

        upNext.timer = setInterval(function () {
            if (!upNext) return;
            upNext.remaining -= 1;
            if (upNext.remaining <= 0) {
                playUpNext();
                return;
            }
            countdown.textContent = 'Playing in ' + upNext.remaining + ' seconds';
        }, 1000);
    }

    function failPlayback(message) {
        if (!session) return;
        U.toast('Playback error: ' + (message || 'unknown'));
        session.stopping = true;
        reportStopped();
        teardown();
        App.back();
    }

    /* Direct play is a negotiation, not a promise: the server can say
       "SupportsDirectPlay" for a stream this TV then refuses to decode. Rather
       than showing a black screen, reopen the same position through the
       server's HLS transcoder once. */
    function retryWithTranscode(reason, message) {
        if (!session || session.stopping) return;
        if (session.playMethod === 'Transcode' || session.retriedTranscode) {
            failPlayback(reason);
            return;
        }

        var item = session.item;
        var resume = Player.getPosition() || session.startMs || 0;

        session.stopping = true;
        teardown();
        U.toast(message || 'Direct play failed, switching to server transcoding\u2026');
        App.playItem(item, {
            startMs: resume,
            forceTranscode: true,
            retriedTranscode: true
        }).catch(function () { /* App.playItem already reports it */ });
    }

    function onError(message) {
        if (!session || session.stopping) return;
        if (session.retriedTranscode || session.playMethod === 'Transcode') {
            failPlayback(message || 'unknown');
            return;
        }
        retryWithTranscode('playback error: ' + (message || 'unknown'));
    }

    function onStalled() {
        if (!session || session.stopping) return;
        retryWithTranscode('no video decoded from direct play');
    }

    /* --------------------------------------------------------- subtitles */

    function clearSubtitleText() {
        if (session) {
            session.subtitles = null;
            session.subtitleText = '';
        }
        if (!els || !els.subtitleLayer) return;
        els.subtitleLayer.textContent = '';
        els.subtitleLayer.classList.add('hidden');
    }

    function paintSubtitleButton() {
        if (!session || !els || !els.subtitleBtn) return;

        var stream = session.subtitleStream;
        var on = !!stream;
        els.subtitleBtn.classList[on ? 'add' : 'remove']('on');

        var label = on ? 'Subtitles: ' + subtitleLabel(stream) : 'Subtitles: off';
        els.subtitleBtn.setAttribute('aria-label', label);
        els.subtitleBtn.title = label;
    }

    function paintSubtitles(positionMs) {
        if (!session || !els || !els.subtitleLayer) return;

        var text = session.subtitles ? session.subtitles.textAt(positionMs) : '';
        if (text === session.subtitleText) return;

        session.subtitleText = text;
        els.subtitleLayer.textContent = text;
        els.subtitleLayer.classList[text ? 'remove' : 'add']('hidden');
    }

    function loadTextSubtitle(current, stream) {
        var token = ++current.subtitleToken;

        current.subtitleStream = stream;
        clearSubtitleText();
        paintSubtitleButton();
        if (current.infoOpen) paintInfo();

        if (!stream) return;

        var url = Api.subtitleUrl(current.item.Id, current.source.Id, stream.Index);
        Subtitles.load(url).then(function (tracker) {
            if (session !== current || current.subtitleToken !== token) return;
            current.subtitles = tracker;
            current.subtitleText = '';
            paintSubtitles(Player.getPosition());
        }).catch(function (error) {
            if (session !== current || current.subtitleToken !== token) return;
            console.warn('subtitle track unavailable: ' +
                (error && error.message ? error.message : error));
            current.subtitles = null;
            current.subtitleStream = null;
            paintSubtitleButton();
            if (current.infoOpen) paintInfo();
            U.toast('That subtitle track could not be loaded');
        });
    }

    /* Apply the saved choice, or Jellyfin's default track on a first watch. */
    function attachSubtitles(current) {
        if (!current) return;

        var pref = Subtitles.preferred(current.item, current.source);
        var stream = pref.stream;

        if (stream && Subtitles.isImageCodec(stream.Codec)) {
            /* Image tracks only exist inside the picture. App has already
               negotiated the burn-in when the same source is on screen. */
            if (current.burnedSubtitleIndex === stream.Index) {
                current.subtitleStream = stream;
                clearSubtitleText();
                paintSubtitleButton();
                return;
            }

            /* The saved track could not be burned in (another source, a failed
               negotiation). Leave the picture clean; the picker can retry. */
            current.subtitleStream = null;
            clearSubtitleText();
            paintSubtitleButton();
            if (pref.saved) console.warn('subtitle burn-in unavailable for ' + stream.Codec);
            return;
        }

        loadTextSubtitle(current, stream || null);
    }

    /* ------------------------------------------------------ subtitle picker */

    function subtitleStreams() {
        var streams = (session && session.source && session.source.MediaStreams) || [];
        var list = [];
        for (var i = 0; i < streams.length; i++) {
            if (streams[i].Type === 'Subtitle') list.push(streams[i]);
        }
        return list;
    }

    function subtitleMeta(stream) {
        var bits = [];
        if (stream.Title) bits.push(String(stream.Title));
        if (stream.IsDefault) bits.push('Default');
        if (stream.IsForced) bits.push('Forced');
        if (Subtitles.isImageCodec(stream.Codec)) bits.push('Image');
        if (stream.Codec) bits.push(String(stream.Codec).toUpperCase());
        return bits.join('  \u00b7  ');
    }

    function subtitleTrackName(stream) {
        if (stream.Language) return Subtitles.languageName(stream.Language);
        return stream.DisplayTitle || stream.Codec || ('Track ' + (stream.Index + 1));
    }

    function addSubtitleRow(stream, active) {
        var name = stream ? subtitleTrackName(stream) : 'Off';
        var meta = stream ? subtitleMeta(stream) : 'Hide subtitles';

        var row = U.el('div', 'sub-row');
        row.setAttribute('data-focusable', '');
        row.setAttribute('role', 'option');
        row.setAttribute('aria-selected', active ? 'true' : 'false');
        row.tabIndex = -1;

        var check = U.el('span', 'sub-check');
        if (active) check.appendChild(global.Icons.el('check', 26));
        row.appendChild(check);

        var main = U.el('span', 'sub-main');
        main.appendChild(U.el('span', 'sub-name', name));
        main.appendChild(U.el('span', 'sub-meta', meta));
        row.appendChild(main);

        if (active) row.classList.add('selected');
        row.setAttribute('aria-label', stream
            ? name + ' subtitles, ' + meta.replace(/\s+\u00b7\s+/g, ', ')
            : 'Off, hide subtitles');

        row.onclick = function (event) {
            if (event && event.preventDefault) event.preventDefault();
            chooseSubtitle(stream);
        };

        els.subtitleList.appendChild(row);
        return row;
    }

    function buildSubtitleList() {
        if (!session || !els.subtitleList) return;

        U.clear(els.subtitleList);
        session.subtitleRows = [];

        var active = session.subtitleStream ? session.subtitleStream.Index : -1;
        session.subtitleRows.push(addSubtitleRow(null, active < 0));

        var streams = subtitleStreams();
        for (var i = 0; i < streams.length; i++) {
            session.subtitleRows.push(addSubtitleRow(streams[i],
                active >= 0 && streams[i].Index === active));
        }
    }

    function subtitleFocusIndex() {
        if (!session || !session.subtitleRows) return -1;
        var active = document.activeElement;
        for (var i = 0; i < session.subtitleRows.length; i++) {
            if (session.subtitleRows[i] === active) return i;
        }
        return -1;
    }

    function ensureSubtitleVisible(row) {
        if (!els || !els.subtitleList || !row) return;

        var listBox = els.subtitleList.getBoundingClientRect();
        var rowBox = row.getBoundingClientRect();

        if (rowBox.top < listBox.top) {
            els.subtitleList.scrollTop -= (listBox.top - rowBox.top) + 8;
        } else if (rowBox.bottom > listBox.bottom) {
            els.subtitleList.scrollTop += (rowBox.bottom - listBox.bottom) + 8;
        }
    }

    function focusSubtitleRow(index) {
        if (!session || !session.subtitleRows || !session.subtitleRows.length) return;
        var next = U.clamp(index, 0, session.subtitleRows.length - 1);
        session.subtitleRows[next].focus();
        ensureSubtitleVisible(session.subtitleRows[next]);
    }

    function moveSubtitleFocus(delta) {
        var index = subtitleFocusIndex();
        if (index < 0) index = 0;
        focusSubtitleRow(index + delta);
    }

    function openSubtitles() {
        if (!session || !els.subtitlePanel) return;

        if (session.infoOpen) toggleInfo();

        session.subtitleOpen = true;
        els.subtitlePanel.classList.remove('hidden');
        buildSubtitleList();
        showOsd();

        var active = -1;
        for (var i = 0; i < session.subtitleRows.length; i++) {
            if (session.subtitleRows[i].classList.contains('selected')) { active = i; break; }
        }
        focusSubtitleRow(active < 0 ? 0 : active);
    }

    function closeSubtitles(restoreFocus) {
        if (!session || !session.subtitleOpen) return false;

        session.subtitleOpen = false;
        if (els && els.subtitlePanel) els.subtitlePanel.classList.add('hidden');

        if (restoreFocus !== false && els && els.subtitleBtn) els.subtitleBtn.focus();
        showOsd();
        return true;
    }

    function toggleSubtitles() {
        if (!session) return;
        if (session.subtitleOpen) closeSubtitles(true);
        else openSubtitles();
    }

    function restartWithSubtitle(stream) {
        if (!session) return;

        var current = session;
        var item = current.item;
        var position = Player.getPosition();
        var sourceId = current.source ? current.source.Id : '';
        var image = stream && Subtitles.isImageCodec(stream.Codec);

        current.stopping = true;
        teardown();

        U.toast(image ? 'Burning in ' + subtitleLabel(stream) + ' subtitles\u2026'
            : (stream ? 'Switching subtitles\u2026' : 'Turning subtitles off\u2026'));

        App.playItem(item, {
            startMs: position,
            forceTranscode: true,
            subtitleIndex: image ? stream.Index : undefined,
            audioIndex: current.audioStream ? current.audioStream.Index : undefined,
            mediaSourceId: sourceId,
            fromGroup: SyncPlay.isEnabled()
        }).catch(function () { /* App.playItem already reports it */ });
    }

    function chooseSubtitle(stream) {
        if (!session) return;

        var current = session;
        var image = stream && Subtitles.isImageCodec(stream.Codec);
        var burned = current.burnedSubtitleIndex >= 0;

        Subtitles.saveChoice(current.item, stream);

        if (image) {
            closeSubtitles(false);
            if (burned && current.subtitleStream &&
                    current.subtitleStream.Index === stream.Index) {
                showOsd();
                return;
            }
            restartWithSubtitle(stream);
            return;
        }

        /* A burned-in track has to be removed by re-opening the transcode
           without a subtitle, even when the new choice is Off. */
        if (burned) {
            closeSubtitles(false);
            restartWithSubtitle(stream || null);
            return;
        }

        closeSubtitles(true);
        loadTextSubtitle(current, stream || null);
        U.toast(stream ? 'Subtitles: ' + subtitleLabel(stream) : 'Subtitles off');
    }

    /* --------------------------------------------------------- audio picker */

    /* The list itself lives in js/screens/player-audio.js and the helpers in
       js/audio.js. What stays here is what needs the session: switching the
       track, either in place on AVPlay or by asking the server for a stream. */

    function surroundOn() {
        return Store.pref('audioOutput', 'surround') !== 'stereo';
    }

    /* Switch to `stream` on the stream that is already open. Possible only on
       a direct play, where AVPlay itself decodes the file: the track must be
       one the TV can decode, and AVPlay's own track list must line up with the
       file's (AudioPrefs.avplayIndex). Anything else returns false and the
       caller restarts through the server. */
    function switchAudioInPlace(stream) {
        if (!session || session.playMethod !== 'DirectPlay' || !Player.hasAvplay) return false;
        if (!AudioPrefs.directPlayable(stream, surroundOn())) return false;

        var info = Player.getAudioTracks();
        if (!info || !info.tracks.length) return false;

        var target = AudioPrefs.avplayIndex(session.source, stream, info.tracks);
        if (target < 0 || !Player.selectAudioTrack(target)) return false;

        session.audioStream = stream;
        if (session.infoOpen) paintInfo();
        return true;
    }

    function restartWithAudio(stream) {
        if (!session) return;

        var current = session;
        var item = current.item;
        var position = Player.getPosition();
        var sourceId = current.source ? current.source.Id : '';
        var burned = current.burnedSubtitleIndex >= 0 ? current.burnedSubtitleIndex : undefined;

        current.stopping = true;
        teardown();

        U.toast('Switching audio to ' + PlayerAudio.trackName(stream) + '\u2026');

        App.playItem(item, {
            startMs: position,
            forceTranscode: true,
            audioIndex: stream.Index,
            subtitleIndex: burned,
            mediaSourceId: sourceId,
            fromGroup: SyncPlay.isEnabled()
        }).catch(function () { /* App.playItem already reports it */ });
    }

    function chooseAudio(stream) {
        if (!session || !stream) return;

        if (session.audioStream && session.audioStream.Index === stream.Index) {
            PlayerAudio.close(true);
            return;
        }

        /* Remember the language for this movie or series, whichever way the
           switch happens, so the next episode starts in it. */
        AudioPrefs.saveChoice(session.item, stream);

        if (switchAudioInPlace(stream)) {
            PlayerAudio.close(true);
            U.toast('Audio: ' + PlayerAudio.trackName(stream));
            return;
        }

        PlayerAudio.close(false);
        restartWithAudio(stream);
    }

    /* App picked a remembered or preferred language that the TV can switch to
       by itself, so it left the stream on the container's default and asked us
       to select the track once AVPlay is ready. If AVPlay's track list does not
       line up, fall back to the same restart the picker uses. */
    function applyPreferredAudio() {
        if (!session || !session.audioInPlace) return;
        session.audioInPlace = false;

        var stream = session.audioStream;
        if (!stream || switchAudioInPlace(stream)) return;
        restartWithAudio(stream);
    }

    /* AVPlay drops an audio track it cannot decode without any error, which
       is how a file direct-plays with picture and no sound. The track list it
       reports is the only evidence, so when the file has audio and AVPlay lists
       none, reopen through the server's transcoder. Skipped whenever the list
       is missing or not a real listing, so a quirk cannot cause a restart. */
    function checkAudioDecoded() {
        if (!session || session.stopping || session.playMethod !== 'DirectPlay') return;
        if (session.retriedTranscode || !Player.hasAvplay) return;
        if (!AudioPrefs.streams(session.source).length) return;

        var info = Player.getAudioTracks();
        if (!info || !info.trusted || info.tracks.length) return;

        retryWithTranscode('the TV found no audio it can decode', 'No sound from direct play, switching to server transcoding\u2026');
    }

    /* ------------------------------------------------------------- remote */

    function seekBy(deltaMs) {
        if (!session) return;
        var duration = Player.getDuration() || session.durationMs || 0;
        var target = Player.getPosition() + deltaMs;
        if (duration > 0) target = U.clamp(target, 0, duration - 1000);
        else target = Math.max(0, target);

        if (SyncPlay.isEnabled()) {
            SyncPlay.seekTo(U.msToTicks(target));
            flash(deltaMs > 0 ? 'Seeking forward' : 'Seeking back');
        } else {
            Player.seekTo(target);
            flash(deltaMs > 0 ? '+10 seconds' : '-10 seconds');
        }
    }

    function togglePlay() {
        if (SyncPlay.isEnabled()) {
            SyncPlay.playPause();
            flash(Player.isPaused() ? 'Playing' : 'Paused');
            return;
        }
        if (Player.isPaused()) {
            Player.resume();
            flash('Playing');
        } else {
            Player.pause();
            flash('Paused');
        }
    }

    function onKeyDown(event) {
        if (!session) return;

        var code = event.keyCode;
        var onSkip = document.activeElement === els.skipBtn;
        var controlIndex = controlFocusIndex();
        var onControl = controlIndex >= 0;

        if (code === KEY.BACK) {
            event.preventDefault();
            event.stopPropagation();
            /* BACK closes the pickers, then the info panel, then playback. */
            if (!PlayerAudio.close(true) && !closeSubtitles(true) && !closeInfo()) finish(true);
            return;
        }

        if (code === KEY.EXIT) {
            event.preventDefault();
            event.stopPropagation();
            finish(true);
            App.exitApp();
            return;
        }

        var handled = code === KEY.ENTER || code === KEY.LEFT || code === KEY.RIGHT ||
            code === KEY.UP || code === KEY.DOWN || code === KEY.PLAY ||
            code === KEY.PLAY_PAUSE || code === KEY.PAUSE || code === KEY.STOP ||
            code === KEY.FF || code === KEY.REWIND || code === KEY.INFO;

        if (handled) event.preventDefault();

        /* While either picker is open it owns UP/DOWN/OK; everything else
           would move playback out from under the list. */
        if (session.audioOpen) {
            if (code === KEY.UP) PlayerAudio.moveFocus(-1);
            else if (code === KEY.DOWN) PlayerAudio.moveFocus(1);
            else if (code === KEY.ENTER) PlayerAudio.activate();
            showOsd();
            return;
        }

        if (session.subtitleOpen) {
            if (code === KEY.UP) moveSubtitleFocus(-1);
            else if (code === KEY.DOWN) moveSubtitleFocus(1);
            else if (code === KEY.ENTER) {
                var subtitleRow = session.subtitleRows[subtitleFocusIndex()];
                if (subtitleRow) subtitleRow.click();
            }
            showOsd();
            return;
        }

        /* Samsung remotes expose INFO directly; the on-screen button is for
           remotes that do not. */
        if (code === KEY.INFO) {
            toggleInfo();
            return;
        }

        showOsd();

        switch (code) {
            case KEY.UP:
                if (!els.skipBar.classList.contains('hidden')) els.skipBtn.focus();
                else if (!onControl) focusControl(1);
                break;

            case KEY.DOWN:
                if (onSkip) focusControl(1);
                else if (onControl) document.activeElement.blur();
                break;

            case KEY.LEFT:
                if (onControl) { focusControl(controlIndex - 1); break; }
                if (onSkip) { els.skipBtn.blur(); break; }
                seekBy(-SEEK_STEP_MS);
                break;

            case KEY.RIGHT:
                if (onControl) { focusControl(controlIndex + 1); break; }
                if (onSkip) { els.skipBtn.blur(); break; }
                seekBy(SEEK_STEP_MS);
                break;

            case KEY.FF:
                seekBy(SEEK_LONG_MS);
                break;

            case KEY.REWIND:
                seekBy(-SEEK_LONG_MS);
                break;

            case KEY.ENTER:
                if (onSkip) performSkip(session.segment);
                else if (onControl) els.buttons.children[controlIndex].click();
                else togglePlay();
                break;

            case KEY.PLAY:
            case KEY.PLAY_PAUSE:
                togglePlay();
                break;

            case KEY.PAUSE:
                if (!Player.isPaused()) togglePlay();
                break;

            case KEY.STOP:
                SyncPlay.stop();
                finish(true);
                break;

            default:
                break;
        }
    }

    /* ---------------------------------------------------------- lifecycle */

    function teardown() {
        var current = session;
        if (!current) return;

        /* A new item may replace this one without going through finish(). */
        reportStopped();
        session = null;

        if (current.fadeTimer) clearTimeout(current.fadeTimer);
        if (current.flashTimer) clearTimeout(current.flashTimer);
        if (current.endTimer) clearTimeout(current.endTimer);
        if (current.progressTimer) clearInterval(current.progressTimer);
        if (current.audioCheckTimer) clearTimeout(current.audioCheckTimer);

        document.removeEventListener('keydown', onKeyDown, true);

        if (els && els.infoPanel) els.infoPanel.classList.add('hidden');
        if (els && els.subtitlePanel) els.subtitlePanel.classList.add('hidden');
        if (els && els.audioPanel) els.audioPanel.classList.add('hidden');

        setOsdUp(false);

        var handlers = current.handlers || {};
        for (var name in handlers) {
            if (Object.prototype.hasOwnProperty.call(handlers, name)) {
                Player.off(name, handlers[name]);
            }
        }

        if (current.onSegments) SkipIntro.off('loaded', current.onSegments);

        Player.close();
        SkipIntro.reset();
        SyncPlay.setPlaybackActive(false);

        if (osd) {
            osd.classList.add('hidden');
            osd.classList.remove('faded');
        }
        if (stage) stage.classList.add('hidden');
        if (els && els.subtitleLayer) {
            els.subtitleLayer.textContent = '';
            els.subtitleLayer.classList.add('hidden');
        }
    }

    function bindPlayerEvents() {
        var handlers = {
            ready: function () {
                if (!session) return;
                session.durationMs = Player.getDuration();
                paintProgress(Player.getPosition(), session.durationMs);
                setState(Player.isPaused() ? 'Ready' : 'Playing');

                /* Pick the remembered language before the first sample, then
                   look a little later for a track the TV dropped. */
                applyPreferredAudio();
                if (session && !session.stopping) {
                    if (session.audioCheckTimer) clearTimeout(session.audioCheckTimer);
                    session.audioCheckTimer = setTimeout(checkAudioDecoded, 2500);
                }
            },

            timeupdate: function (positionMs, durationMs) {
                if (!session) return;
                if (durationMs > 0) session.durationMs = durationMs;
                paintProgress(positionMs, session.durationMs);
                paintSubtitles(positionMs);
                updateSkip(positionMs);
                SyncPlay.syncTick(positionMs);
            },

            playing: function () {
                if (!session) return;
                setState('Playing');
                reportStart();
            },

            paused: function () {
                if (!session) return;
                setState('Paused');
                reportProgress();
            },

            buffering: function (isBuffering) {
                if (!session) return;
                setState(isBuffering ? 'Buffering' : (Player.isPaused() ? 'Paused' : 'Playing'));
                if (isBuffering) flash('Buffering\u2026');
                SyncPlay.onBuffering(!!isBuffering);
            },

            seeked: function () {
                if (!session) return;
                paintProgress(Player.getPosition(), session.durationMs);
                SyncPlay.onSeeked();
                reportProgress();
            },

            ended: onEnded,
            error: onError,
            stalled: onStalled
        };

        for (var name in handlers) {
            if (Object.prototype.hasOwnProperty.call(handlers, name)) {
                Player.on(name, handlers[name]);
            }
        }
        return handlers;
    }

    PlayerAudio.attach({
        session: function () { return session; },
        els: function () { return els; },
        showOsd: showOsd,
        toggleInfo: toggleInfo,
        closeSubtitles: closeSubtitles,
        choose: chooseAudio
    });

    /* -------------------------------------------------------------- public */

    window.Screens.player = {
        render: function (container, params) {
            var item = params.item;
            if (!item || !params.url) {
                U.toast('Nothing to play');
                App.back();
                return;
            }

            osd = U.$('#osd');
            stage = U.$('#stage');
            els = {
                title: U.$('#osdTitle'),
                badges: U.$('#osdBadges'),
                center: U.$('#osdCenterLabel'),
                skipBar: U.$('#skipBar'),
                skipBtn: U.$('#skipBtn'),
                track: U.$('#progressTrack'),
                fill: U.$('#progressFill'),
                head: U.$('#progressHead'),
                current: U.$('#timeCurrent'),
                total: U.$('#timeTotal'),
                state: U.$('#ctlState'),
                buttons: U.$('#osdButtons'),
                infoPanel: U.$('#playbackInfo'),
                subtitlePanel: U.$('#subtitlePanel'),
                subtitleList: U.$('#subtitleList'),
                subtitleBtn: null,
                audioPanel: U.$('#audioPanel'),
                audioList: U.$('#audioList'),
                audioBtn: null,
                skipLabel: null,
                playGlyph: null,
                subtitleLayer: U.$('#subtitleLayer')
            };

            /* A text field may still own focus from the setup screen. */
            if (document.activeElement && document.activeElement.blur) {
                document.activeElement.blur();
            }

            session = {
                item: item,
                source: params.source || null,
                audioStream: AudioPrefs.pick(params.source, params.audioIndex),
                audioInPlace: !!params.audioInPlace,
                audioCheckTimer: null,
                url: params.url,
                playMethod: params.playMethod || 'DirectPlay',
                retriedTranscode: !!params.retriedTranscode,
                playSessionId: params.playSessionId || '',
                startMs: params.startMs || 0,
                durationMs: 0,
                reportedStart: false,
                stopping: false,
                segment: null,
                skipVisible: false,
                skipCooldownUntil: 0,
                fadeTimer: null,
                flashTimer: null,
                endTimer: null,
                progressTimer: null,
                handlers: null,
                onSegments: null,
                subtitles: null,
                subtitleStream: null,
                subtitleText: '',
                subtitleToken: 0,
                subtitleOpen: false,
                subtitleRows: [],
                audioOpen: false,
                audioRows: [],
                burnedSubtitleIndex: (params.subtitleIndex !== undefined &&
                    params.subtitleIndex !== null && params.subtitleIndex >= 0)
                    ? params.subtitleIndex : -1,
                infoOpen: false,
                outputLabel: '',
                playGlyph: null
            };

            U.clear(els.skipBtn);
            els.skipBtn.appendChild(global.Icons.el('skip', 26));
            els.skipLabel = U.el('span', 'btn-label', 'Skip Intro');
            els.skipBtn.appendChild(els.skipLabel);

            els.skipBtn.onclick = function (event) {
                if (event && event.preventDefault) event.preventDefault();
                if (session && session.segment) performSkip(session.segment);
            };

            els.infoPanel.classList.add('hidden');
            if (els.subtitlePanel) els.subtitlePanel.classList.add('hidden');
            if (els.audioPanel) els.audioPanel.classList.add('hidden');
            buildControls();

            paintTitle(item);
            paintBadges();
            paintProgress(session.startMs, 0);
            hideSkip();
            setState('Opening');
            showOsd();
            flash('Loading\u2026');

            document.addEventListener('keydown', onKeyDown, true);

            session.handlers = bindPlayerEvents();

            session.onSegments = function () {
                if (session) updateSkip(Player.getPosition());
            };
            SkipIntro.on('loaded', session.onSegments);

            /* Media segments for episodes only; movies have no intro marker. */
            if (item.Type === 'Episode' || item.Type === 'Movie') {
                SkipIntro.load(item.Id);
            }

            session.progressTimer = setInterval(function () {
                reportProgress();
            }, PROGRESS_MS);

            osd.classList.remove('hidden');

            attachSubtitles(session);

            var mine = session;

            function openStream() {
                /* A warm-up can outlive the session it was started for; never
                   open the current session's stream from an old callback. */
                if (!session || session !== mine || session.stopping) return;
                Player.open({
                    url: session.url,
                    startMs: session.startMs,
                    item: item,
                    mediaSource: session.source,
                    playSessionId: session.playSessionId,
                    /* A 20 Mbps 1080p transcode needs a few seconds to emit its
                       first frame; the direct-play watchdog window would kill
                       it before it started. */
                    watchdogMs: session.playMethod === 'Transcode' ? 40000 : 12000
                });
                SyncPlay.setPlaybackActive(true);
            }

            /* Samsung's HLS engine aborts after ~20 s without data and a cold
               transcode of a large remux needs longer than that to write its
               first segment. Warming the stream first also gives the viewer a
               real "Preparing" state instead of a black screen. */
            if (session.playMethod === 'Transcode' && session.url) {
                setState('Preparing');
                flash('Preparing\u2026');
                Api.warmTranscode(session.url).then(openStream, openStream);
            } else {
                openStream();
            }
        },

        /* Called by App when the server says the whole group should stop. */
        stop: function () {
            if (session && !session.stopping) {
                session.stopping = true;
                reportStopped();
                teardown();
                App.back();
            }
        },

        destroy: function () {
            hideUpNext();
            teardown();
        }
    };
})(window);
