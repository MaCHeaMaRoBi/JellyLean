/* Home: a stage and its shelves. The backdrop, title and overview above the
   shelves always describe the focused card; the shelves slide under a fixed
   line so the focused shelf never moves vertically. */
(function (global) {
    'use strict';

    window.Screens = window.Screens || {};

    var STAGE_DELAY = 140;

    function openItem(item) {
        if (UI.isFolder(item)) App.go('library', { parentId: item.Id, title: item.Name });
        else App.go('detail', { itemId: item.Id, item: item });
    }

    function playResume(item) {
        App.playItem(item, { startTicks: (item.UserData && item.UserData.PlaybackPositionTicks) || 0 });
    }

    /* The stage: one block of text and two buttons, repainted per focused item. */
    function Stage(shell, container) {
        var info = U.el('section', 'stage-info');
        info.setAttribute('aria-live', 'polite');
        shell.screen.insertBefore(info, shell.viewport);

        var featured = null;
        var shown = null;
        var timer = null;
        var playBtn = null;
        var moreBtn = null;
        var actions = null;

        function paint(item, isFeatured) {
            if (!item || shown === item && actions && (actions.style.display !== 'none') === isFeatured) return;
            shown = item;
            U.clear(info);

            shell.backdrop.set(UI.backdropUrl(item, 1920));
            info.appendChild(UI.titleBlock(item, 'stage-title'));

            var extra = item.Type === 'Series' && item.ChildCount
                ? item.ChildCount + (item.ChildCount === 1 ? ' season' : ' seasons') : '';
            var meta = UI.metaLine(item, extra);
            if (meta.firstChild) info.appendChild(meta);

            if (item.Overview) info.appendChild(U.el('p', 'overview', item.Overview));

            var position = item.UserData && item.UserData.PlaybackPositionTicks;
            if (isFeatured && position && item.RunTimeTicks) {
                var line = U.el('div', 'progress-line');
                var track = U.el('div', 'track');
                var fill = document.createElement('i');
                fill.style.width = Math.min(100, Math.max(2, position / item.RunTimeTicks * 100)) + '%';
                track.appendChild(fill);
                line.appendChild(track);
                line.appendChild(U.el('span', '', U.fmtRuntime(item.RunTimeTicks - position) + ' left'));
                info.appendChild(line);
            }

            actions = UI.buttonRow([
                playBtn = UI.button({
                    label: position ? 'Resume' : 'Play', icon: 'play', primary: true,
                    aria: (position ? 'Resume ' : 'Play ') + (item.Name || ''),
                    onClick: function () { playResume(featured); }
                }),
                moreBtn = UI.button({
                    label: 'More Info', icon: 'info', aria: 'More info about ' + (item.Name || ''),
                    onClick: function () { openItem(featured); }
                })
            ]);
            actions.setAttribute('data-stage', '');
            if (!isFeatured) actions.style.display = 'none';
            info.appendChild(actions);
        }

        return {
            setFeatured: function (item) { featured = item; paint(item, true); },
            /* Focus on a card re-lights the stage after a beat, so skimming a
               shelf does not thrash image requests. */
            follow: function (item) {
                if (timer) clearTimeout(timer);
                timer = setTimeout(function () { paint(item, false); }, STAGE_DELAY);
            },
            returnToFeatured: function () {
                if (timer) clearTimeout(timer);
                if (featured) paint(featured, true);
            },
            hasButtons: function () { return !!actions; }
        };
    }

    function renderContent(shell, container) {
        var scroll = shell.scroll;
        U.clear(scroll);
        var loading = UI.spinner();
        scroll.appendChild(loading);

        var stale = U.$('.stage-info', shell.screen);
        if (stale) stale.parentNode.removeChild(stale);
        var stage = Stage(shell, container);
        var lastTarget = null;

        /* Re-rendering (Retry) replaces the handler on the same screen; bound
           to the screen, not #app, so leaving Home removes it. */
        if (shell.focusHandler) shell.screen.removeEventListener('focus', shell.focusHandler, true);
        shell.focusHandler = function (event) {
            var node = event.target;
            if (!node || !node.getAttribute) return;
            if (node.getAttribute('data-focusable') === null) return;
            if (node._item) {
                lastTarget = node;
                stage.follow(node._item);
            } else if (U.closest(node, '[data-stage]')) {
                U.setTranslate(scroll, 0, 0);
                stage.returnToFeatured();
            }
        };
        shell.screen.addEventListener('focus', shell.focusHandler, true);

        Promise.all([
            UI.views(),
            Api.resume(12),
            Api.nextUpList(12).catch(function () { return []; })
        ]).then(function (results) {
            var views = results[0] || [];
            var resume = results[1] || [];
            var nextUp = results[2] || [];
            var videoViews = views.filter(function (view) {
                var type = view.CollectionType;
                return type === 'movies' || type === 'tvshows' || type === 'homevideos' ||
                    type === 'musicvideos' || type === 'music' || !type;
            });

            var loads = videoViews.slice(0, 7).map(function (view) {
                return Api.latest(view.Id, 14).then(function (items) {
                    return { view: view, items: items };
                }).catch(function () { return { view: view, items: [] }; });
            });

            return Promise.all(loads).then(function (sections) {
                U.clear(scroll);
                scroll.appendChild(U.el('h1', 'sr-only', 'Home'));
                scroll.setAttribute('data-align', 'row');
                scroll.setAttribute('data-line', '0');

                var first = resume[0] || nextUp[0] ||
                    (sections[0] && sections[0].items[0]) || null;
                if (first) stage.setFeatured(first);

                function add(node) { if (node) scroll.appendChild(node); }

                add(UI.row('Continue Watching', resume, {
                    landscape: true, keyPrefix: 'resume', onClick: playResume
                }));
                add(UI.row('Next Up', nextUp, {
                    landscape: true, keyPrefix: 'nextup',
                    onClick: function (item) { App.playItem(item, { startTicks: 0 }); }
                }));

                sections.forEach(function (section) {
                    add(UI.row('Latest in ' + section.view.Name, section.items, {
                        keyPrefix: 'latest-' + section.view.Id, showCaption: false, onClick: openItem
                    }));
                });

                /* Libraries that did not fit in the tab bar stay reachable here. */
                if (videoViews.length > 4) {
                    add(UI.row('Libraries', videoViews, {
                        landscape: true, keyPrefix: 'view', onClick: function (view) {
                            App.go('library', { parentId: view.Id, title: view.Name });
                        }
                    }));
                }

                if (!scroll.querySelector('.row')) {
                    scroll.appendChild(UI.empty('No libraries found. Add media to your Jellyfin server first.'));
                }
                scroll.appendChild(U.el('div', 'shelf-spacer'));

                U.lazy.check();
                U.focusFirst(container);
            });
        }).catch(function (err) {
            U.clear(scroll);
            var failure = UI.empty('Could not load your library: ' + (err.message || 'unknown error'));
            failure.setAttribute('role', 'alert');
            scroll.appendChild(failure);
            scroll.appendChild(UI.buttonRow([UI.button({
                label: 'Retry', icon: 'refresh', primary: true,
                onClick: function () { renderContent(shell, container); }
            })], { className: 'pad' }));
            U.focusFirst(container);
        });
    }

    window.Screens.home = {
        openItem: openItem,

        render: function (container) {
            var shell = UI.screenShell({ nav: 'home', backdrop: true, className: 'home' });
            shell.viewport.className += ' shelves';
            container.appendChild(shell.screen);
            UI.startClock();
            renderContent(shell, container);
        },

        destroy: function () {}
    };
})(window);
