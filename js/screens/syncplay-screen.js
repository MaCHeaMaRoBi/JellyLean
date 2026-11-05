/* SyncPlay group management. */
(function (global) {
    'use strict';

    window.Screens = window.Screens || {};

    /* One live instance at a time; destroy() must remove exactly the listeners
       that render() installed. */
    var active = null;

    window.Screens.syncplay = {
        render: function (container) {
            var shell = UI.screenShell({ className: 'deep' });
            container.appendChild(shell.screen);

            var content = U.el('div', '');
            shell.scroll.appendChild(content);

            function head(subtitle) {
                var node = U.el('div', 'page-head');
                var titles = U.el('div', 'grow');
                titles.appendChild(U.el('h1', 'title', 'SyncPlay'));
                titles.appendChild(U.el('div', 'count', subtitle));
                node.appendChild(titles);
                return node;
            }

            function paint(keepFocus) {
                var memo = keepFocus ? U.captureFocus() : null;
                U.clear(content);

                if (SyncPlay.isEnabled()) paintActive();
                else paintGroups();
                content.appendChild(U.el('div', 'shelf-end'));

                /* Group update events repaint the screen. Only move focus when
                   the previously focused control disappeared. */
                if (memo) U.setPendingFocus(memo);
                if (!keepFocus || !document.activeElement || document.activeElement === document.body ||
                        !container.contains(document.activeElement)) {
                    U.focusFirst(container);
                }
            }

            function paintActive() {
                var group = SyncPlay.getGroup() || {};
                var queue = SyncPlay.getQueue();

                content.appendChild(head('This TV is in a group. Anything you start plays for everybody.'));

                var list = U.el('div', 'list');
                content.appendChild(list);
                list.appendChild(U.el('h2', 'section-title', 'Your Group'));

                var participants = group.Participants || [];
                var queued = queue && queue.Playlist ? queue.Playlist.length : 0;
                var row = UI.listRow({
                    title: group.GroupName || 'Group', icon: 'users', key: 'sp-group',
                    desc: participants.length + (participants.length === 1 ? ' participant' : ' participants') +
                        (group.State ? ' · ' + group.State : '') +
                        (queue ? ' · ' + queued + (queued === 1 ? ' item queued' : ' items queued') : '')
                });
                row.appendChild(U.el('span', 'badge-live', 'Connected'));
                row.setAttribute('aria-label', (group.GroupName || 'Group') + ', ' +
                    participants.length + (participants.length === 1 ? ' participant' : ' participants'));
                list.appendChild(row);

                var stats = U.el('div', 'status-line');
                stats.style.margin = '18px 0 8px';
                stats.innerHTML = 'Clock offset: <b>' + Math.round(SyncPlay.getTimeOffset()) + ' ms</b>  ·  ' +
                    'Drift: <b>' + Math.round(SyncPlay.getDrift()) + ' ms</b><br>' +
                    (SyncPlay.isReady() ? 'Time sync locked.' : 'Measuring clock offset…');
                list.appendChild(stats);

                var leave = UI.button({ label: 'Leave Group', icon: 'logout', key: 'sp-leave' });
                leave.onclick = function () {
                    leave.labelNode.textContent = 'Leaving…';
                    SyncPlay.leaveGroup().then(function () { paint(); });
                };
                content.appendChild(UI.buttonRow([
                    UI.button({
                        label: 'Stop for Everyone', icon: 'stop', key: 'sp-stop',
                        onClick: function () { SyncPlay.stop(); U.toast('Asked the group to stop'); }
                    }),
                    leave
                ], { className: 'pad' }));

                content.appendChild(U.el('p', 'note',
                    'Pick any movie or episode to start a shared queue. Everyone follows pause, seek and resume.'));
            }

            function paintGroups() {
                content.appendChild(head('Watch together: create a group or join one from another device.'));

                var create = UI.button({ label: 'Create Group', icon: 'users', primary: true, key: 'sp-create' });
                create.onclick = function () {
                    create.labelNode.textContent = 'Creating…';
                    SyncPlay.createGroup(Store.deviceName() + "’s group").then(function () {
                        paint();
                    }).catch(function (err) {
                        create.labelNode.textContent = 'Create Group';
                        U.toast('Could not create group: ' + (err.message || 'error'));
                    });
                };
                content.appendChild(UI.buttonRow([
                    create,
                    UI.button({ label: 'Refresh', icon: 'refresh', key: 'sp-refresh', onClick: function () { loadGroups(); } })
                ], { className: 'pad' }));

                var list = U.el('div', 'list');
                content.appendChild(list);
                list.appendChild(U.el('h2', 'section-title', 'Open Groups'));

                var listBox = U.el('div', '');
                listBox.id = 'groupList';
                listBox.setAttribute('aria-live', 'polite');
                list.appendChild(listBox);

                loadGroups();

                function loadGroups() {
                    U.clear(listBox);
                    listBox.appendChild(UI.spinner());

                    SyncPlay.listGroups().then(function (groups) {
                        U.clear(listBox);
                        if (!groups.length) {
                            listBox.appendChild(UI.empty('No open groups on this server. Create one, or start one from another Jellyfin app.'));
                            return;
                        }
                        groups.forEach(function (group) {
                            var count = (group.Participants || []).length;
                            var row = UI.listRow({
                                title: group.GroupName || 'Group', icon: 'users', key: 'sp-' + group.GroupId,
                                desc: count + ' participant' + (count === 1 ? '' : 's') +
                                    (group.State ? ' · ' + group.State : ''),
                                value: 'Join'
                            });
                            row.setAttribute('aria-label', (group.GroupName || 'Group') + ', join');
                            row.onclick = function () {
                                row.setValue('Joining…');
                                SyncPlay.joinGroup(group.GroupId).then(function () {
                                    setTimeout(paint, 400);
                                }).catch(function (err) {
                                    row.setValue('Join');
                                    U.toast('Could not join: ' + (err.message || 'error'));
                                });
                            };
                            listBox.appendChild(row);
                        });
                    }).catch(function (err) {
                        U.clear(listBox);
                        listBox.appendChild(UI.empty('Could not list groups: ' + (err.message || 'error')));
                    });
                }
            }

            function onChange() {
                if (active && active.instance === instance) paint(true);
            }

            var instance = {
                onChange: onChange
            };

            if (active) {
                SyncPlay.off('enabled', active.onChange);
                SyncPlay.off('disabled', active.onChange);
                SyncPlay.off('group', active.onChange);
            }

            active = { instance: instance, onChange: onChange };
            SyncPlay.on('enabled', onChange);
            SyncPlay.on('disabled', onChange);
            SyncPlay.on('group', onChange);

            paint();
        },

        destroy: function () {
            if (!active) return;
            SyncPlay.off('enabled', active.onChange);
            SyncPlay.off('disabled', active.onChange);
            SyncPlay.off('group', active.onChange);
            active = null;
        }
    };
})(window);
