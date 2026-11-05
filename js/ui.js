/* Shared TV components: artwork, cards, shelves, nav, buttons, list rows and
   the screen shell. See DESIGN.md for what each one is supposed to look like.
   ES5, no framework: plain DOM builders. */
(function (global) {
    'use strict';

    var SHELF_CAP = 24;

    /* ------------------------------------------------------------- helpers */

    function pad(n) { return n < 10 ? '0' + n : '' + n; }

    function clockText() {
        var now = new Date();
        return pad(now.getHours()) + ':' + pad(now.getMinutes());
    }

    /* data-key values are used in attribute selectors and focus memory, so keep
       them to a boring alphabet. */
    function keyOf(prefix, id) {
        return String(prefix || 'k') + ':' + String(id === undefined ? '' : id).replace(/[^A-Za-z0-9:_-]/g, '_');
    }

    function hueOf(text) {
        var hue = 0;
        var s = String(text || '?');
        for (var i = 0; i < s.length; i++) hue = (hue * 31 + s.charCodeAt(i)) % 360;
        return hue;
    }

    function isFolder(item) {
        return !!item && (item.IsFolder || item.Type === 'Folder' ||
            item.Type === 'CollectionFolder' || item.Type === 'Season');
    }

    function episodeTag(item) {
        if (!item || item.ParentIndexNumber === undefined || item.ParentIndexNumber === null) return '';
        var tag = 'S' + item.ParentIndexNumber;
        if (item.IndexNumber !== undefined && item.IndexNumber !== null) tag += ' E' + item.IndexNumber;
        return tag;
    }

    function setAttrs(node, attrs) {
        for (var k in attrs) {
            if (attrs.hasOwnProperty(k) && attrs[k] !== undefined && attrs[k] !== null) {
                node.setAttribute(k, attrs[k]);
            }
        }
        return node;
    }

    function focusable(node, label) {
        node.setAttribute('data-focusable', '');
        node.tabIndex = -1;
        if (label) node.setAttribute('aria-label', label);
        return node;
    }

    /* ------------------------------------------------------------- artwork */

    /* Landscape cards want a wide image; an episode's own still is the right
       answer for episodes, a Thumb or Backdrop for everything else. */
    function landscapeUrl(item, width) {
        var tags = item.ImageTags || {};
        if (item.Type === 'Episode') {
            if (tags.Primary) return Api.imageUrl(item, 'Primary', width);
            if (item.ParentThumbItemId && item.ParentThumbImageTag) {
                return Api.imageById(item.ParentThumbItemId, 'Thumb', width, item.ParentThumbImageTag);
            }
        }
        if (tags.Thumb) return Api.imageUrl(item, 'Thumb', width);
        if (item.BackdropImageTags && item.BackdropImageTags.length) return Api.imageUrl(item, 'Backdrop', width);
        if (tags.Primary) return Api.imageUrl(item, 'Primary', width);
        return '';
    }

    function posterUrl(item, landscape) {
        if (!item) return '';
        if (landscape) return landscapeUrl(item, 480);
        if (item.ImageTags && item.ImageTags.Primary) return Api.imageUrl(item, 'Primary', 320);
        return '';
    }

    /* The widest picture that belongs to an item, for the stage and details. */
    function backdropUrl(item, width) {
        if (!item) return '';
        var w = width || 1280;
        if (item.BackdropImageTags && item.BackdropImageTags.length) return Api.imageUrl(item, 'Backdrop', w);
        if (item.ParentBackdropItemId && item.ParentBackdropImageTags && item.ParentBackdropImageTags.length) {
            return Api.imageById(item.ParentBackdropItemId, 'Backdrop', w, item.ParentBackdropImageTags[0]);
        }
        if (item.ImageTags && item.ImageTags.Thumb) return Api.imageUrl(item, 'Thumb', w);
        if (item.ImageTags && item.ImageTags.Primary && item.Type === 'Episode') return Api.imageUrl(item, 'Primary', w);
        return '';
    }

    function logoUrl(item) {
        if (!item) return '';
        if (item.ImageTags && item.ImageTags.Logo) return Api.imageUrl(item, 'Logo', 720);
        if (item.ParentLogoItemId && item.ParentLogoImageTag) {
            return Api.imageById(item.ParentLogoItemId, 'Logo', 720, item.ParentLogoImageTag);
        }
        return '';
    }

    /* Artwork is lazy: only data-src is written here, util.js promotes it to src
       when the card nears the viewport. A failed image falls back to the
       typographic placeholder. */
    function lazyImage(url, fallbackText, clip) {
        var img = document.createElement('img');
        img.alt = '';
        img.setAttribute('data-src', url);
        img.onload = function () { img.className = 'loaded'; };
        img.onerror = function () {
            if (img.parentNode) img.parentNode.removeChild(img);
            if (clip) clip.insertBefore(placeholder(fallbackText), clip.firstChild);
        };
        return img;
    }

    function placeholder(text) {
        var hue = hueOf(text);
        var node = U.el('div', 'ph');
        var bg = 'linear-gradient(160deg, hsl(' + hue + ',30%,24%) 0%, hsl(' + ((hue + 28) % 360) + ',34%,11%) 100%)';
        node.style.background = bg;
        node.appendChild(U.el('span', 'ph-text', text || ''));
        return node;
    }

    /* ----------------------------------------------------------------- card */

    function captionFor(item, landscape) {
        if (landscape && item.Type === 'Episode' && item.SeriesName) return item.SeriesName;
        return item.Name || '';
    }

    function subFor(item, landscape) {
        if (!landscape) return '';
        if (item.Type === 'Episode') {
            var tag = episodeTag(item);
            return (tag ? tag + '  ' : '') + (item.Name || '');
        }
        var bits = [];
        if (item.ProductionYear) bits.push(item.ProductionYear);
        if (item.RunTimeTicks && item.Type === 'Movie') bits.push(U.fmtRuntime(item.RunTimeTicks));
        return bits.join('  ·  ');
    }

    function card(item, options) {
        var opts = options || {};
        var landscape = !!opts.landscape;
        var node = U.el('div', 'card' + (landscape ? ' landscape' : ''));
        focusable(node);
        node.setAttribute('role', 'button');
        node.setAttribute('data-key', keyOf(opts.keyPrefix || 'item', item.Id));
        node._item = item;

        var caption = opts.caption !== undefined ? opts.caption : captionFor(item, landscape);
        var sub = opts.sub !== undefined ? opts.sub : subFor(item, landscape);
        var label = caption + (sub ? ', ' + sub : '');
        if (label) node.setAttribute('aria-label', label);

        var art = U.el('div', 'art');
        var clip = U.el('div', 'art-clip');
        var url = posterUrl(item, landscape);
        if (url) clip.appendChild(lazyImage(url, item.Name, clip));
        else clip.appendChild(placeholder(item.Name));

        var position = item.UserData && item.UserData.PlaybackPositionTicks;
        if (position && item.RunTimeTicks) {
            var bar = U.el('div', 'progress');
            var fill = document.createElement('i');
            fill.style.width = Math.min(100, Math.max(2, (position / item.RunTimeTicks) * 100)) + '%';
            bar.appendChild(fill);
            clip.appendChild(bar);
        }
        art.appendChild(clip);

        var data = item.UserData || {};
        if (data.Played && item.Type !== 'Series') {
            var done = U.el('span', 'badge badge-done');
            done.appendChild(global.Icons.el('check', 22));
            art.appendChild(done);
        } else if (data.UnplayedItemCount > 0 && (item.Type === 'Series' || item.Type === 'Season')) {
            art.appendChild(U.el('span', 'badge badge-count', String(data.UnplayedItemCount)));
        }
        node.appendChild(art);

        if (opts.showCaption !== false) {
            if (caption) node.appendChild(U.el('div', 'caption', caption));
            if (sub) node.appendChild(U.el('div', 'sub', sub));
        }

        if (opts.onClick) node.onclick = function () { opts.onClick(item); };
        return node;
    }

    /* A card for something that is not in the library yet: the image comes from
       TMDB and the text is plain, not an item record. */
    function remoteCard(spec) {
        var data = spec || {};
        var node = U.el('div', 'card remote-card');
        focusable(node, data.title || 'Untitled');
        node.setAttribute('role', 'button');
        node.setAttribute('data-key', keyOf('remote', (data.item && data.item.id) || data.title));
        node._remote = data;

        var art = U.el('div', 'art');
        var clip = U.el('div', 'art-clip');
        if (data.image) clip.appendChild(lazyImage(data.image, data.title, clip));
        else clip.appendChild(placeholder(data.title));
        art.appendChild(clip);

        if (data.badge) {
            art.appendChild(U.el('span', 'badge badge-status' + (data.tone ? ' ' + data.tone : ''), data.badge));
        }
        node.appendChild(art);

        if (data.title) node.appendChild(U.el('div', 'caption', data.title));
        if (data.subtitle) node.appendChild(U.el('div', 'sub', data.subtitle));

        node.onclick = function () { if (data.onClick) data.onClick(data.item || data); };
        return node;
    }

    /* ---------------------------------------------------------------- shelves */

    /* A horizontal shelf. The viewport clips, the track translates (util.js),
       and 24px of runway above and below keeps the focus ring from being cut. */
    function shelf(title, nodes, options) {
        if (!nodes || !nodes.length) return null;
        var opts = options || {};
        var wrap = U.el('section', 'row' + (opts.className ? ' ' + opts.className : ''));
        if (opts.key) wrap.setAttribute('data-shelf', opts.key);

        if (title) {
            var heading = U.el('h2', 'row-title', title);
            wrap.appendChild(heading);
        }

        var viewport = U.el('div', 'row-viewport');
        var track = U.el('div', 'row-track');
        track.setAttribute('data-row', opts.rowName || 'shelf');
        for (var i = 0; i < nodes.length; i++) track.appendChild(nodes[i]);
        viewport.appendChild(track);
        wrap.appendChild(viewport);
        return wrap;
    }

    function row(title, items, options) {
        if (!items || !items.length) return null;
        var opts = options || {};
        var nodes = [];
        var count = Math.min(items.length, opts.cap || SHELF_CAP);
        for (var i = 0; i < count; i++) {
            nodes.push(card(items[i], {
                landscape: opts.landscape,
                showCaption: opts.showCaption,
                keyPrefix: opts.keyPrefix || title,
                onClick: opts.onClick
            }));
        }
        return shelf(title, nodes, { key: opts.keyPrefix || title, className: opts.className });
    }

    /* Rows of cards for the library and search grids: each grid line is a
       `data-row`, so UP/DOWN walks lines and LEFT/RIGHT walks the line. */
    function gridLine(nodes) {
        var line = U.el('div', 'grid-line');
        line.setAttribute('data-row', 'grid');
        for (var i = 0; i < nodes.length; i++) line.appendChild(nodes[i]);
        return line;
    }

    /* ----------------------------------------------------------------- buttons */

    function iconize(btn, icon, label) {
        if (!btn) return btn;
        var text = (label === undefined || label === null) ? (btn.textContent || '') : label;
        U.clear(btn);
        if (icon && global.Icons) btn.appendChild(global.Icons.el(icon, 32));
        btn.labelNode = U.el('span', 'btn-label', text);
        btn.appendChild(btn.labelNode);
        return btn;
    }

    /* spec: { label, icon, primary, onClick, id, aria } */
    function button(spec) {
        var btn = U.el('button', 'btn' + (spec.primary ? ' primary' : ''));
        iconize(btn, spec.icon, spec.label);
        focusable(btn, spec.aria || spec.label);
        if (spec.id) btn.id = spec.id;
        if (spec.key) btn.setAttribute('data-key', spec.key);
        if (spec.onClick) btn.onclick = spec.onClick;
        return btn;
    }

    function buttonRow(buttons, options) {
        var opts = options || {};
        var row = U.el('div', 'btn-row' + (opts.className ? ' ' + opts.className : ''));
        row.setAttribute('data-row', 'actions');
        for (var i = 0; i < buttons.length; i++) if (buttons[i]) row.appendChild(buttons[i]);
        return row;
    }

    /* Settings-style row: title + description on the left, current value as a
       pill on the right. `setValue` repaints the pill. */
    function listRow(spec) {
        var node = U.el('div', 'list-row');
        focusable(node);
        node.setAttribute('role', 'button');
        if (spec.key) node.setAttribute('data-key', spec.key);

        if (spec.icon && global.Icons) {
            var glyph = U.el('span', 'list-icon');
            glyph.appendChild(global.Icons.el(spec.icon, 36));
            node.appendChild(glyph);
        }

        var info = U.el('div', 'list-info');
        info.appendChild(U.el('div', 'list-title', spec.title || ''));
        if (spec.desc) info.appendChild(U.el('div', 'list-desc', spec.desc));
        node.appendChild(info);

        node.valueNode = null;
        if (spec.value !== undefined && spec.value !== null) {
            node.valueNode = U.el('span', 'pill', spec.value);
            node.appendChild(node.valueNode);
        }
        node.setValue = function (text) {
            if (node.valueNode) node.valueNode.textContent = text;
            node.setAttribute('aria-label', (spec.title || '') + (text ? ': ' + text : ''));
        };
        node.setValue(spec.value);

        if (spec.onClick) node.onclick = function () { spec.onClick(node); };
        return node;
    }

    function chip(text, className) {
        return U.el('span', 'chip' + (className ? ' ' + className : ''), text);
    }

    /* ----------------------------------------------------------- text blocks */

    /* Year, runtime, rating box and score on one line. */
    function metaLine(item, extra) {
        var line = U.el('div', 'meta');
        function add(text, cls) {
            if (text === undefined || text === null || text === '') return;
            line.appendChild(U.el('span', cls || '', String(text)));
        }
        if (item.Type === 'Episode') {
            add(episodeTag(item));
        }
        add(item.ProductionYear);
        if (item.RunTimeTicks) add(U.fmtRuntime(item.RunTimeTicks));
        if (item.OfficialRating) add(item.OfficialRating, 'cert');
        if (item.CommunityRating) add('★ ' + Number(item.CommunityRating).toFixed(1), 'score');
        if (item.CriticRating) add(item.CriticRating + '%', 'critic');
        if (item.Genres && item.Genres.length) add(item.Genres.slice(0, 3).join(', '), 'genres');
        if (extra) add(extra);
        return line;
    }

    /* The item's logo when the server has one, otherwise its name in the
       display face. Either way it carries the accessible name. */
    function titleBlock(item, className, tag) {
        var node = U.el(tag || 'h2', className || 'stage-title');
        var url = logoUrl(item);
        node.setAttribute('aria-label', item.Name || '');
        if (url) {
            node.className += ' has-logo';
            var img = document.createElement('img');
            img.alt = item.Name || '';
            img.className = 'logo';
            img.onerror = function () {
                if (img.parentNode) img.parentNode.removeChild(img);
                node.className = node.className.replace(' has-logo', '');
                node.textContent = item.Name || '';
            };
            img.src = url;
            node.appendChild(img);
        } else {
            node.textContent = item.Name || 'Untitled';
            if ((item.Name || '').length > 26) node.className += ' long';
        }
        return node;
    }

    /* ------------------------------------------------------------ backdrop */

    /* Full-bleed art behind a screen. Two layers cross-fade (opacity only), so
       moving focus along a shelf re-lights the room without a hard cut. */
    function makeBackdrop() {
        var node = U.el('div', 'backdrop-stage');
        var a = U.el('div', 'bd');
        var b = U.el('div', 'bd');
        node.appendChild(a);
        node.appendChild(b);
        node.appendChild(U.el('div', 'bd-scrim-side'));
        node.appendChild(U.el('div', 'bd-scrim-bottom'));

        var front = a;
        var back = b;
        var current = '';
        var token = 0;

        function show(layer) {
            layer.classList.add('on');
            front.classList.remove('on');
            var old = front;
            front = layer;
            back = old;
        }

        return {
            node: node,
            set: function (url) {
                if (url === current) return;
                current = url;
                var mine = ++token;
                if (!url) { front.classList.remove('on'); return; }
                var probe = new Image();
                probe.onload = function () {
                    if (mine !== token) return;
                    back.style.backgroundImage = 'url("' + url + '")';
                    show(back);
                };
                probe.onerror = function () {
                    if (mine === token) front.classList.remove('on');
                };
                probe.src = url;
            }
        };
    }

    /* ------------------------------------------------------------------- nav */

    var viewsPromise = null;

    function views() {
        if (!viewsPromise) {
            viewsPromise = Api.views().catch(function () { viewsPromise = null; return []; });
        }
        return viewsPromise;
    }

    function resetViews() { viewsPromise = null; }

    var NAV_TYPES = { movies: 1, tvshows: 1, homevideos: 1, musicvideos: 1, boxsets: 1, music: 1 };

    function iconForView(view) {
        switch (view.CollectionType) {
            case 'movies': return 'film';
            case 'tvshows': return 'tv';
            case 'music': return 'music';
            default: return 'folder';
        }
    }

    function tab(spec) {
        var node = U.el('button', 'tab' + (spec.current ? ' current' : '') + (spec.iconOnly ? ' icon-only' : ''));
        if (spec.icon && global.Icons) node.appendChild(global.Icons.el(spec.icon, 32));
        if (!spec.iconOnly) node.appendChild(U.el('span', 'tab-label', spec.label));
        focusable(node, spec.label);
        node.setAttribute('data-key', 'nav:' + spec.key);
        if (spec.key) node.setAttribute('data-nav', spec.key);
        node.onclick = spec.onClick;
        return node;
    }

    /* The top tab bar. `current` is one of: home, search, discover, settings,
       syncplay, or library:<id>. Libraries and Discover arrive asynchronously;
       the bar is usable immediately and fills in. */
    function nav(options) {
        var opts = options || {};
        var bar = U.el('nav', 'nav');
        bar.setAttribute('data-row', 'nav');
        bar.setAttribute('data-entry', 'current');
        bar.setAttribute('aria-label', 'Main');

        bar.appendChild(U.el('div', 'brand', 'Jelly·Lean'));

        var tabs = U.el('div', 'tabs');
        bar.appendChild(tabs);
        bar.appendChild(U.el('div', 'nav-space'));

        var right = U.el('div', 'tabs tabs-right');
        bar.appendChild(right);

        var clock = U.el('div', 'clock', clockText());
        clock.id = 'navClock';
        bar.appendChild(clock);

        var current = opts.current;

        function paint(libraries, discover) {
            U.clear(tabs);
            tabs.appendChild(tab({
                key: 'home', label: 'Home', current: current === 'home',
                onClick: function () { App.tab('home'); }
            }));

            for (var i = 0; i < libraries.length && i < 4; i++) {
                (function (view) {
                    var key = 'library:' + view.Id;
                    tabs.appendChild(tab({
                        key: key, label: view.Name, current: current === key,
                        onClick: function () {
                            App.tab('library', { parentId: view.Id, title: view.Name, top: true });
                        }
                    }));
                })(libraries[i]);
            }

            tabs.appendChild(tab({
                key: 'search', label: 'Search', icon: 'search', current: current === 'search',
                onClick: function () { App.tab('search'); }
            }));

            if (discover) {
                tabs.appendChild(tab({
                    key: 'discover', label: 'Discover', icon: 'compass', current: current === 'discover',
                    onClick: function () { App.tab('discover'); }
                }));
            }
        }

        var state = { libraries: opts.libraries || [], discover: false };
        paint(state.libraries, false);

        var group = SyncPlay.getGroup && SyncPlay.getGroup();
        right.appendChild(tab({
            key: 'syncplay', label: group ? 'SyncPlay: ' + (group.GroupName || 'Group') : 'SyncPlay',
            icon: 'users', iconOnly: true, current: current === 'syncplay',
            onClick: function () { App.tab('syncplay'); }
        }));
        right.appendChild(tab({
            key: 'settings', label: 'Settings', icon: 'settings', iconOnly: true,
            current: current === 'settings',
            onClick: function () { App.tab('settings'); }
        }));

        /* Re-render the tab list without losing focus on it. */
        function refresh() {
            var had = document.activeElement && tabs.contains(document.activeElement)
                ? document.activeElement.getAttribute('data-key') : null;
            paint(state.libraries, state.discover);
            if (had) {
                var again = tabs.querySelector('[data-key="' + had + '"]');
                if (again) again.focus();
            }
        }

        if (!opts.libraries) {
            views().then(function (list) {
                state.libraries = (list || []).filter(function (view) {
                    return !view.CollectionType || NAV_TYPES[view.CollectionType];
                });
                refresh();
            });
        }

        if (global.Seerr) {
            Seerr.status().then(function (status) {
                if (!status || !status.available) return;
                state.discover = true;
                refresh();
            }).catch(function () { /* an absent plugin is not an error */ });
        }

        return bar;
    }

    /* --------------------------------------------------------- screen shell */

    /* A screen is: optional backdrop stage, optional nav, then a viewport that
       clips a translating `page`. Callers append to `shell.scroll` (the page).
       options: { nav: 'home' | ..., backdrop: true, className } */
    function screenShell(options) {
        var opts = options || {};
        var screen = U.el('div', 'screen' + (opts.nav ? ' has-nav' : '') +
            (opts.className ? ' ' + opts.className : ''));

        var backdrop = null;
        if (opts.backdrop) {
            backdrop = makeBackdrop();
            screen.appendChild(backdrop.node);
        }

        var bar = null;
        if (opts.nav) {
            bar = nav({ current: opts.nav, libraries: opts.libraries });
            screen.appendChild(bar);
        }

        var viewport = U.el('div', 'viewport');
        var page = U.el('main', 'page');
        viewport.appendChild(page);
        screen.appendChild(viewport);

        return { screen: screen, body: viewport, viewport: viewport, scroll: page, nav: bar, backdrop: backdrop };
    }

    function spinner() {
        var node = U.el('div', 'spinner');
        node.setAttribute('role', 'status');
        node.setAttribute('aria-label', 'Loading');
        return node;
    }

    function empty(message) {
        return U.el('div', 'empty', message);
    }

    function startClock() {
        if (startClock.timer) return;
        startClock.timer = setInterval(function () {
            var node = U.$('#navClock');
            if (node) node.textContent = clockText();
        }, 20000);
    }

    global.UI = {
        card: card,
        remoteCard: remoteCard,
        shelf: shelf,
        row: row,
        gridLine: gridLine,
        iconize: iconize,
        button: button,
        buttonRow: buttonRow,
        listRow: listRow,
        chip: chip,
        metaLine: metaLine,
        titleBlock: titleBlock,
        nav: nav,
        views: views,
        resetViews: resetViews,
        iconForView: iconForView,
        screenShell: screenShell,
        spinner: spinner,
        empty: empty,
        clockText: clockText,
        startClock: startClock,
        focusable: focusable,
        keyOf: keyOf,
        hueOf: hueOf,
        isFolder: isFolder,
        episodeTag: episodeTag,
        backdropUrl: backdropUrl,
        logoUrl: logoUrl,
        placeholder: placeholder,
        lazyImage: lazyImage,
        setAttrs: setAttrs
    };
})(window);
