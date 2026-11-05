/* Library / folder browsing: poster grid by whole rows, one Sort control,
   incremental paging as focus nears the bottom. */
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

    function openItem(item) {
        if (UI.isFolder(item)) App.go('library', { parentId: item.Id, title: item.Name });
        else App.go('detail', { itemId: item.Id, item: item });
    }

    window.Screens.library = {
        render: function (container, params) {
            var title = params.title || 'Library';
            var parentId = params.parentId;
            var startIndex = 0;
            var total = 0;
            var loading = false;
            var pending = [];

            /* The first visit uses the caller's sort, then remembers whatever
               was chosen for this specific library. */
            var saved = Store.get(sortPrefKey(parentId), null) || {};
            var sortBy = saved.sortBy || params.sortBy || 'SortName';
            var sortOrder = saved.sortOrder || 'Ascending';

            var shell = UI.screenShell({ nav: params.top ? 'library:' + parentId : null });
            if (!params.top) shell.screen.className += ' deep';
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
            controls.appendChild(sortBtn);
            controls.appendChild(dirBtn);
            head.appendChild(controls);
            shell.scroll.appendChild(head);

            function paintSort() {
                var sort = sortOf(sortBy);
                sortBtn.labelNode.textContent = 'Sort: ' + sort.label;
                sortBtn.setAttribute('aria-label', 'Sort by ' + sort.label + '. Press OK to change.');
                dirBtn.labelNode.textContent = sortOrder === 'Ascending' ? sort.asc : sort.desc;
            }
            paintSort();

            var grid = U.el('div', 'grid');
            shell.scroll.appendChild(grid);
            var footer = U.el('div', 'grid-foot');
            shell.scroll.appendChild(footer);

            function persistSort() {
                Store.set(sortPrefKey(parentId), { sortBy: sortBy, sortOrder: sortOrder });
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

                Api.items({
                    parentId: parentId,
                    startIndex: startIndex,
                    limit: PAGE,
                    sortBy: sortBy,
                    sortOrder: sortOrder,
                    recursive: params.recursive === true
                }).then(function (result) {
                    var items = (result && result.Items) || [];
                    total = result ? result.TotalRecordCount : items.length;
                    startIndex += items.length;
                    if (!items.length) total = startIndex;

                    U.clear(footer);
                    addCards(items);

                    counter.textContent = total
                        ? total + (total === 1 ? ' title' : ' titles') : '';

                    if (!grid.firstChild && !pending.length) {
                        footer.appendChild(UI.empty('This library is empty.'));
                    }

                    loading = false;
                    U.lazy.schedule(0);

                    if (startIndex === items.length || refocus) {
                        var active = document.activeElement;
                        var onSort = active && (active === sortBtn || active === dirBtn);
                        if (!onSort) U.focusFirst(container);
                    }
                }).catch(function (err) {
                    loading = false;
                    U.clear(footer);
                    footer.appendChild(UI.empty('Could not load items: ' + (err.message || 'unknown')));
                    footer.appendChild(UI.buttonRow([UI.button({
                        label: 'Retry', icon: 'refresh', primary: true, onClick: function () { loadMore(true); }
                    })]));
                    U.focusFirst(container);
                });
            }

            /* Page in more as focus nears the last drawn line. */
            container.addEventListener('focus', function (event) {
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
})(window);
