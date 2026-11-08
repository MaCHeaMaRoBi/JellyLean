/* Audio-track picker of the playback screen.
   Split out of player-screen.js: it draws the list, owns its focus and open
   state, and hands the chosen stream back. The screen keeps the session and the
   OSD, and gives this module access to them through `attach`. */
(function (global) {
    'use strict';

    var host = null;

    function session() { return host && host.session(); }
    function els() { return host && host.els(); }

    /* ------------------------------------------------------------- naming */

    function trackName(stream) {
        if (!stream) return 'Default';
        if (stream.Language && global.Subtitles) {
            var language = global.Subtitles.languageName(stream.Language);
            if (language) return language;
        }
        return stream.Title || stream.DisplayTitle || ('Track ' + (stream.Index + 1));
    }

    function codecName(codec) {
        var map = {
            truehd: 'TrueHD', ac3: 'AC3', eac3: 'E-AC3', dts: 'DTS', dtshd: 'DTS-HD',
            aac: 'AAC', mp3: 'MP3', flac: 'FLAC', opus: 'Opus', vorbis: 'Vorbis'
        };
        if (!codec) return '';
        return map[String(codec).toLowerCase()] || String(codec).toUpperCase();
    }

    function meta(stream) {
        var bits = [];
        if (stream.Title) bits.push(String(stream.Title));
        if (stream.IsDefault) bits.push('Default');
        var codec = codecName(stream.Codec);
        if (codec) bits.push(codec);
        if (stream.Channels) bits.push(stream.Channels + ' ch');
        if (stream.BitRate) bits.push(Math.round(stream.BitRate / 1000) + ' kbps');
        return bits.join('  ·  ');
    }

    /* -------------------------------------------------------------- list */

    function addRow(stream, active) {
        var row = global.U.el('div', 'sub-row');
        row.setAttribute('data-focusable', '');
        row.setAttribute('role', 'option');
        row.setAttribute('aria-selected', active ? 'true' : 'false');
        row.tabIndex = -1;

        var check = global.U.el('span', 'sub-check');
        if (active) check.appendChild(global.Icons.el('check', 26));
        row.appendChild(check);

        var main = global.U.el('span', 'sub-main');
        main.appendChild(global.U.el('span', 'sub-name', trackName(stream)));
        main.appendChild(global.U.el('span', 'sub-meta', meta(stream)));
        row.appendChild(main);

        if (active) row.classList.add('selected');
        row.setAttribute('aria-label', trackName(stream) + ' audio, ' +
            meta(stream).replace(/\s+·\s+/g, ', '));

        row.onclick = function (event) {
            if (event && event.preventDefault) event.preventDefault();
            host.choose(stream);
        };

        els().audioList.appendChild(row);
        return row;
    }

    function build() {
        var current = session();
        var nodes = els();
        if (!current || !nodes.audioList) return;

        global.U.clear(nodes.audioList);
        current.audioRows = [];

        var streams = global.AudioPrefs.streams(current.source);
        var active = current.audioStream ? current.audioStream.Index : -1;

        if (!streams.length) {
            nodes.audioList.appendChild(global.U.el('div', 'sub-row', 'No audio tracks reported'));
            return;
        }

        for (var i = 0; i < streams.length; i++) {
            current.audioRows.push(addRow(streams[i], streams[i].Index === active));
        }
    }

    /* ------------------------------------------------------------- focus */

    function focusIndex() {
        var current = session();
        if (!current || !current.audioRows) return -1;
        var active = document.activeElement;
        for (var i = 0; i < current.audioRows.length; i++) {
            if (current.audioRows[i] === active) return i;
        }
        return -1;
    }

    function ensureVisible(row) {
        var nodes = els();
        if (!nodes || !nodes.audioList || !row) return;

        var listBox = nodes.audioList.getBoundingClientRect();
        var rowBox = row.getBoundingClientRect();

        if (rowBox.top < listBox.top) {
            nodes.audioList.scrollTop -= (listBox.top - rowBox.top) + 8;
        } else if (rowBox.bottom > listBox.bottom) {
            nodes.audioList.scrollTop += (rowBox.bottom - listBox.bottom) + 8;
        }
    }

    function focusRow(index) {
        var current = session();
        if (!current || !current.audioRows || !current.audioRows.length) return;
        var next = global.U.clamp(index, 0, current.audioRows.length - 1);
        current.audioRows[next].focus();
        ensureVisible(current.audioRows[next]);
    }

    function moveFocus(delta) {
        var index = focusIndex();
        if (index < 0) index = 0;
        focusRow(index + delta);
    }

    /* The remote's OK key: click whichever row has focus. */
    function activate() {
        var current = session();
        if (!current) return;
        var row = current.audioRows[focusIndex()];
        if (row) row.click();
    }

    /* -------------------------------------------------------- open/close */

    function open() {
        var current = session();
        var nodes = els();
        if (!current || !nodes.audioPanel) return;

        if (current.infoOpen) host.toggleInfo();
        if (current.subtitleOpen) host.closeSubtitles(false);

        current.audioOpen = true;
        nodes.audioPanel.classList.remove('hidden');
        build();
        host.showOsd();

        var active = -1;
        for (var i = 0; i < current.audioRows.length; i++) {
            if (current.audioRows[i].classList.contains('selected')) { active = i; break; }
        }
        focusRow(active < 0 ? 0 : active);
    }

    function close(restoreFocus) {
        var current = session();
        if (!current || !current.audioOpen) return false;

        var nodes = els();
        current.audioOpen = false;
        if (nodes && nodes.audioPanel) nodes.audioPanel.classList.add('hidden');

        if (restoreFocus !== false && nodes && nodes.audioBtn) nodes.audioBtn.focus();
        host.showOsd();
        return true;
    }

    function toggle() {
        var current = session();
        if (!current) return;
        if (current.audioOpen) close(true);
        else open();
    }

    global.PlayerAudio = {
        /* host: { session(), els(), showOsd(), toggleInfo(),
                   closeSubtitles(restoreFocus), choose(stream) } */
        attach: function (h) { host = h; },
        trackName: trackName,
        codecName: codecName,
        meta: meta,
        build: build,
        open: open,
        close: close,
        toggle: toggle,
        moveFocus: moveFocus,
        activate: activate
    };
})(window);
