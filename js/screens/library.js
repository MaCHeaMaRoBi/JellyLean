/* Library / folder browsing: poster grid by whole rows, Sort and Filter
   controls, incremental paging as focus nears the bottom. The Favorites tab is
   this same screen with the favorites filter fixed on. */
(function (global) {
    'use strict';

    window.Screens = window.Screens || {};

    var PAGE = 60;
    var COLUMNS = 6;

    /* Jellyfin's SortBy vocabulary. Labels are what the viewer reads. */
    var SORTS = [
        { id: 'SortName', label: 'Name', asc: 'A to Z', desc: 'Z to A' },
        { id: 'DateCreated', label: 'Date Added', asc: 'Oldest first', desc: 'Newest first' },
        { id: 'CommunityRating', label: 'Rating', asc: 'Low to high', desc: 'High to low' },
        { id: 'Runtime', label: 'Runtime', asc: 'Shortest first', desc: 'Longest first' }
    ];

    function sortPrefKey(parentId) { return 'librarySort:' + parentId; }

    function sortOf(id) {
        for (var i = 0; i < SORTS.length; i++) if (SORTS[i].id === id) return SORTS[i];
        return SORTS[0];
    }

    /* What to show. Each id maps to one of Jellyfin's Filters values. */
    var SHOWS = [
        { id: 'all', label: 'All', filter: null },
        { id: 'unplayed', label: 'Unwatched', filter: 'IsUnplayed' },
        { id: 'played', label: 'Watched', filter: 'IsPlayed' },
        { id: 'favorites', label: 'Favorites', filter: 'IsFavorite' }
    ];

    function filterPrefKey(scope) { return 'libraryFilter:' + scope; }

    function showOf(id) {
        for (var i = 0; i < SHOWS.length; i++) if (SHOWS[i].id === id) return SHOWS[i];
        return SHOWS[0];
    }

    /* The Favorites screen is already "only favorites", so it offers no
       Favorites choice of its own. */
    function showsFor(favoritesOnly) {
        return SHOWS.filter(function (show) { return !(favoritesOnly && show.id === 'favorites'); });
    }

    function loadFilter(scope, favoritesOnly) {
        var saved = Store.get(filterPrefKey(scope), null) || {};
        var show = showOf(saved.show).id;
        if (favoritesOnly && show === 'favorites') show = 'all';
        return { show: show, genre: saved.genre ? String(saved.genre) : '' };
    }

    function saveFilter(scope, filter) {
        Store.set(filterPrefKey(scope), { show: filter.show, genre: filter.genre });
    }

    function isFiltered(filter) { return filter.show !== 'all' || !!filter.genre; }

    /* The Filters values to send. */
    function queryFilters(filter, favoritesOnly) {
        var list = [];
        var chosen = showOf(filter.show).filter;
        if (chosen) list.push(chosen);
        if (favoritesOnly && list.indexOf('IsFavorite') === -1) list.push('IsFavorite');
        return list;
    }

    /* Words for the count line: "Unwatched", "Action". */
    function describeFilter(filter) {
        var words = [];
        if (filter.show !== 'all') words.push(showOf(filter.show).label);
        if (filter.genre) words.push(filter.genre);
        return words;
    }

    function openItem(item) {
        if (UI.isFolder(item)) App.go('library', { parentId: item.Id, title: item.Name });
        else App.go('detail', { itemId: item.Id, item: item });
    }

    window.Screens.library = {
        /* Shared with the filter screen, which edits the same saved choice. */
        filter: {
            shows: showsFor,
            load: loadFilter,
            save: saveFilter
        },

        render: function (container, params) {
            var title = params.title || 'Library';
            var parentId = params.parentId;
            /* A library is remembered by its id; the Favorites screen has no
               parent, so it names its own scope. */
            var scope = params.scope || parentId;
            var favoritesOnly = params.favorites === true;
            var startIndex = 0;
            var total = 0;
            var loading = false;
            var loadToken = 0;
            var pending = [];

            /* The first visit uses the caller's sort, then remembers whatever
               was chosen for this specific library. */
            var saved = Store.get(sortPrefKey(scope), null) || {};
            var sortBy = saved.sortBy || params.sortBy || 'SortName';
            var sortOrder = saved.sortOrder || 'Ascending';
            var filter = loadFilter(scope, favoritesOnly);

            var navKey = params.nav || (params.top ? 'library:' + parentId : null);
            var shell = UI.screenShell({ nav: navKey });
            if (!navKey) shell.screen.className += ' deep';
            container.appendChild(shell.screen);
            UI.startClock();

            var head = U.el('div', 'page-head');
            var titles = U.el('div', 'grow');
            titles.appendChild(U.el('h1', 'title', title));
            var counter = U.el('div', 'count', '');
            counter.setAttribute('aria-live', 'polite');
            titles.appendChild(counter);
            head.appendChild(titles);

            var controls = U.el('div', 'btn-row');
            controls.setAttribute('data-row', 'controls');
            var sortBtn = UI.button({ label: '', icon: 'sort', onClick: function () {
                var next = (SORTS.indexOf(sortOf(sortBy)) + 1) % SORTS.length;
                sortBy = SORTS[next].id;
                paintSort();
                reset();
            } });
            sortBtn.className += ' sm';
            var dirBtn = UI.button({ label: '', icon: 'swap', onClick: function () {
                sortOrder = sortOrder === 'Ascending' ? 'Descending' : 'Ascending';
                paintSort();
                reset();
            } });
            dirBtn.className += ' sm';
            var filterBtn = UI.button({ label: 'Filter', icon: 'filter', key: 'lib-filter', onClick: function () {
                App.go('libraryFilter', {
                    scope: scope, title: title, parentId: parentId,
                    favorites: favoritesOnly, includeItemTypes: params.includeItemTypes
                });
            } });
            filterBtn.className += ' sm';
            controls.appendChild(sortBtn);
            controls.appendChild(dirBtn);
            controls.appendChild(filterBtn);
            head.appendChild(controls);
            shell.scroll.appendChild(head);

            function paintSort() {
                var sort = sortOf(sortBy);
                sortBtn.labelNode.textContent = 'Sort: ' + sort.label;
                sortBtn.setAttribute('aria-label', 'Sort by ' + sort.label + '. Press OK to change.');
                dirBtn.labelNode.textContent = sortOrder === 'Ascending' ? sort.asc : sort.desc;
            }
            paintSort();

            function paintFilter() {
                var active = describeFilter(filter).length;
                filterBtn.labelNode.textContent = active ? 'Filter \u00b7 ' + active : 'Filter';
                filterBtn.setAttribute('aria-label', active
                    ? 'Filter, ' + describeFilter(filter).join(', ') + '. Press OK to change.'
                    : 'Filter. Press OK to choose what to show.');
            }
            paintFilter();

            function clearFilter() {
                filter = { show: 'all', genre: '' };
                saveFilter(scope, filter);
                paintFilter();
                reset();
            }

            var grid = U.el('div', 'grid');
            shell.scroll.appendChild(grid);
            var footer = U.el('div', 'grid-foot');
            shell.scroll.appendChild(footer);

            function persistSort() {
                Store.set(sortPrefKey(scope), { sortBy: sortBy, sortOrder: sortOrder });
            }

            function addCards(items) {
                var nodes = pending.concat(items.map(function (item) {
                    return UI.card(item, { keyPrefix: 'lib', onClick: openItem });
                }));
                /* Only complete rows are drawn until the last page arrives, so a
                   half line never appears mid-grid. */
                var complete = startIndex >= total ? nodes.length : nodes.length - (nodes.length % COLUMNS);
                if (!grid.firstChild && nodes[0]) nodes[0].setAttribute('data-autofocus', '');
                for (var i = 0; i < complete; i += COLUMNS) {
                    grid.appendChild(UI.gridLine(nodes.slice(i, i + COLUMNS)));
                }
                pending = nodes.slice(complete);
            }

            function reset() {
                persistSort();
                /* Invalidate the page still in flight and clear the guard it
                   set, otherwise the new sort never loads and the old order
                   gets appended to the new one. */
                loadToken++;
                loading = false;
                startIndex = 0;
                total = 0;
                pending = [];
                U.clear(grid);
                U.clear(footer);
                counter.textContent = '';
                U.setTranslate(shell.scroll, 0, 0, true);
                loadMore(true);
            }

            function loadMore(refocus) {
                if (loading) return;
                loading = true;
                var mine = ++loadToken;

                Api.items({
                    parentId: parentId,
                    startIndex: startIndex,
                    limit: PAGE,
                    sortBy: sortBy,
                    sortOrder: sortOrder,
                    recursive: params.recursive === true,
                    includeItemTypes: params.includeItemTypes,
                    filters: queryFilters(filter, favoritesOnly),
                    genres: filter.genre
                }).then(function (result) {
                    if (mine !== loadToken) return;
                    var items = (result && result.Items) || [];
                    total = result ? result.TotalRecordCount : items.length;
                    startIndex += items.length;
                    if (!items.length) total = startIndex;

                    U.clear(footer);
                    addCards(items);

                    var words = describeFilter(filter);
                    counter.textContent = total
                        ? total + (total === 1 ? ' title' : ' titles') +
                            (words.length ? '  \u00b7  ' + words.join('  \u00b7  ') : '') : '';

                    if (!grid.firstChild && !pending.length) {
                        if (isFiltered(filter)) {
                            footer.appendChild(UI.empty('Nothing matches these filters.'));
                            var clearBtn = UI.button({
                                label: 'Clear Filters', icon: 'refresh', primary: true,
                                key: 'lib-clear', onClick: clearFilter
                            });
                            clearBtn.setAttribute('data-autofocus', '');
                            footer.appendChild(UI.buttonRow([clearBtn], { className: 'pad' }));
                        } else {
                            footer.appendChild(UI.empty(params.emptyText || 'This library is empty.'));
                        }
                    }

                    loading = false;
                    U.lazy.schedule(0);

                    if (startIndex === items.length || refocus) {
                        var active = document.activeElement;
                        var onSort = active && (active === sortBtn || active === dirBtn);
                        if (!onSort) U.focusFirst(container);
                    }
                }).catch(function (err) {
                    if (mine !== loadToken) return;
                    loading = false;
                    U.clear(footer);
                    footer.appendChild(UI.empty('Could not load items: ' + (err.message || 'unknown')));
                    footer.appendChild(UI.buttonRow([UI.button({
                        label: 'Retry', icon: 'refresh', primary: true, onClick: function () { loadMore(true); }
                    })]));
                    U.focusFirst(container);
                });
            }

            /* Page in more as focus nears the last drawn line. Bound to the
               screen, not #app, so it dies when the screen does. */
            shell.screen.addEventListener('focus', function (event) {
                var node = event.target;
                if (loading || startIndex >= total || !node || !node._item) return;
                var lines = grid.children;
                var line = U.closest(node, '.grid-line');
                for (var i = lines.length - 1; i >= 0 && i >= lines.length - 2; i--) {
                    if (lines[i] === line) { loadMore(false); return; }
                }
            }, true);

            loadMore(false);
        },

        destroy: function () {}
    };

    /* The Favorites tab: everything the viewer has starred, across every
       library, in the same grid with the same Sort and Filter controls. */
    window.Screens.favorites = {
        render: function (container) {
            window.Screens.library.render(container, {
                title: 'Favorites',
                nav: 'favorites',
                scope: 'favorites',
                favorites: true,
                recursive: true,
                includeItemTypes: ['Movie', 'Series', 'Season', 'Episode', 'BoxSet'],
                emptyText: 'No favorites yet. Open a movie or show and choose Favorite to add it here.'
            });
        },

        destroy: function () {}
    };
})(window);
