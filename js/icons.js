/* Inline SVG icon set.
   Inline markup keeps the widget self-contained (no icon font, no network
   request) and `currentColor` lets an icon inherit the focus/text colour of
   whatever button or chip contains it. The Tizen 3.0 engine parses SVG inside
   innerHTML, so the paths are kept as plain strings. */
(function (global) {
    'use strict';

    var PATHS = {
        back: '<path d="M15 5l-7 7 7 7"/>',

        home: '<path d="M4 11.2 12 4l8 7.2"/><path d="M6.5 9.8V20h11V9.8"/>',

        /* Sliders read better than a gear at TV distance. */
        settings: '<path d="M4 7h9"/><path d="M17 7h3"/><path d="M4 17h3"/><path d="M11 17h9"/>' +
            '<circle cx="15" cy="7" r="2.2"/><circle cx="8" cy="17" r="2.2"/>',

        play: '<path d="M8 5.5v13l10.5-6.5z" fill="currentColor" stroke="none"/>',
        pause: '<path d="M9 5.5h2.4v13H9zM12.6 5.5H15v13h-2.4z" fill="currentColor" stroke="none"/>',

        rewind: '<path d="M11 6l-5.5 6 5.5 6"/><path d="M18 6l-5.5 6 5.5 6"/>',
        forward: '<path d="M13 6l5.5 6-5.5 6"/><path d="M6 6l5.5 6L6 18"/>',

        info: '<circle cx="12" cy="12" r="8.6"/><path d="M12 11.2v5"/>' +
            '<circle cx="12" cy="7.7" r="1.05" fill="currentColor" stroke="none"/>',

        captions: '<rect x="3" y="5" width="18" height="14" rx="2"/>' +
            '<path d="M9.7 10.1a2.2 2.2 0 1 0 0 3.8"/>' +
            '<path d="M16.8 10.1a2.2 2.2 0 1 0 0 3.8"/>',

        skip: '<path d="M5 6l6.5 6L5 18zM11.5 6L18 12l-6.5 6z" fill="currentColor" stroke="none"/>' +
            '<path d="M20 5.5v13"/>',

        transcode: '<path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3v6h-6"/>',
        refresh: '<path d="M20 12a8 8 0 1 1-2.3-5.7"/><path d="M20 4v5h-5"/>',
        stop: '<rect x="7" y="7" width="10" height="10" rx="1.6" fill="currentColor" stroke="none"/>',
        down: '<path d="M6.5 9.5l5.5 5.5 5.5-5.5"/>',

        tv: '<rect x="3" y="5.5" width="18" height="11.5" rx="2"/><path d="M8.5 20.5h7"/>',
        monitor: '<rect x="2.5" y="4.5" width="19" height="12" rx="2"/><path d="M9 20h6"/>',

        users: '<circle cx="9" cy="8" r="3.2"/><path d="M3.6 19.2a5.6 5.6 0 0 1 10.8 0"/>' +
            '<path d="M16.2 5.4a3.4 3.4 0 0 1 0 5.2"/><path d="M18.4 14.4a5.6 5.6 0 0 1 2.2 4.2"/>',

        check: '<path d="M5 12.5l4.6 4.6L19 7.5"/>',
        logout: '<path d="M14 4.5h4.5v15H14"/><path d="M10 8l-4 4 4 4"/><path d="M6 12h8.5"/>',
        close: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',

        dot: '<circle cx="12" cy="12" r="2" fill="currentColor" stroke="none"/>',

        search: '<circle cx="11" cy="11" r="6.4"/><path d="M15.8 15.8L20.5 20.5"/>',

        /* Discover: a compass reads as "browse something new" better than a
           second magnifier. */
        compass: '<circle cx="12" cy="12" r="8.6"/>' +
            '<path d="M15.4 8.6l-2 4.8-4.8 2 2-4.8z"/>',

        plus: '<path d="M12 5v14M5 12h14"/>',
        bookmark: '<path d="M7 4.5h10v15l-5-3.6-5 3.6z"/>',
        star: '<path d="M12 4.6l2.2 4.6 5 .7-3.6 3.5.9 5-4.5-2.4-4.5 2.4.9-5L4.8 9.9l5-.7z"/>',
        eye: '<path d="M2.8 12S6 6.2 12 6.2 21.2 12 21.2 12 18 17.8 12 17.8 2.8 12 2.8 12z"/>' +
            '<circle cx="12" cy="12" r="2.6"/>',

        sort: '<path d="M7 5v14M7 19l-3-3M7 19l3-3"/><path d="M17 19V5M17 5l-3 3M17 5l3 3"/>',
        swap: '<path d="M5 8h13M18 8l-3-3M18 8l-3 3"/><path d="M19 16H6M6 16l3-3M6 16l3 3"/>',
        film: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M8 4.5v15M16 4.5v15M3.5 9.5H8M3.5 14.5H8M16 9.5h4.5M16 14.5h4.5"/>',
        music: '<path d="M9 18V6l10-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/>',
        folder: '<path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>',
        audio: '<path d="M4 9.5h3.5L12 5.5v13L7.5 14.5H4z"/>' +
            '<path d="M15.5 9.2a4 4 0 0 1 0 5.6"/><path d="M18.3 6.6a7.8 7.8 0 0 1 0 10.8"/>'
    };

    function html(name, size) {
        var s = size || 24;
        var body = PATHS[name] || PATHS.dot;

        return '<svg class="icon icon-' + name + '" viewBox="0 0 24 24" width="' + s + '" height="' + s + '"' +
            ' fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round"' +
            ' stroke-linejoin="round" aria-hidden="true" focusable="false">' + body + '</svg>';
    }

    function el(name, size) {
        var box = document.createElement('div');
        box.innerHTML = html(name, size);
        return box.firstChild;
    }

    global.Icons = {
        has: function (name) { return !!PATHS[name]; },
        html: html,
        el: el,

        /* Prepend an icon to an existing button without touching its label. */
        prepend: function (node, name, size) {
            if (!node) return node;
            var icon = el(name, size);
            if (node.firstChild) node.insertBefore(icon, node.firstChild);
            else node.appendChild(icon);
            return node;
        }
    };
})(window);
