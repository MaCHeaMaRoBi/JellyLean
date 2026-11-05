/* Client settings and diagnostics. */
(function (global) {
    'use strict';

    window.Screens = window.Screens || {};

    /* The TV gives us no logs, so the last negotiated stream is the only way to
       tell "the server sent 1440p" from "the TV refused to decode it". */
    function lastPlaybackLine() {
        var last = App.lastPlayback;
        if (!last) return '';

        return 'Last playback: <b>' + U.esc(last.method) + '</b> ' +
            U.esc(last.container) + ' \u00b7 ' +
            U.esc(last.video) +
            (last.output ? ' \u2192 ' + U.esc(last.output) + ' (actual)' : '') +
            ' \u00b7 ' + U.esc(last.audio) + ' \u00b7 ' +
            U.esc(last.bitrate) + ' (source)';
    }

    function section(title) {
        return U.el('h2', 'section-title', title);
    }

    /* A row that cycles through a fixed set of values on OK. */
    function choiceRow(label, hint, options, value, onSelect, icon) {
        var index = 0;
        for (var i = 0; i < options.length; i++) {
            if (options[i].value === value) index = i;
        }
        var row = UI.listRow({
            title: label, desc: hint, icon: icon, value: options[index].label,
            key: 'set-' + label,
            onClick: function () {
                index = (index + 1) % options.length;
                row.setValue(options[index].label);
                onSelect(options[index].value);
            }
        });
        return row;
    }

    function toggleRow(label, hint, isOn, onToggle, icon) {
        var row = UI.listRow({
            title: label, desc: hint, icon: icon, value: isOn ? 'On' : 'Off',
            key: 'set-' + label,
            onClick: function () {
                isOn = !isOn;
                row.setValue(isOn ? 'On' : 'Off');
                onToggle(isOn);
            }
        });
        return row;
    }

    /* Read-only status text is one focus stop so DOWN reveals it. */
    function statusBlock(key, label) {
        var box = U.el('div', 'diagnostics');
        UI.focusable(box, label);
        box.setAttribute('data-key', key);
        box.setAttribute('data-row', key);
        var line = U.el('div', 'status-line');
        box.appendChild(line);
        return { box: box, line: line };
    }

    window.Screens.settings = {
        render: function (container) {
            var auth = Store.auth();

            var shell = UI.screenShell({ backdrop: false, className: 'deep' });
            container.appendChild(shell.screen);
            var page = shell.scroll;

            var head = U.el('div', 'page-head');
            var titles = U.el('div', 'grow');
            titles.appendChild(U.el('h1', 'title', 'Settings'));
            titles.appendChild(U.el('div', 'count',
                (auth.userName || auth.userId) + '  ·  ' + auth.serverUrl));
            head.appendChild(titles);
            page.appendChild(head);

            var list = U.el('div', 'list');
            page.appendChild(list);

            list.appendChild(section('Playback'));
            list.appendChild(toggleRow(
                'Auto-skip intros',
                'Jump past detected intros without asking (Intro Skipper / Media Segments).',
                Store.pref('autoSkipIntro', false),
                function (value) { Store.setPref('autoSkipIntro', value); },
                'skip'
            ));
            list.appendChild(toggleRow(
                'Force transcoding',
                'Always convert to HLS H.264. Use this if direct play shows a black screen or no audio.',
                Store.pref('forceTranscode', false),
                function (value) {
                    Store.setPref('forceTranscode', value);
                    U.toast('Takes effect on the next playback');
                },
                'transcode'
            ));
            list.appendChild(toggleRow(
                'Autoplay next episode',
                'When an episode ends, offer the next one with a 10 second countdown.',
                Store.pref('autoAdvance', true),
                function (value) { Store.setPref('autoAdvance', value); },
                'forward'
            ));
            list.appendChild(choiceRow(
                'Transcode quality',
                'Bitrate cap when the server converts a file. 20 Mbps still comes back as 1080p; lower it if playback stutters over Wi-Fi.',
                [
                    { value: 4000000, label: 'Data saver · 4 Mbps' },
                    { value: 8000000, label: 'Balanced · 8 Mbps' },
                    { value: 12000000, label: 'High · 12 Mbps' },
                    { value: 20000000, label: 'Maximum · 20 Mbps' }
                ],
                Store.pref('transcodeQuality', 20000000),
                function (value) {
                    Store.setPref('transcodeQuality', value);
                    U.toast('Takes effect on the next playback');
                },
                'settings'
            ));

            list.appendChild(section('SyncPlay'));
            list.appendChild(toggleRow(
                'SyncPlay notifications',
                'Show a message when somebody joins or leaves your group.',
                Store.pref('syncPlayNotices', true),
                function (value) { Store.setPref('syncPlayNotices', value); },
                'users'
            ));

            list.appendChild(section('Discover'));
            list.appendChild(choiceRow(
                'Where to Watch region',
                'Streaming availability on Discover comes from JustWatch via TMDB. Auto follows the TV language.',
                [
                    { value: '', label: 'Auto' },
                    { value: 'US', label: 'United States' },
                    { value: 'GB', label: 'United Kingdom' },
                    { value: 'RO', label: 'Romania' },
                    { value: 'DE', label: 'Germany' },
                    { value: 'FR', label: 'France' },
                    { value: 'NL', label: 'Netherlands' },
                    { value: 'ES', label: 'Spain' },
                    { value: 'IT', label: 'Italy' },
                    { value: 'PL', label: 'Poland' },
                    { value: 'CA', label: 'Canada' },
                    { value: 'AU', label: 'Australia' }
                ],
                Store.pref('watchRegion', ''),
                function (value) { Store.setPref('watchRegion', value); },
                'tv'
            ));

            var seerr = statusBlock('set-seerr', 'Seerr discovery status');
            seerr.line.textContent = 'Checking the Litefin plugin…';
            list.appendChild(seerr.box);

            if (global.Seerr) {
                Seerr.status(true).then(function (status) {
                    if (status && status.available) {
                        seerr.line.innerHTML = 'Seerr discovery: <b>Connected</b>';
                        return;
                    }
                    if (status && status.configured) {
                        seerr.line.innerHTML = 'Seerr discovery: <b>Configured, not reachable</b>' +
                            '<br>Check the Seerr URL and API key in the Litefin plugin settings.';
                        return;
                    }
                    seerr.line.innerHTML = 'Seerr discovery: <b>Not configured</b>' +
                        '<br>Install the Litefin plugin, then add its repository in Dashboard → Plugins:' +
                        '<br>https://raw.githubusercontent.com/MoazSalem/litefin-plugin/release/manifest.json';
                }).catch(function () {
                    seerr.line.textContent = 'Seerr discovery: could not check the plugin.';
                });
            } else {
                seerr.line.textContent = 'Seerr discovery: plugin client not loaded.';
            }

            list.appendChild(section('Server & Device'));
            var device = statusBlock('set-device', 'Server and device details');
            device.line.innerHTML = 'Engine: <b>' + (Player.hasAvplay ? 'AVPlay (native)' : 'HTML5 (development fallback)') + '</b>' +
                '<br>Device ID: ' + U.esc(Store.deviceId().slice(0, 12)) + '…' +
                '<br>Client: JellyLean ' + Api.version +
                (lastPlaybackLine() ? '<br>' + lastPlaybackLine() : '');
            list.appendChild(device.box);

            var checkBtn = UI.button({ label: 'Test Server', icon: 'check', key: 'set-test' });
            checkBtn.onclick = function () {
                UI.iconize(checkBtn, 'check', 'Testing…');
                Api.publicInfo(Api.base).then(function (info) {
                    UI.iconize(checkBtn, 'check', 'Test Server');
                    U.toast('Connected to ' + (info.ServerName || 'Jellyfin') + ' ' + (info.Version || ''));
                }).catch(function (err) {
                    UI.iconize(checkBtn, 'check', 'Test Server');
                    U.toast('Server unreachable: ' + (err.message || 'error'));
                });
            };
            var signOut = UI.button({
                label: 'Sign Out', icon: 'logout', key: 'set-signout',
                onClick: function () { App.logout(); }
            });
            page.appendChild(UI.buttonRow([checkBtn, signOut], { className: 'pad' }));
            page.appendChild(U.el('div', 'shelf-end'));

            U.focusFirst(container);
        },

        destroy: function () {}
    };
})(window);
