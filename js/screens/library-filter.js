/* Library filter: what to show (all, unwatched, watched, favorites) and an
   optional genre. A plain vertical list, like Settings, so the remote only ever
   moves up and down. Each choice is saved the moment it is made, and BACK
   returns to the library, which reads the saved choice again. */
(function (global) {
    'use strict';

    window.Screens = window.Screens || {};

    var CHOSEN = 'Selected';

    window.Screens.libraryFilter = {
        render: function (container, params) {
            var saved = global.Screens.library.filter;
            var scope = params.scope;
            var favoritesOnly = params.favorites === true;
            var filter = saved.load(scope, favoritesOnly);

            var shell = UI.screenShell({ backdrop: false, className: 'deep' });
            container.appendChild(shell.screen);
            var page = shell.scroll;

            var head = U.el('div', 'page-head');
            var titles = U.el('div', 'grow');
            titles.appendChild(U.el('h1', 'title', 'Filter'));
            titles.appendChild(U.el('div', 'count',
                (params.title || 'Library') + '  \u00b7  Press BACK to see the results'));
            head.appendChild(titles);
            page.appendChild(head);

            var list = U.el('div', 'list');
            page.appendChild(list);

            /* ------------------------------------------------------- show */

            list.appendChild(U.el('h2', 'section-title', 'Show'));
            var showRows = {};

            function paintShow() {
                for (var id in showRows) {
                    if (showRows.hasOwnProperty(id)) showRows[id].setValue(filter.show === id ? CHOSEN : '');
                }
            }

            saved.shows(favoritesOnly).forEach(function (show) {
                var row = UI.listRow({
                    title: show.label, value: '', key: 'flt-show-' + show.id,
                    onClick: function () {
                        filter.show = show.id;
                        saved.save(scope, filter);
                        paintShow();
                    }
                });
                if (filter.show === show.id) row.setAttribute('data-autofocus', '');
                showRows[show.id] = row;
                list.appendChild(row);
            });
            paintShow();

            /* ------------------------------------------------------ genre */

            list.appendChild(U.el('h2', 'section-title', 'Genre'));
            var genreBox = U.el('div', 'filter-genres');
            list.appendChild(genreBox);
            genreBox.appendChild(UI.spinner());

            var genreRows = {};

            function paintGenre() {
                for (var name in genreRows) {
                    if (genreRows.hasOwnProperty(name)) {
                        genreRows[name].setValue(filter.genre === name.slice(1) ? CHOSEN : '');
                    }
                }
            }

            /* Genre names are used as object keys, so they are prefixed to keep
               one such as "constructor" from meeting the object's own members. */
            function genreRow(name, label) {
                var row = UI.listRow({
                    title: label, value: '', key: UI.keyOf('flt-genre', name || 'any'),
                    onClick: function () {
                        filter.genre = name;
                        saved.save(scope, filter);
                        paintGenre();
                    }
                });
                genreRows['g' + name] = row;
                return row;
            }

            Api.genres({
                parentId: params.parentId,
                includeItemTypes: params.includeItemTypes,
                favorites: favoritesOnly
            }).then(function (genres) {
                U.clear(genreBox);
                var names = [];
                for (var i = 0; i < genres.length; i++) {
                    if (genres[i] && genres[i].Name) names.push(genres[i].Name);
                }
                /* A saved genre the server no longer reports stays listed, or
                   there would be no way to see it or turn it off. */
                if (filter.genre && names.indexOf(filter.genre) === -1) names.unshift(filter.genre);

                if (!names.length) {
                    genreBox.appendChild(UI.empty('No genres are tagged here.'));
                    return;
                }
                genreBox.appendChild(genreRow('', 'Any genre'));
                for (var n = 0; n < names.length; n++) genreBox.appendChild(genreRow(names[n], names[n]));
                paintGenre();
            }).catch(function (err) {
                U.clear(genreBox);
                genreBox.appendChild(UI.empty('Could not load genres: ' + (err.message || 'unknown error')));
            });

            page.appendChild(U.el('div', 'shelf-end'));
            U.focusFirst(container);
        },

        destroy: function () {}
    };
})(window);
