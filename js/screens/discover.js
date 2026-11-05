/* Seerr discovery: trending rows, title details, per-season requests,
   watchlist and TMDB/JustWatch availability. */
(function (global) {
    'use strict';

    window.Screens = window.Screens || {};

    var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
        'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    var ROW_LIMIT = 20;

    var MANIFEST = 'https://raw.githubusercontent.com/MoazSalem/litefin-plugin/release/manifest.json';

    function slice(list) {
        return (list || []).slice(0, ROW_LIMIT);
    }

    function rating(value) {
        var number = Number(value);
        return number > 0 ? '\u2605 ' + number.toFixed(1) : '';
    }

    function formatDate(value) {
        if (!value) return '';
        var match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value));
        if (!match) return String(value);
        var month = MONTHS[Number(match[2]) - 1];
        return month ? Number(match[3]) + ' ' + month + ' ' + match[1] : match[1];
    }

    /* ------------------------------------------------------------- cards */

    function cardFor(item, open) {
        var opener = open || openTitle;
        var status = Seerr.statusOf(item.mediaInfo);
        var subtitle = [];
        var year = Seerr.yearOf(item);
        if (year) subtitle.push(year);
        var score = rating(item.voteAverage);
        if (score) subtitle.push(score);

        return UI.remoteCard({
            title: Seerr.titleOf(item),
            subtitle: subtitle.join('  \u00b7  '),
            image: Seerr.image(item.posterPath, 'w342'),
            badge: status.key === 'missing' ? '' : status.label,
            tone: status.tone,
            item: item,
            onClick: function () {
                opener(item);
            }
        });
    }

    function openTitle(item) {
        App.go('seerrDetail', {
            mediaType: Seerr.mediaTypeOf(item),
            tmdbId: item.id,
            title: Seerr.titleOf(item)
        });
    }

    function shelfOf(title, items, key) {
        if (!items || !items.length) return null;
        return UI.shelf(title, items.map(function (item) { return cardFor(item, openTitle); }), { key: key });
    }

    function metaFor(item) {
        var line = U.el('div', 'meta');
        var year = Seerr.yearOf(item);
        if (year) line.appendChild(U.el('span', '', year));
        var score = rating(item.voteAverage);
        if (score) line.appendChild(U.el('span', 'score', score));
        var status = Seerr.statusOf(item.mediaInfo);
        if (status.key !== 'missing') line.appendChild(U.el('span', 'cert', status.label));
        return line;
    }

    /* ------------------------------------------------------ discover page */

    function unavailable(shell, retry) {
        var scroll = shell.scroll;
        U.clear(scroll);
        scroll.appendChild(U.el('h1', 'title', 'Discover'));
        scroll.appendChild(UI.empty(
            'Seerr discovery is not available yet. Install the Litefin plugin on the ' +
            'Jellyfin server and configure its Seerr URL and API key.'));
        var hint = U.el('p', 'note', 'Plugin repository: ' + MANIFEST);
        hint.style.wordBreak = 'break-all';
        scroll.appendChild(hint);

        scroll.appendChild(UI.buttonRow([UI.button({
            label: 'Check Again', icon: 'refresh', primary: true,
            onClick: function () { Seerr.reset(); retry(); }
        })], { className: 'pad' }));
        U.focusFirst(shell.screen);
    }

    /* Same stage as Home: the backdrop and text follow the focused poster. */
    function load(shell) {
        var scroll = shell.scroll;
        U.clear(scroll);
        scroll.appendChild(UI.spinner());

        var stale = U.$('.stage-info', shell.screen);
        if (stale) stale.parentNode.removeChild(stale);
        var info = U.el('section', 'stage-info');
        info.setAttribute('aria-live', 'polite');
        shell.screen.insertBefore(info, shell.viewport);

        var shown = null;
        var timer = null;
        function paintStage(item) {
            if (!item || item === shown) return;
            shown = item;
            U.clear(info);
            if (item.backdropPath) shell.backdrop.set(Seerr.image(item.backdropPath, 'w1280'));
            var title = U.el('h2', 'stage-title', Seerr.titleOf(item));
            if (Seerr.titleOf(item).length > 26) title.className += ' long';
            info.appendChild(title);
            info.appendChild(metaFor(item));
            if (item.overview) info.appendChild(U.el('p', 'overview', item.overview));
        }

        shell.screen.addEventListener('focus', function (event) {
            var node = event.target;
            var data = node && node._remote;
            if (!data || !data.item) return;
            if (timer) clearTimeout(timer);
            timer = setTimeout(function () { paintStage(data.item); }, 140);
        }, true);

        Promise.all([
            Seerr.trending().catch(function () { return []; }),
            Seerr.movies({ page: 1 }).catch(function () { return []; }),
            Seerr.tv({ page: 1 }).catch(function () { return []; }),
            Seerr.upcomingMovies().catch(function () { return []; })
        ]).then(function (parts) {
            var trending = parts[0] || [];
            U.clear(scroll);
            scroll.appendChild(U.el('h1', 'sr-only', 'Discover'));
            scroll.setAttribute('data-align', 'row');
            scroll.setAttribute('data-line', '0');

            var blocks = [
                shelfOf('Trending', slice(trending), 'dc-trending'),
                shelfOf('Popular Movies', slice(parts[1]), 'dc-movies'),
                shelfOf('Popular TV', slice(parts[2]), 'dc-tv'),
                shelfOf('Upcoming Movies', slice(parts[3]), 'dc-upcoming')
            ].filter(function (node) { return !!node; });

            if (!blocks.length) scroll.appendChild(UI.empty('Seerr returned nothing to show.'));
            blocks.forEach(function (node) { scroll.appendChild(node); });
            scroll.appendChild(U.el('div', 'shelf-spacer'));

            if (trending[0]) paintStage(trending[0]);
            U.lazy.check();
            U.focusFirst(shell.screen);
        });
    }

    window.Screens.discover = {
        render: function (container) {
            var shell = UI.screenShell({ nav: 'discover', backdrop: true, className: 'home' });
            shell.viewport.className += ' shelves';
            container.appendChild(shell.screen);
            UI.startClock();

            function attempt() {
                Seerr.status().then(function (status) {
                    if (status && status.available) load(shell);
                    else unavailable(shell, attempt);
                }).catch(function () {
                    unavailable(shell, attempt);
                });
            }

            attempt();
        },

        destroy: function () {}
    };

    /* Search reuses the same card so a Seerr result looks identical wherever
       it is shown. */
    window.Screens.discover.remoteCard = cardFor;

    /* --------------------------------------------------------- title page */

    function seasonStatusMap(mediaInfo) {
        var out = {};
        var list = mediaInfo && mediaInfo.seasons;
        if (!list) return out;

        if (Object.prototype.toString.call(list) === '[object Array]') {
            list.forEach(function (season) {
                if (season && season.seasonNumber !== undefined) {
                    out[String(season.seasonNumber)] = Number(season.status);
                }
            });
            return out;
        }
        if (typeof list === 'object') {
            for (var key in list) {
                if (Object.prototype.hasOwnProperty.call(list, key)) out[key] = Number(list[key]);
            }
        }
        return out;
    }

    function requestIdOf(mediaInfo) {
        var list = mediaInfo && mediaInfo.requests;
        if (!list || !list.length) return 0;
        for (var i = list.length - 1; i >= 0; i--) {
            if (list[i] && list[i].id) return list[i].id;
        }
        return 0;
    }

    function metaLineFor(item, mediaType) {
        var line = U.el('div', 'meta');
        function add(text, cls) { if (text) line.appendChild(U.el('span', cls || '', text)); }
        add(Seerr.yearOf(item));
        if (mediaType === 'tv') {
            if (item.numberOfSeasons) add(item.numberOfSeasons + (item.numberOfSeasons === 1 ? ' season' : ' seasons'));
        } else if (item.runtime) {
            add(item.runtime + ' min');
        }
        add(rating(item.voteAverage), 'score');
        if (item.genres && item.genres.length) {
            add(item.genres.slice(0, 3).map(function (g) { return g.name || g; }).join(', '), 'genres');
        }
        return line;
    }

    function initials(name) {
        var words = String(name || '').split(/\s+/);
        var out = '';
        for (var i = 0; i < words.length && out.length < 2; i++) {
            if (words[i]) out += words[i].charAt(0).toUpperCase();
        }
        return out || '?';
    }

    function personTile(person) {
        var node = U.el('div', 'card person');
        UI.focusable(node, person.name + (person.character ? ', ' + person.character : ''));
        node.setAttribute('role', 'button');
        node.setAttribute('data-key', UI.keyOf('cast', person.id || person.name));
        var art = U.el('div', 'art');
        var clip = U.el('div', 'art-clip');
        if (person.profilePath) {
            var img = UI.lazyImage(Seerr.image(person.profilePath, 'w185'), person.name, null);
            img.onerror = function () {
                if (img.parentNode) img.parentNode.removeChild(img);
                clip.appendChild(U.el('span', 'person-initials', initials(person.name)));
            };
            clip.appendChild(img);
        } else {
            clip.appendChild(U.el('span', 'person-initials', initials(person.name)));
        }
        art.appendChild(clip);
        node.appendChild(art);
        node.appendChild(U.el('div', 'caption', person.name || ''));
        if (person.character) node.appendChild(U.el('div', 'sub', person.character));
        return node;
    }

    function fact(label, value) {
        if (!value) return null;
        var node = U.el('div', 'fact');
        node.appendChild(U.el('div', 'fact-label', label));
        node.appendChild(U.el('div', 'fact-value', value));
        return node;
    }

    /* A block of read-only content is one focus stop, so DOWN reveals it. */
    function infoPanel(title, key, content) {
        var wrap = U.el('section', 'row facts-wrap');
        wrap.appendChild(U.el('h2', 'row-title', title));
        UI.focusable(content, title);
        content.setAttribute('data-key', key);
        content.setAttribute('data-row', key);
        wrap.appendChild(content);
        return wrap;
    }

    function providerGroup(title, list) {
        if (!list || !list.length) return null;
        var group = U.el('div', 'provider-group');
        group.appendChild(U.el('div', 'provider-title', title));

        var strip = U.el('div', 'provider-list');
        list.forEach(function (provider) {
            var node = U.el('div', 'provider');
            var frame = U.el('div', 'provider-frame');
            function initial() {
                frame.appendChild(U.el('span', 'provider-initial', String(provider.name || '?').charAt(0)));
            }
            if (provider.logoPath) {
                var img = document.createElement('img');
                img.src = Seerr.image(provider.logoPath, 'w92');
                img.alt = '';
                img.onerror = function () { img.style.display = 'none'; initial(); };
                frame.appendChild(img);
            } else {
                initial();
            }
            node.appendChild(frame);
            node.appendChild(U.el('div', 'provider-name', provider.name || ''));
            strip.appendChild(node);
        });
        group.appendChild(strip);
        return group;
    }

    function watchPanel(item) {
        var code = Seerr.region();
        var wrap = U.el('div', 'provider-groups');
        var groups = [
            providerGroup('Streaming', Seerr.providersOf(item, 'flatrate')),
            providerGroup('Rent', Seerr.providersOf(item, 'rent')),
            providerGroup('Buy', Seerr.providersOf(item, 'buy'))
        ].filter(function (node) { return !!node; });

        if (!groups.length) {
            wrap.appendChild(U.el('div', 'provider-empty', 'No streaming options listed for ' + code + '.'));
        } else {
            groups.forEach(function (node) { wrap.appendChild(node); });
        }
        wrap.appendChild(U.el('div', 'provider-note',
            'Availability for ' + code + ' · Data from JustWatch via TMDB' +
            (Store.pref('watchRegion', '') ? '' : ' · change the region in Settings')));
        return wrap;
    }

    function factsPanel(item, mediaType, status) {
        var box = U.el('div', 'facts');
        var rows = [
            fact('Availability', status.label),
            fact('Released', formatDate(item.releaseDate || item.firstAirDate)),
            fact('Language', item.originalLanguage ? String(item.originalLanguage).toUpperCase() : ''),
            fact(mediaType === 'tv' ? 'Seasons' : 'Runtime',
                mediaType === 'tv'
                    ? (item.numberOfSeasons ? String(item.numberOfSeasons) : '')
                    : (item.runtime ? item.runtime + ' min' : '')),
            fact('Episodes', mediaType === 'tv' && item.numberOfEpisodes ? String(item.numberOfEpisodes) : ''),
            fact('Status', item.status)
        ];
        var shown = 0;
        rows.forEach(function (node) { if (node) { box.appendChild(node); shown++; } });
        return shown ? infoPanel('Details', 'dc-facts', box) : null;
    }

    function seasonsBlock(item, mediaType, repaint) {
        var seasons = item.seasons || [];
        if (mediaType !== 'tv' || !seasons.length) return null;

        var availability = seasonStatusMap(item.mediaInfo);
        var selected = {};
        var block = U.el('section', 'row season-block');
        block.appendChild(U.el('h2', 'row-title', 'Request Seasons'));
        block.appendChild(U.el('p', 'note',
            'Choose the seasons to send to Seerr. Seasons already in your library are marked Available.'));

        var list = U.el('div', 'season-list');
        block.appendChild(list);

        var requestable = 0;
        var confirm = UI.button({ label: 'Select Seasons', icon: 'plus', key: 'dc-confirm' });

        function selection() {
            var out = [];
            for (var key in selected) if (selected[key]) out.push(Number(key));
            out.sort(function (a, b) { return a - b; });
            return out;
        }

        function paintConfirm() {
            var count = selection().length;
            confirm.className = 'btn' + (count ? ' primary' : '');
            if (!count) confirm.setAttribute('data-disabled', 'true');
            else confirm.removeAttribute('data-disabled');
            UI.iconize(confirm, 'plus',
                count ? 'Request ' + count + (count === 1 ? ' Season' : ' Seasons') : 'Select Seasons');
        }

        function buildRow(season) {
            var number = Number(season.seasonNumber);
            if (isNaN(number)) return;
            var state = availability[String(number)] || 0;
            var available = state === 5;
            var requested = state === 2 || state === 3;
            var name = season.name || ('Season ' + number);

            var bits = [];
            if (season.episodeCount) bits.push(season.episodeCount + (season.episodeCount === 1 ? ' episode' : ' episodes'));
            if (season.airDate) bits.push(formatDate(season.airDate));

            var row = UI.listRow({ title: name, desc: bits.join('  ·  '), key: 'dc-season-' + number });
            row.className += ' season-row';
            var check = U.el('span', 'check');
            row.appendChild(check);
            list.appendChild(row);

            if (available || requested) {
                row.appendChild(U.el('span', 'chip' + (available ? ' good' : ''), available ? 'Available' : 'Requested'));
                row.setAttribute('data-disabled', 'true');
                if (available) check.appendChild(Icons.el('check', 26));
                row.setAttribute('aria-label', name + (available ? ', in your library' : ', already requested'));
                return;
            }

            requestable++;
            row.setAttribute('aria-label', name + ', select to request');
            /* Missing seasons start selected: the common case is "give me
               everything I do not have". */
            selected[String(number)] = true;
            row.classList.add('selected');
            check.appendChild(Icons.el('check', 26));

            row.onclick = function () {
                selected[String(number)] = !selected[String(number)];
                row.classList[selected[String(number)] ? 'add' : 'remove']('selected');
                U.clear(check);
                if (selected[String(number)]) check.appendChild(Icons.el('check', 26));
                paintConfirm();
            };
        }

        seasons.forEach(buildRow);
        if (!list.firstChild) return null;

        if (!requestable) {
            block.appendChild(U.el('p', 'note', 'Every season is already in your library.'));
            return block;
        }

        paintConfirm();
        confirm.onclick = function () {
            var numbers = selection();
            if (!numbers.length) { U.toast('Select at least one season'); return; }
            confirm.setAttribute('aria-busy', 'true');
            Seerr.request({ mediaType: 'tv', mediaId: item.id, seasons: numbers }).then(function () {
                U.toast('Requested ' + numbers.length + (numbers.length === 1 ? ' season' : ' seasons'));
                repaint();
            }).catch(function (err) {
                confirm.removeAttribute('aria-busy');
                U.toast('Request failed: ' + (err.message || 'error'));
            });
        };

        var clear = UI.button({
            label: 'Clear', icon: 'close', key: 'dc-clear',
            onClick: function () {
                for (var key in selected) {
                    if (Object.prototype.hasOwnProperty.call(selected, key)) selected[key] = false;
                }
                U.$all('.season-row.selected', list).forEach(function (row) {
                    row.classList.remove('selected');
                    var mark = U.$('.check', row);
                    if (mark) U.clear(mark);
                });
                paintConfirm();
            }
        });
        block.appendChild(UI.buttonRow([confirm, clear], { className: 'pad' }));
        return block;
    }

    function heroActions(item, mediaType, mediaInfo, status, repaint) {
        var buttons = [];
        var title = Seerr.titleOf(item);

        if (mediaInfo.jellyfinMediaId) {
            buttons.push(UI.button({
                label: 'Open in Library', icon: 'play', primary: true, key: 'dc-open',
                aria: 'Open ' + title + ' in your library',
                onClick: function () {
                    App.go('detail', { itemId: mediaInfo.jellyfinMediaId, title: item.title || item.name });
                }
            }));
        }

        if (mediaType === 'movie' && !mediaInfo.jellyfinMediaId) {
            if (status.key === 'missing') {
                var requestBtn = UI.button({ label: 'Request Movie', icon: 'plus', primary: true, key: 'dc-request' });
                requestBtn.onclick = function () {
                    requestBtn.setAttribute('aria-busy', 'true');
                    Seerr.request({ mediaType: 'movie', mediaId: item.id }).then(function () {
                        U.toast('Requested ' + title);
                        repaint();
                    }).catch(function (err) {
                        requestBtn.removeAttribute('aria-busy');
                        U.toast('Request failed: ' + (err.message || 'error'));
                    });
                };
                buttons.push(requestBtn);
            } else if (status.key === 'pending' || status.key === 'processing') {
                var pending = UI.button({ label: 'Requested', icon: 'check', key: 'dc-requested' });
                pending.setAttribute('data-disabled', 'true');
                buttons.push(pending);
                var requestId = requestIdOf(mediaInfo);
                if (requestId) {
                    buttons.push(UI.button({
                        label: 'Cancel Request', icon: 'close', key: 'dc-cancel',
                        onClick: function () {
                            Seerr.cancelRequest(requestId).then(function () {
                                U.toast('Request cancelled');
                                repaint();
                            }).catch(function (err) {
                                U.toast('Could not cancel: ' + (err.message || 'error'));
                            });
                        }
                    }));
                }
            } else if (status.key === 'partial') {
                buttons.push(UI.button({
                    label: 'Request Again', icon: 'plus', key: 'dc-again',
                    onClick: function () {
                        Seerr.request({ mediaType: 'movie', mediaId: item.id }).then(function () {
                            U.toast('Request sent');
                            repaint();
                        }).catch(function (err) {
                            U.toast('Request failed: ' + (err.message || 'error'));
                        });
                    }
                }));
            }
        }

        var onList = !!item.onUserWatchlist;
        var watchBtn = UI.button({ label: 'Watchlist', icon: 'bookmark', key: 'dc-watch' });
        function paintWatch() {
            UI.iconize(watchBtn, 'bookmark', onList ? 'In Watchlist' : 'Watchlist');
            watchBtn.setAttribute('aria-label',
                (onList ? 'Remove ' + title + ' from watchlist' : 'Add ' + title + ' to watchlist'));
        }
        paintWatch();
        watchBtn.onclick = function () {
            watchBtn.setAttribute('aria-busy', 'true');
            var action = onList
                ? Seerr.removeFromWatchlist(mediaType, item.id)
                : Seerr.addToWatchlist(mediaType, item.id);
            action.then(function () {
                onList = !onList;
                watchBtn.removeAttribute('aria-busy');
                paintWatch();
                U.toast(onList ? 'Added to watchlist' : 'Removed from watchlist');
            }).catch(function (err) {
                watchBtn.removeAttribute('aria-busy');
                U.toast('Watchlist update failed: ' + (err.message || 'error'));
            });
        };
        buttons.push(watchBtn);
        return UI.buttonRow(buttons);
    }

    function paint(shell, params, item) {
        var mediaType = params.mediaType === 'tv' ? 'tv' : 'movie';
        var mediaInfo = item.mediaInfo || {};
        var status = Seerr.statusOf(mediaInfo);
        var scroll = shell.scroll;
        var keep = U.captureFocus();

        U.clear(scroll);
        if (item.backdropPath) shell.backdrop.set(Seerr.image(item.backdropPath, 'w1280'));

        function repaint() {
            Seerr.detail(mediaType, item.id).then(function (fresh) {
                U.setPendingFocus(keep);
                paint(shell, params, fresh);
            }).catch(function () { U.toast('Could not refresh this title'); });
        }

        var hero = U.el('section', 'cinema-hero' + (item.backdropPath ? '' : ' bare'));
        hero.setAttribute('data-scroll-top', '');
        var title = U.el('h1', 'stage-title', Seerr.titleOf(item));
        if (Seerr.titleOf(item).length > 26) title.className += ' long';
        hero.appendChild(title);
        hero.appendChild(metaLineFor(item, mediaType));
        if (item.tagline) hero.appendChild(U.el('div', 'tagline', item.tagline));
        hero.appendChild(heroActions(item, mediaType, mediaInfo, status, repaint));
        if (item.overview) hero.appendChild(U.el('p', 'overview', item.overview));
        scroll.appendChild(hero);

        var body = U.el('div', 'cinema-body');
        scroll.appendChild(body);

        var seasons = seasonsBlock(item, mediaType, repaint);
        if (seasons) body.appendChild(seasons);

        var cast = (item.credits && item.credits.cast) ? item.credits.cast.slice(0, 16) : [];
        var castShelf = UI.shelf('Cast', cast.map(personTile), { key: 'dc-cast', className: 'people' });
        if (castShelf) body.appendChild(castShelf);

        body.appendChild(infoPanel('Where to Watch', 'dc-watch-panel', watchPanel(item)));
        var facts = factsPanel(item, mediaType, status);
        if (facts) body.appendChild(facts);

        var similarHost = U.el('div', '');
        body.appendChild(similarHost);
        body.appendChild(U.el('div', 'shelf-end'));

        U.lazy.check();
        U.focusFirst(shell.screen);

        Seerr.similar(mediaType, item.id).then(function (items) {
            var node = shelfOf('More Like This', slice(items), 'dc-similar');
            if (node) { similarHost.appendChild(node); U.lazy.check(); }
        }).catch(function () { /* an empty shelf beats an error */ });
    }

    window.Screens.seerrDetail = {
        render: function (container, params) {
            var mediaType = params.mediaType === 'tv' ? 'tv' : 'movie';
            var shell = UI.screenShell({ backdrop: true, className: 'deep cinema' });
            container.appendChild(shell.screen);
            shell.scroll.appendChild(UI.spinner());

            function attempt() {
                U.clear(shell.scroll);
                shell.scroll.appendChild(UI.spinner());
                Seerr.detail(mediaType, params.tmdbId).then(function (item) {
                    paint(shell, params, item);
                }).catch(function (err) {
                    U.clear(shell.scroll);
                    shell.scroll.appendChild(U.el('h1', 'title', params.title || 'Title'));
                    shell.scroll.appendChild(UI.empty('Could not load this title: ' + (err.message || 'unknown')));
                    shell.scroll.appendChild(UI.buttonRow([UI.button({
                        label: 'Retry', icon: 'refresh', primary: true, onClick: attempt
                    })], { className: 'pad' }));
                    U.focusFirst(shell.screen);
                });
            }

            attempt();
        },

        destroy: function () {}
    };
})(window);
