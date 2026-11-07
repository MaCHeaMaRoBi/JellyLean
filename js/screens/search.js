/* Unified search: the Jellyfin library first, then Seerr discovery when the
   Seerr is set up. */
(function (global) {
    'use strict';

    window.Screens = window.Screens || {};

    var DEBOUNCE_MS = 450;
    var MIN_CHARS = 2;

    function remoteCard(item) {
        return global.Screens.discover.remoteCard(item);
    }

    window.Screens.search = {
        render: function (container) {
            var shell = UI.screenShell({ nav: 'search' });
            container.appendChild(shell.screen);
            UI.startClock();

            var head = U.el('div', 'page-head');
            var titles = U.el('div', 'grow');
            titles.appendChild(U.el('h1', 'title', 'Search'));
            var status = U.el('div', 'count', 'Type a title, then press OK');
            status.setAttribute('aria-live', 'polite');
            titles.appendChild(status);
            head.appendChild(titles);
            shell.scroll.appendChild(head);

            /* The field takes LEFT/RIGHT for editing, so the button sits
               below it: DOWN reaches it, DOWN again reaches the results. */
            var form = U.el('div', 'search-form');
            var input = U.el('input', 'search-input');
            input.type = 'search';
            input.id = 'searchInput';
            input.placeholder = 'Search movies, shows and discovery';
            input.setAttribute('aria-label', 'Search');
            input.setAttribute('data-focusable', '');
            input.setAttribute('data-row', 'field');
            input.setAttribute('data-key', 'search-input');
            form.appendChild(input);
            shell.scroll.appendChild(form);

            var goBtn = UI.button({
                label: 'Search', icon: 'search', primary: true, key: 'search-go',
                onClick: function () { run(true); }
            });
            shell.scroll.appendChild(UI.buttonRow([goBtn], { className: 'pad' }));

            var results = U.el('div', 'search-results');
            shell.scroll.appendChild(results);

            var seerrReady = false;
            var timer = null;
            var token = 0;
            var lastQuery = '';

            if (global.Seerr) {
                Seerr.status().then(function (value) {
                    seerrReady = !!(value && value.available);
                    input.placeholder = seerrReady
                        ? 'Search your library and Seerr'
                        : 'Search your library';
                }).catch(function () { /* library-only search still works */ });
            }

            function clearResults() {
                U.clear(results);
                status.textContent = '';
            }

            function openChosen(chosen) {
                if (UI.isFolder(chosen)) App.go('library', { parentId: chosen.Id, title: chosen.Name });
                else App.go('detail', { itemId: chosen.Id, item: chosen });
            }

            function librarySections(items) {
                var movies = items.filter(function (i) { return i.Type !== 'Series'; });
                var series = items.filter(function (i) { return i.Type === 'Series'; });
                return [
                    UI.row(series.length && movies.length ? 'Movies' : 'In Your Library', movies,
                        { keyPrefix: 'sr-movie', onClick: openChosen, cap: 60 }),
                    UI.row(movies.length ? 'TV Shows' : 'In Your Library', series,
                        { keyPrefix: 'sr-series', onClick: openChosen, cap: 60 })
                ];
            }

            function seerrSection(items) {
                if (!items.length) return null;
                return UI.shelf('Discover', items.map(remoteCard), { key: 'sr-discover' });
            }

            function render(library, discovered, query) {
                U.clear(results);

                var blocks = librarySections(library || []);
                blocks.push(seerrSection(discovered || []));
                var any = false;
                blocks.forEach(function (block) {
                    if (block) { results.appendChild(block); any = true; }
                });
                U.lazy.check();

                if (!any) {
                    results.appendChild(UI.empty('Nothing found for \u201c' + query + '\u201d.'));
                }

                var total = (library ? library.length : 0) + (discovered ? discovered.length : 0);
                status.textContent = total + (total === 1 ? ' result' : ' results');

                /* The viewer is typing: focus stays in the field so the TV's
                   on-screen keyboard does not disappear between keystrokes. */
                if (document.activeElement !== input && any) {
                    var first = results.querySelector('[data-focusable]');
                    if (first) U.focusNode(first);
                }
            }

            function run(immediate) {
                var query = String(input.value || '').replace(/^\s+|\s+$/g, '');

                if (query.length < MIN_CHARS) {
                    lastQuery = '';
                    clearResults();
                    if (query.length) status.textContent = 'Type at least ' + MIN_CHARS + ' characters.';
                    return;
                }

                if (!immediate && query === lastQuery) return;
                lastQuery = query;

                var current = ++token;
                status.textContent = 'Searching\u2026';

                var libraryPromise = Api.items({
                    searchTerm: query,
                    includeItemTypes: 'Movie,Series',
                    limit: 60,
                    sortBy: 'SortName',
                    sortOrder: 'Ascending'
                }).then(function (result) {
                    return (result && result.Items) || [];
                }).catch(function () { return []; });

                var discoverPromise = (seerrReady && global.Seerr)
                    ? Seerr.search(query).catch(function () { return []; })
                    : Promise.resolve([]);

                Promise.all([libraryPromise, discoverPromise]).then(function (parts) {
                    if (current !== token) return;
                    render(parts[0], parts[1], query);
                });
            }

            input.addEventListener('input', function () {
                if (timer) clearTimeout(timer);
                timer = setTimeout(function () { run(false); }, DEBOUNCE_MS);
            });

            input.addEventListener('keydown', function (event) {
                if (event.keyCode === 13) {
                    event.preventDefault();
                    if (timer) clearTimeout(timer);
                    run(true);
                }
            });

            U.focusFirst(container);
        },

        destroy: function () {}
    };
})(window);
